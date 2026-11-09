// Hands DEFAULT_ADMIN_ROLE of the collection and the exchange (deployments/<network>-card.json and
// <network>-exchange.json) from the current admin account to a Safe multisig, in steps that can each be re-run:
//
//   plan      (default) reads the Safe and both contracts and prints the state; sends nothing.
//   grant     the Safe gets DEFAULT_ADMIN_ROLE on both contracts, PAUSER_ROLE where the contract has it, and
//             becomes the collection's owner(). Prints two admin-only calls that change nothing, for the Safe to
//             execute as a test.
//   renounce  SAFE_TEST_TXS=<collection tx>,<exchange tx>: the Safe's two test transactions are checked on chain,
//             then the old admin renounces DEFAULT_ADMIN_ROLE on both contracts and the deployment records name the
//             Safe as admin. Not reversible.
//   proceeds  the exchange sends purchase proceeds to the Safe: sent by the signer while it is still the admin,
//             printed as a Safe transaction afterwards. Whatever checks the proceeds recipient off chain must
//             expect the Safe first.
//
//   ADMIN_SAFE_ADDRESS=<safe> [ADMIN_STEP=grant|renounce|proceeds] [MIN_SAFE_THRESHOLD=2]
//
// The signer is the current admin (the deployer key of the network's config). Mainnet (network xlayer) needs
// CONFIRM_MAINNET=yes for every step that sends; the Safe must pass lib/mainnet_guard.cjs safeAdminProblems.
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');
const { defaultTestnetAddresses, safeAdminProblems } = require('../lib/mainnet_guard.cjs');

const NETWORKS = { 196n: 'xlayer', 1952n: 'xlayerTestnet' };
const MAINNET = 196n;
const ADMIN = ethers.ZeroHash;
const STEPS = ['plan', 'grant', 'renounce', 'proceeds'];
const SAFE_ABI = [
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function VERSION() view returns (string)',
];

