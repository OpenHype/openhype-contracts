// Runs OpenHypeExchange against the real stablecoin and collection on a local fork of X Layer and
// reports gas. Nothing is sent to the network.
//   FORK_CHAIN_ID=1952 FORK_RPC_URL=https://testrpc.xlayer.tech/terigon npm run fork-check:exchange
//   FORK_CHAIN_ID=196 FORK_RPC_URL=https://rpc.xlayer.tech npm run fork-check:exchange
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ethers, network } = require('hardhat');

// USD₮0 on X Layer and the testnet faucet USD₮0; the holders fund the fork's test accounts.
const NETWORKS = {
  196: { record: 'xlayer-card.json', currency: '0x779ded0c9e1022225f8e0630b35a9b54be713736', holder: '0xd04dC09707Cb35bB85DC672A60482f9220CF8b3c' },
  1952: { record: 'xlayerTestnet-card.json', currency: '0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c', holder: '0x3E7B1778eAabe71100C7e584a10bE4ae9a8e24Df' },
};
const RECEIVE_TYPES = {
  ReceiveWithAuthorization: ['from:address', 'to:address', 'value:uint256', 'validAfter:uint256', 'validBefore:uint256', 'nonce:bytes32']
    .map(f => ({ name: f.split(':')[0], type: f.split(':')[1] })),
};
const ASK_TYPES = {
  Ask: ['askId:bytes32', 'seller:address', 'tokenIds:uint256[]', 'prices:uint256[]', 'currency:address', 'price:uint256', 'validBefore:uint256']
    .map(f => ({ name: f.split(':')[0], type: f.split(':')[1] })),
};
const TOKEN_ABI = [
  'function name() view returns (string)', 'function version() view returns (string)', 'function decimals() view returns (uint8)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)',
  'function authorizationState(address,bytes32) view returns (bool)',
];

async function impersonate(address) {
  await network.provider.send('hardhat_impersonateAccount', [address]);
  await network.provider.send('hardhat_setBalance', [address, '0x56BC75E2D63100000']);
  return ethers.getSigner(address);
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const cfg = NETWORKS[chainId];
  if (network.name !== 'hardhat' || !cfg) throw new Error('Run with hardhat.fork.config.cjs');
  const record = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../deployments', cfg.record), 'utf8'));
  const [admin, operator, buyer, inventory] = await ethers.getSigners();
  const token = new ethers.Contract(cfg.currency, TOKEN_ABI, ethers.provider);
  const unit = 10n ** BigInt(await token.decimals());
  const name = await token.name();
  const separator = await token.DOMAIN_SEPARATOR();
  const versions = [await token.version().catch(() => null), '1', '2'].filter(Boolean);
  const domain = versions.map(version => ({ name, version, chainId, verifyingContract: cfg.currency }))
    .find(d => ethers.TypedDataEncoder.hashDomain(d) === separator);
  assert.ok(domain, 'token EIP-712 domain');

  const taker = await impersonate(cfg.holder);
  const card = await ethers.getContractAt('OpenHypeCollectible', record.proxy);
  const cardAdmin = await impersonate(record.admin);
  // Implementation and ERC1967 proxy deployed directly: the upgrades plugin would consult the real network's
  // manifest, whose newest entries a lagging fork may not have yet.
  const Exchange = await ethers.getContractFactory('OpenHypeExchange');
  const implementation = await Exchange.deploy();
  const init = Exchange.interface.encodeFunctionData('initialize', [admin.address, operator.address, taker.address, {
    collection: record.proxy, inventory: inventory.address, proceedsRecipient: taker.address,
    currencies: [cfg.currency], takerMaxPerFill: [1000n * unit], takerMaxPerWindow: [1500n * unit], takerWindow: 3600n,
  }]);
  const proxy = await (await ethers.getContractFactory('ERC1967Proxy')).deploy(await implementation.getAddress(), init);
  const exchangeAddress = await proxy.getAddress();
  const exchange = Exchange.attach(exchangeAddress);
  await card.connect(cardAdmin).grantRole(await card.MINTER_ROLE(), exchangeAddress);
  await card.connect(cardAdmin).grantRole(await card.OPERATOR_ROLE(), exchangeAddress);
  await token.connect(taker).transfer(buyer.address, 4n * unit);
  await token.connect(taker).approve(exchangeAddress, 1000n * unit);
  const gas = {};
  const run = async (label, tx) => {
    const receipt = await (await tx).wait();
    gas[label] = Number(receipt.gasUsed);
    return receipt;
  };
  const share = (total, n) => Array.from({ length: n }, (_, i) => (i === n - 1 ? total - (total / BigInt(n)) * BigInt(n - 1) : total / BigInt(n)));
  const freshIds = n => Array.from({ length: n }, () => BigInt(ethers.hexlify(ethers.randomBytes(16))));

  // Purchases: the buyer's signed authorization is settled with the tokens in one transaction; nothing
  // stays in the exchange.
  const now = BigInt((await ethers.provider.getBlock('latest')).timestamp);
  const purchase = async (label, tokenIds, price) => {
    const orderId = ethers.hexlify(ethers.randomBytes(32));
    const message = { from: buyer.address, to: exchangeAddress, value: price, validAfter: 0n, validBefore: now + 600n, nonce: orderId };
    const signature = await buyer.signTypedData(domain, RECEIVE_TYPES, message);
    await run(label, exchange.connect(operator).buyWithAuthorization(
      { orderId, buyer: buyer.address, tokenIds, prices: share(price, tokenIds.length), currency: cfg.currency, price, validAfter: 0n, validBefore: message.validBefore }, signature));
    assert.equal(await token.authorizationState(buyer.address, orderId), true);
    assert.equal(await token.balanceOf(exchangeAddress), 0n);
  };
  const [one, ...more] = freshIds(51);
  await purchase('buy(1 mint)', [one], unit / 2n);
  await card.connect(cardAdmin).grantRole(await card.MINTER_ROLE(), admin.address);
  const stock = more.slice(0, 10);
  await card.connect(admin).mintBatch(inventory.address, stock);
  await purchase('buy(10 transfers)', stock, unit);
  assert.equal(await card.ownerOf(one), buyer.address);
  assert.equal(await card.ownerOf(stock[9]), buyer.address);
  await purchase('buy(50 mints)', freshIds(50), unit);
  await purchase('buy(payment only)', [], unit / 4n);

  // Asks: the taker pays the seller and the tokens return to the inventory.
  const before = await token.balanceOf(buyer.address);
  const validBefore = now + 600n;
  await run('fillAsk(1, unsigned)', exchange.connect(taker).fillAsk(
    { askId: ethers.hexlify(ethers.randomBytes(32)), seller: buyer.address, tokenIds: [one], prices: [unit / 2n], currency: cfg.currency, price: unit / 2n, validBefore }, '0x'));
  const ask = { askId: ethers.hexlify(ethers.randomBytes(32)), seller: buyer.address, tokenIds: stock, prices: share(unit / 2n, stock.length), currency: cfg.currency, price: unit / 2n, validBefore };
  const exchangeDomain = { name: 'OpenHype Exchange', version: '1', chainId, verifyingContract: exchangeAddress };
  await run('fillAsk(10, signed)', exchange.connect(taker).fillAsk(ask, await buyer.signTypedData(exchangeDomain, ASK_TYPES, ask)));
  assert.equal(await card.ownerOf(one), inventory.address);
  assert.equal(await token.balanceOf(buyer.address), before + unit);

  console.log(JSON.stringify({ chainId, currency: cfg.currency, domain: { name: domain.name, version: domain.version }, collection: record.proxy, gas }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
