const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const base = require('./hardhat.config.cjs');
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key || !/^(0x)?[a-fA-F0-9]{64}$/.test(key)) throw new Error('Set a valid DEPLOYER_PRIVATE_KEY in .env (see .env.example)');
module.exports = {
  ...base,
  networks: { ...base.networks, xlayerTestnet: {
    url: process.env.XLAYER_TESTNET_RPC_URL || 'https://testrpc.xlayer.tech/terigon',
    chainId: 1952,
    accounts: [key.startsWith('0x') ? key : `0x${key}`],
    timeout: 120000,
  } },
};
