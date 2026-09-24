const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testnetAddresses, mainnetDeployProblems } = require('../lib/mainnet_guard.cjs');

const a = n => '0x' + String(n).repeat(40).slice(0, 40);
const ok = {
  deployer: a(1),
  admin: a(2),
  relayer: a(3),
  baseURI: 'https://api.openhype.com/v1/nft_metadata/asset/',
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
  it('refuses a dev, testnet, local or plain-http metadata URI', function () {
    for (const baseURI of [
      'https://api-dev.openhype.com/v1/nft_metadata/asset/',
      'https://dev.openhype.com/asset/',
      'https://api.testnet.example.com/asset/',
      'https://localhost/asset/',
      'http://api.openhype.com/asset/',
      'not a url',
    ]) {
      assert.ok(mainnetDeployProblems({ ...ok, baseURI }).length > 0, baseURI);
    }
  });
  it('collects testnet addresses from the deployment record and the key file, never the keys', function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
    const deploymentFile = path.join(dir, 'd.json');
    const keyFile = path.join(dir, 'k.env');
    fs.writeFileSync(deploymentFile, JSON.stringify({ admin: a(4), relayer: a(5) }));
    fs.writeFileSync(keyFile, `CHAIN_RELAYER_ADDRESS=${a(6)}\nCHAIN_RELAYER_PRIVATE_KEY=0x${'ab'.repeat(32)}\n`);
    const found = testnetAddresses({ deploymentFile, keyFile });
    assert.deepEqual([...found].sort(), [a(4), a(5), a(6)]);
    fs.rmSync(dir, { recursive: true });
  });
});