/** Runs one step. `dir` holds the deployment records; `confirmed` stands for CONFIRM_MAINNET=yes. */
async function transferAdmin({ step = 'plan', safe, signer, dir, chainId, confirmed = false, minThreshold = 2, safeTestTxs = [], log = console.log }) {
  if (!STEPS.includes(step)) throw new Error(`ADMIN_STEP must be one of ${STEPS.join(', ')}`);
  const name = NETWORKS[chainId];
  if (!name) throw new Error(`Unsupported chain ${chainId}`);
  safe = ethers.getAddress(safe);
  const files = { card: path.join(dir, `${name}-card.json`), exchange: path.join(dir, `${name}-exchange.json`) };
  const reports = { card: read(files.card), exchange: read(files.exchange) };
  const contracts = {
    card: await ethers.getContractAt('OpenHypeCollectible', reports.card.proxy, signer),
    exchange: await ethers.getContractAt('OpenHypeExchange', reports.exchange.proxy, signer),
  };
  const { card, exchange } = contracts;
  const provider = signer.provider;

  const safeContract = new ethers.Contract(safe, SAFE_ABI, provider);
  const owners = await safeContract.getOwners().then(o => [...o], () => undefined);
  const threshold = await safeContract.getThreshold().catch(() => undefined);
  const problems = safeAdminProblems({
    safe,
    code: await provider.getCode(safe),
    owners,
    threshold,
    minThreshold,
    roleKeys: { operator: reports.exchange.operator, relayer: reports.card.relayer, taker: reports.exchange.taker },
    testnet: chainId === MAINNET ? defaultTestnetAddresses(path.resolve(__dirname, '..')) : new Set(),
  });

  const state = async () => {
    const out = {};
    for (const [key, c] of Object.entries(contracts)) {
      const pauserRole = await c.PAUSER_ROLE().catch(() => null); // null before the upgrade that adds it
      out[key] = {
        proxy: await c.getAddress(),
        signerIsAdmin: await c.hasRole(ADMIN, signer.address),
        safeIsAdmin: await c.hasRole(ADMIN, safe),
        pauserRole,
        safeIsPauser: pauserRole ? await c.hasRole(pauserRole, safe) : null,
      };
    }
    out.card.owner = await card.owner();
    out.exchange.proceedsRecipient = await exchange.proceedsRecipient();
    return out;
  };
  const before = await state();
  log(JSON.stringify({
    network: name,
    step,
    signer: signer.address,
    safe: { address: safe, version: await safeContract.VERSION().catch(() => null), threshold: threshold?.toString(), owners },
    state: before,
    problems,
  }, null, 2));
  if (problems.length) throw new Error(`Refusing the Safe:\n- ${problems.join('\n- ')}`);
  if (step === 'plan') return { state: before };

  const send = async (label, c, fn, args) => {
    if (chainId === MAINNET && !confirmed) throw new Error(`Re-run with CONFIRM_MAINNET=yes to send ${label}.`);
    const tx = await c[fn](...args);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`${label} failed: ${tx.hash}`);
    log(JSON.stringify({ sent: label, hash: tx.hash }));
    return tx.hash;
  };
  const requireSignerAdmin = () => {
    for (const [key, s] of Object.entries(before))
      if (!s.signerIsAdmin) throw new Error(`The signer ${signer.address} is not the admin of the ${key} ${s.proxy}`);
  };
  const now = () => new Date().toISOString();

  if (step === 'grant') {
    requireSignerAdmin();
    const txs = [];
    for (const [key, c] of Object.entries(contracts)) {
      if (!before[key].safeIsAdmin) txs.push(await send(`${key}: grantRole(DEFAULT_ADMIN_ROLE, Safe)`, c, 'grantRole', [ADMIN, safe]));
      if (before[key].pauserRole && !before[key].safeIsPauser)
        txs.push(await send(`${key}: grantRole(PAUSER_ROLE, Safe)`, c, 'grantRole', [before[key].pauserRole, safe]));
    }
    if (before.card.owner !== safe) txs.push(await send('card: setOwner(Safe)', card, 'setOwner', [safe]));
    await waitFor(async () => {
      const s = await state();
      return s.card.safeIsAdmin && s.exchange.safeIsAdmin && s.card.owner === safe;
    }, 'the Safe to hold DEFAULT_ADMIN_ROLE on both contracts');
    for (const key of Object.keys(reports)) {
      reports[key].adminMigration = { ...reports[key].adminMigration, safe, granted: now(), grantTxs: txs };
      save(files[key], reports[key]);
    }
    const tests = await safeTests(contracts);
    log(JSON.stringify({
      next: 'Execute both transactions from the Safe (they change nothing; only the admin may call them), then run '
        + 'ADMIN_STEP=renounce SAFE_TEST_TXS=<collection tx hash>,<exchange tx hash>.',
      safeTransactions: tests.map(t => ({ to: t.to, value: '0', data: t.data, call: t.call })),
    }, null, 2));
    return { txs, tests };
  }

  if (step === 'renounce') {
    const s = await state();
    for (const [key, v] of Object.entries(s)) if (!v.safeIsAdmin) throw new Error(`The Safe is not the admin of the ${key} yet: run ADMIN_STEP=grant`);
    await checkSafeTests(provider, contracts, safe, safeTestTxs);
    const txs = [];
    for (const [key, c] of Object.entries(contracts))
      if (s[key].signerIsAdmin) txs.push(await send(`${key}: renounceRole(DEFAULT_ADMIN_ROLE, ${signer.address})`, c, 'renounceRole', [ADMIN, signer.address]));
    await waitFor(async () => {
      const after = await state();
      return !after.card.signerIsAdmin && !after.exchange.signerIsAdmin;
    }, 'the old admin to lose DEFAULT_ADMIN_ROLE on both contracts');
    for (const key of Object.keys(reports)) {
      const report = reports[key];
      report.adminHistory = [...(report.adminHistory || []), { at: now(), from: report.admin, to: safe, safeTestTxs, renounceTxs: txs }];
      report.admin = safe;
      delete report.adminMigration;
      save(files[key], report);
    }
    return { txs };
  }

  // proceeds
  if (before.exchange.proceedsRecipient === safe) {
    log(JSON.stringify({ proceedsRecipient: safe, unchanged: true }));
    return {};
  }
  if (!before.exchange.signerIsAdmin) {
    const data = exchange.interface.encodeFunctionData('setProceedsRecipient', [safe]);
    log(JSON.stringify({ next: 'Execute from the Safe.', safeTransaction: { to: before.exchange.proxy, value: '0', data } }, null, 2));
    return { safeTransaction: { to: before.exchange.proxy, data } };
  }
  const tx = await send('exchange: setProceedsRecipient(Safe)', exchange, 'setProceedsRecipient', [safe]);
  await waitFor(async () => (await exchange.proceedsRecipient()) === safe, 'the new proceeds recipient');
  reports.exchange.proceedsRecipient = safe;
  reports.exchange.proceedsHistory = [...(reports.exchange.proceedsHistory || []), { at: now(), from: before.exchange.proceedsRecipient, to: safe, tx }];
  save(files.exchange, reports.exchange);
  return { txs: [tx] };
}

