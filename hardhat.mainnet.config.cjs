// X Layer mainnet (chain 196). Separate from the testnet config on purpose: its own deployer variable,
// no default RPC, and it refuses the testnet deployer key.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const base = require('./hardhat.config.cjs');

const normalize = key => (key.startsWith('0x') ? key : `0x${key}`).toLowerCase();
const key = process.env.MAINNET_DEPLOYER_PRIVATE_KEY;
if (!key || !/^(0x)?[a-fA-F0-9]{64}$/.test(key)) throw new Error('Set a valid MAINNET_DEPLOYER_PRIVATE_KEY in .env');
const testnetKey = process.env.DEPLOYER_PRIVATE_KEY;
if (testnetKey && /^(0x)?[a-fA-F0-9]{64}$/.test(testnetKey) && normalize(testnetKey) === normalize(key))
  throw new Error('MAINNET_DEPLOYER_PRIVATE_KEY is the testnet deployer key: use a fresh mainnet key');
const url = process.env.XLAYER_MAINNET_RPC_URL;
if (!url || !/^https:\/\//.test(url)) throw new Error('Set XLAYER_MAINNET_RPC_URL (https; a paid endpoint is recommended)');

module.exports = {
  ...base,
  networks: { ...base.networks, xlayer: {
    url,
    chainId: 196,
    accounts: [normalize(key)],
    timeout: 120000,
  } },
};
