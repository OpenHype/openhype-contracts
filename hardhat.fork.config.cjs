// Forks X Layer (FORK_CHAIN_ID 196 or 1952, FORK_RPC_URL https) into the in-process Hardhat network so
// scripts can run against the real tokens and collection without sending anything.
const base = require('./hardhat.config.cjs');

const url = process.env.FORK_RPC_URL;
const chainId = Number(process.env.FORK_CHAIN_ID);
if (!url || !/^https:\/\//.test(url)) throw new Error('Set FORK_RPC_URL (https)');
if (![196, 1952].includes(chainId)) throw new Error('Set FORK_CHAIN_ID to 196 or 1952');

module.exports = {
  ...base,
  networks: {
    hardhat: {
      ...base.networks.hardhat,
      chainId,
      forking: { url },
      // X Layer executes Cancun opcodes; Hardhat needs the hardfork to replay the forked state.
      hardfork: 'cancun',
      chains: { [chainId]: { hardforkHistory: { cancun: 0 } } },
    },
  },
};
