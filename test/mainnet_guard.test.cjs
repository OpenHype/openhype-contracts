const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testnetAddresses, mainnetDeployProblems, exchangeMainnetProblems } = require('../lib/mainnet_guard.cjs');

const a = n => '0x' + String(n).repeat(40).slice(0, 40);
const ok = {
  deployer: a(1),
  admin: a(2),
  relayer: a(3),
  baseURI: 'https://metadata.example.com/asset/',
  contractURI: 'https://metadata.example.com/contract',
  adminCode: '0x6080',
  testnet: new Set([a(9)]),
};

describe('mainnet deployment guard', function () {
  it('passes a Safe admin, fresh keys and a production metadata host', function () {
    assert.deepEqual(mainnetDeployProblems(ok), []);
  });
  it('refuses any testnet address in any role', function () {
    for (const role of ['deployer', 'admin', 'relayer']) {
      const problems = mainnetDeployProblems({ ...ok, [role]: a(9).toUpperCase().replace('0X', '0x') });
      assert.ok(problems.some(p => p.includes(`${role} `) && p.includes('testnet')), problems.join('; '));
    }
  });
  it('requires the admin to be a contract unless explicitly allowed', function () {
    assert.ok(mainnetDeployProblems({ ...ok, adminCode: '0x' }).some(p => p.includes('Safe')));
    assert.deepEqual(mainnetDeployProblems({ ...ok, adminCode: '0x', allowEoaAdmin: true }), []);
  });
  it('keeps the deployer out of every role', function () {
    assert.ok(mainnetDeployProblems({ ...ok, admin: ok.deployer }).includes('deployer must not be the admin'));
    assert.ok(mainnetDeployProblems({ ...ok, relayer: ok.deployer }).includes('deployer must not be the relayer'));
  });
  it('lets the deployer be an EOA admin only when both are explicitly allowed, never the relayer', function () {
    const eoaDeployerAdmin = { ...ok, admin: ok.deployer, adminCode: '0x' };
    assert.ok(mainnetDeployProblems({ ...eoaDeployerAdmin, allowEoaAdmin: true }).includes('deployer must not be the admin'));
    assert.deepEqual(mainnetDeployProblems({ ...eoaDeployerAdmin, allowEoaAdmin: true, allowDeployerAdmin: true }), []);
    assert.ok(
      mainnetDeployProblems({ ...ok, relayer: ok.deployer, allowDeployerAdmin: true }).includes('deployer must not be the relayer'),
    );
  });
  it('refuses a dev, testnet, local or plain-http metadata URI', function () {
    for (const baseURI of [
      'https://api-dev.example.com/asset/',
      'https://dev.example.com/asset/',
      'https://api.testnet.example.com/asset/',
      'https://localhost/asset/',
      'http://metadata.example.com/asset/',
      'not a url',
    ]) {
      assert.ok(mainnetDeployProblems({ ...ok, baseURI }).length > 0, baseURI);
      const contractURI = baseURI.replace('/asset/', '/contract');
      assert.ok(mainnetDeployProblems({ ...ok, contractURI }).some(p => p.includes('CARD_CONTRACT_URI')), contractURI);
    }
    assert.ok(mainnetDeployProblems({ ...ok, contractURI: undefined }).some(p => p.includes('CARD_CONTRACT_URI')));
  });
  it('collects testnet addresses from the deployment record and the key file, never the keys', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
    const deploymentFile = path.join(dir, 'd.json');
    const keyFile = path.join(dir, 'k.env');
    fs.writeFileSync(deploymentFile, JSON.stringify({ admin: a(4), relayer: a(5) }));
    fs.writeFileSync(keyFile, `RELAYER_ADDRESS=${a(6)}\nRELAYER_PRIVATE_KEY=0x${'ab'.repeat(32)}\n`);
    const found = testnetAddresses({ deploymentFile, keyFile });
    assert.deepEqual([...found].sort(), [a(4), a(5), a(6)]);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('mainnet exchange deployment guard', function () {
  const exchange = {
    deployer: a(1), admin: a(2), operator: a(3), taker: a(4), inventory: a(5), proceedsRecipient: a(4),
    adminCode: '0x6080', testnet: new Set([a(9)]),
  };
  it('passes a Safe admin and distinct mainnet keys', function () {
    assert.deepEqual(exchangeMainnetProblems(exchange), []);
  });
  it('refuses testnet addresses in any role', function () {
    for (const role of ['deployer', 'admin', 'operator', 'taker', 'inventory', 'proceedsRecipient']) {
      const problems = exchangeMainnetProblems({ ...exchange, [role]: a(9) });
      assert.ok(problems.some(p => p.startsWith(`${role} `) && p.includes('testnet')), problems.join('; '));
    }
  });
  it('requires a contract admin and keeps keys apart', function () {
    assert.ok(exchangeMainnetProblems({ ...exchange, adminCode: '0x' }).some(p => p.includes('Safe')));
    assert.deepEqual(exchangeMainnetProblems({ ...exchange, adminCode: '0x', allowEoaAdmin: true }), []);
    assert.ok(exchangeMainnetProblems({ ...exchange, deployer: a(2) }).some(p => p.includes('deployer must not be the admin')));
    assert.deepEqual(exchangeMainnetProblems({ ...exchange, deployer: a(2), allowDeployerAdmin: true }), []);
    assert.ok(exchangeMainnetProblems({ ...exchange, deployer: a(3) }).some(p => p.includes('deployer must not be the operator')));
    assert.ok(exchangeMainnetProblems({ ...exchange, taker: a(3) }).some(p => p.includes('operator and taker')));
    assert.ok(exchangeMainnetProblems({ ...exchange, operator: a(2) }).some(p => p.includes('admin must not be')));
  });
});
