// Pre-flight checks before anything is sent to X Layer mainnet (chain 196). Pure: the caller reads the
// chain and the files, so the rules are unit-tested without a network.
const fs = require('node:fs');
const path = require('node:path');

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const lower = value => String(value).toLowerCase();

/**
 * Addresses that belong to testnet and must never hold a mainnet role or pay for a mainnet deployment:
 * every address in the testnet deployment record, and the *_ADDRESS entries of the local testnet key
 * file (addresses only; keys are never read).
 */
function testnetAddresses({ deploymentFile, keyFile } = {}) {
  const found = new Set();
  const add = value => { if (ADDRESS.test(String(value ?? ''))) found.add(lower(value)); };
  if (deploymentFile && fs.existsSync(deploymentFile)) {
    const record = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));
    for (const key of ['admin', 'relayer', 'deployer']) add(record[key]);
  }
  if (keyFile && fs.existsSync(keyFile)) {
    for (const line of fs.readFileSync(keyFile, 'utf8').split('\n')) {
      const match = line.match(/^\s*[A-Z0-9_]+_ADDRESS\s*=\s*(0x[0-9a-fA-F]{40})\s*$/);
      if (match) add(match[1]);
    }
  }
  return found;
}

const defaultTestnetAddresses = root =>
  testnetAddresses({
    deploymentFile: path.join(root, 'deployments/xlayerTestnet-card.json'),
    keyFile: path.join(root, '../.local/testnet-keys.env'),
  });

/**
 * Problems that must stop a mainnet deployment (empty = go):
 * - no testnet address as deployer, admin or relayer;
 * - the admin is a contract (the Safe), unless allowEoaAdmin;
 * - the deployer keeps no role: it is neither admin nor relayer;
 * - token metadata is served over https from a production host.
 */
function mainnetDeployProblems({ deployer, admin, relayer, baseURI, adminCode, testnet = new Set(), allowEoaAdmin = false }) {
  const problems = [];
  for (const [role, address] of Object.entries({ deployer, admin, relayer })) {
    if (!ADDRESS.test(String(address ?? ''))) problems.push(`${role} is not an address`);
    else if (testnet.has(lower(address))) problems.push(`${role} ${address} is a testnet address`);
  }
  if (!allowEoaAdmin && (!adminCode || adminCode === '0x')) problems.push(`admin ${admin} has no code: use the Safe multisig`);
  if (lower(deployer) === lower(admin)) problems.push('deployer must not be the admin');
  if (lower(deployer) === lower(relayer)) problems.push('deployer must not be the relayer');
  if (lower(admin) === lower(relayer)) problems.push('admin and relayer must be different');
  let url = null;
  try {
    url = new URL(baseURI);
  } catch {
    problems.push(`CARD_BASE_URI ${baseURI} is not a URL`);
  }
  if (url && url.protocol !== 'https:') problems.push('CARD_BASE_URI must use https');
  if (url && /(^|[.-])(dev|test|testnet|staging|preview)([.-]|$)|localhost|^127\.|^0\.0\.0\.0/.test(url.hostname))
    problems.push(`CARD_BASE_URI host ${url.hostname} is not a production host`);
  return problems;
}

module.exports = { testnetAddresses, defaultTestnetAddresses, mainnetDeployProblems };