/** Admin-only calls that set what is already set: proof that the Safe can act as the admin. */
async function safeTests({ card, exchange }) {
  const uri = await card.contractURI();
  const required = await exchange.askSignatureRequired();
  return [
    { to: await card.getAddress(), data: card.interface.encodeFunctionData('setContractURI', [uri]), call: `setContractURI(${JSON.stringify(uri)})`, event: 'ContractURIUpdated', contract: card },
    { to: await exchange.getAddress(), data: exchange.interface.encodeFunctionData('setAskSignatureRequired', [required]), call: `setAskSignatureRequired(${required})`, event: 'AskSignatureRequiredUpdated', contract: exchange },
  ];
}

/** Each test transaction succeeded, was sent to the Safe, and made its contract emit the expected event. */
async function checkSafeTests(provider, contracts, safe, hashes) {
  const tests = await safeTests(contracts);
  if (hashes.length !== tests.length)
    throw new Error('Set SAFE_TEST_TXS=<collection tx hash>,<exchange tx hash>: the Safe must first prove it can act as the admin');
  for (const [i, test] of tests.entries()) {
    const [tx, receipt] = await Promise.all([provider.getTransaction(hashes[i]), provider.getTransactionReceipt(hashes[i])]);
    if (!tx || !receipt || receipt.status !== 1) throw new Error(`Safe test ${hashes[i]} is not a successful transaction`);
    if (ethers.getAddress(tx.to) !== safe) throw new Error(`Safe test ${hashes[i]} was not sent to the Safe`);
    const emitted = receipt.logs.some(l => l.address.toLowerCase() === test.to.toLowerCase() && test.contract.interface.parseLog(l)?.name === test.event);
    if (!emitted) throw new Error(`Safe test ${hashes[i]} did not run ${test.call} on ${test.to}`);
  }
}

// Public X Layer RPC nodes lag each other: wait until reads see a change.
async function waitFor(check, what) {
  for (let i = 0; i < 30; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(file, report) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (NETWORKS[chainId] !== network.name) throw new Error(`Unsupported network ${network.name}`);
  const safe = process.env.ADMIN_SAFE_ADDRESS;
  if (!safe) throw new Error('Set ADMIN_SAFE_ADDRESS');
  const [signer] = await ethers.getSigners();
  await transferAdmin({
    step: process.env.ADMIN_STEP || 'plan',
    safe,
    signer,
    dir: path.resolve(__dirname, '../deployments'),
    chainId,
    confirmed: process.env.CONFIRM_MAINNET === 'yes',
    minThreshold: Number(process.env.MIN_SAFE_THRESHOLD || 2),
    safeTestTxs: (process.env.SAFE_TEST_TXS || '').split(',').map(s => s.trim()).filter(Boolean),
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { transferAdmin };
