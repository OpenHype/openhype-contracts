const assert = require('node:assert/strict');
const { ethers } = require('hardhat');
const { inspect, TRANSFER_WITH_AUTHORIZATION_TYPEHASH } = require('../lib/token_authorization.cjs');

// Same error contract as scripts/inspect_token_authorization.cjs, over the in-process chain.
const rpc = async (method, params) => {
  try {
    return await ethers.provider.send(method, params);
  } catch (e) {
    const data = e.data?.data ?? e.data ?? e.error?.data;
    if (/revert/i.test(e.message) || data) {
      const error = new Error(e.message);
      error.executionReverted = true;
      error.data = typeof data === 'string' ? data : undefined;
      throw error;
    }
    throw e;
  }
};

describe('EIP-3009 capability inspection', function () {
  it('accepts a standard 3009 token and reports its signing domain', async function () {
    const token = await (await ethers.getContractFactory('Eip3009TestToken')).deploy('USDC_TEST', '2');
    const result = await inspect(rpc, 31337, await token.getAddress());
    assert.equal(result.status, 'eip3009_simulated', result.reason);
    assert.deepEqual(
      { name: result.domain.name, version: result.domain.version },
      { name: 'USDC_TEST', version: '2' },
    );
    assert.equal(result.simulation.typehash, TRANSFER_WITH_AUTHORIZATION_TYPEHASH);
    assert.notEqual(result.simulation.tamperedRejectedWith, result.simulation.unfundedRejectedWith);
  });

  it('matches the on-chain typehash constant', async function () {
    const token = await (await ethers.getContractFactory('Eip3009TestToken')).deploy('USD₮0', '1');
    assert.equal(await token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), TRANSFER_WITH_AUTHORIZATION_TYPEHASH);
  });

  it('does not trust a contract that silently accepts every call', async function () {
    const silent = await (await ethers.getContractFactory('SilentFallbackToken')).deploy();
    const result = await inspect(rpc, 31337, await silent.getAddress());
    assert.equal(result.status, 'unverified');
  });

  it('rejects the wrong chain before simulating', async function () {
    const token = await (await ethers.getContractFactory('Eip3009TestToken')).deploy('USDG', '1');
    await assert.rejects(inspect(rpc, 1952, await token.getAddress()), /Wrong chain/);
  });
});
