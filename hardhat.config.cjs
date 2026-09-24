require('@nomicfoundation/hardhat-ethers');
require('@openzeppelin/hardhat-upgrades');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

// Use the lockfile-pinned compiler; compilation never downloads a compiler.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }) => {
  if (solcVersion !== '0.8.30') throw new Error('Unexpected Solidity version');
  return {
    compilerPath: require.resolve('solc/soljson.js'),
    isSolcJs: true,
    version: solcVersion,
    longVersion: require('solc').version(),
  };
});

module.exports = {
  solidity: {
    version: '0.8.30',
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' },
  },
  paths: { sources: './src', tests: './test' },
  defaultNetwork: 'hardhat',
  // No remote RPC or private keys. Tests use an in-process ephemeral chain.
  networks: { hardhat: { chainId: 31337, hardfork: 'shanghai' } },
};
