const assert = require('node:assert/strict');
const { ethers, upgrades } = require('hardhat');

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
const ASK_TYPES = {
  Ask: [
    { name: 'askId', type: 'bytes32' },
    { name: 'seller', type: 'address' },
    { name: 'tokenIds', type: 'uint256[]' },
    { name: 'prices', type: 'uint256[]' },
    { name: 'currency', type: 'address' },
    { name: 'price', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
  ],
};
const USD = n => ethers.parseUnits(String(n), 6);
/** `total` split over `n` tokens: equal shares, the last one the remainder. */
const split = (total, n) => Array.from({ length: n }, (_, i) => (i === n - 1 ? total - (total / BigInt(n)) * BigInt(n - 1) : total / BigInt(n)));
const id = label => ethers.id(label);

async function rejects(promise, contract, name) {
  try {
    const tx = await promise;
    if (tx?.wait) await tx.wait();
  } catch (err) {
    const parsed = contract.interface.parseError(err.data);
    assert.equal(parsed?.name, name, err.message);
    return parsed;
  }
  assert.fail(`Expected ${name}`);
}

async function revertsWith(promise, text) {
  await assert.rejects(async () => {
    const tx = await promise;
    if (tx?.wait) await tx.wait();
  }, err => err.message.includes(text));
}

async function now() {
  return BigInt((await ethers.provider.getBlock('latest')).timestamp);
}

async function increaseTime(seconds) {
  await ethers.provider.send('evm_increaseTime', [Number(seconds)]);
  await ethers.provider.send('evm_mine', []);
}

async function deploy() {
  const [admin, relayer, operator, taker, buyer, seller, inventory, outsider] = await ethers.getSigners();
  const Card = await ethers.getContractFactory('OpenHypeCollectible');
  const card = await upgrades.deployProxy(
    Card,
    [admin.address, relayer.address, 'https://meta.example/cards/', 'https://meta.example/contract'],
    { kind: 'uups' },
  );
  const token = await (await ethers.getContractFactory('Eip3009TestToken')).deploy('Test USD', '2');
  const other = await (await ethers.getContractFactory('Eip3009TestToken')).deploy('Other USD', '1');
  const Exchange = await ethers.getContractFactory('OpenHypeExchange');
  const exchange = await upgrades.deployProxy(
    Exchange,
    [
      admin.address,
      operator.address,
      taker.address,
      {
        collection: await card.getAddress(),
        inventory: inventory.address,
        proceedsRecipient: taker.address,
        currencies: [await token.getAddress()],
        takerMaxPerFill: [USD(1000)],
        takerMaxPerWindow: [USD(1500)],
        takerWindow: 3600n,
      },
    ],
    { kind: 'uups' },
  );
  const exchangeAddress = await exchange.getAddress();
  await card.grantRole(await card.MINTER_ROLE(), exchangeAddress);
  await card.grantRole(await card.OPERATOR_ROLE(), exchangeAddress);
  await token.mint(buyer.address, USD(10000));
  await token.mint(taker.address, USD(10000));
  await token.connect(taker).approve(exchangeAddress, ethers.MaxUint256);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const tokenDomain = { name: 'Test USD', version: '2', chainId, verifyingContract: await token.getAddress() };
  const exchangeDomain = { name: 'OpenHype Exchange', version: '1', chainId, verifyingContract: exchangeAddress };
  return {
    admin, relayer, operator, taker, buyer, seller, inventory, outsider,
    card, token, other, exchange, exchangeAddress, tokenDomain, exchangeDomain,
    asOperator: exchange.connect(operator),
    asTaker: exchange.connect(taker),
    asRelayer: card.connect(relayer),
  };
}

/** A buyer's receiveWithAuthorization to the exchange, with the order id as nonce. */
async function authorize(f, { from = f.buyer, to = f.exchangeAddress, value, nonce, validAfter = 0n, validBefore, domain = f.tokenDomain }) {
  validBefore ??= (await now()) + 3600n;
  const signature = await from.signTypedData(domain, RECEIVE_TYPES, { from: from.address, to, value, validAfter, validBefore, nonce });
  return { validAfter, validBefore, signature };
}

/** Signs a purchase as the buyer and returns it with the signature (the authorization nonce is the order id). */
async function signedPurchase(f, { orderId = id('order-1'), price = USD(30), tokenIds = [1n, 2n, 3n], prices, currency, ...opts } = {}) {
  const auth = await authorize(f, { value: price, nonce: orderId, ...opts });
  const purchase = {
    orderId,
    buyer: (opts.from ?? f.buyer).address,
    tokenIds,
    prices: prices ?? split(price, tokenIds.length),
    currency: currency ?? (await f.token.getAddress()),
    price,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
  };
  return { purchase, signature: auth.signature };
}

async function buy(f, opts = {}) {
  const { purchase, signature } = await signedPurchase(f, opts);
  return f.asOperator.buyWithAuthorization(purchase, signature);
}

async function ask(f, overrides = {}) {
  const base = {
    askId: id('ask-1'),
    seller: f.seller.address,
    tokenIds: [11n],
    currency: await f.token.getAddress(),
    price: USD(20),
    validBefore: (await now()) + 3600n,
    ...overrides,
  };
  return { ...base, prices: overrides.prices ?? split(base.price, base.tokenIds.length) };
}

function events(receipt, contract, name) {
  return receipt.logs
    .filter(l => l.address.toLowerCase() === contract.target.toLowerCase())
    .map(l => contract.interface.parseLog(l))
    .filter(l => l?.name === name);
}

describe('OpenHypeExchange', function () {
  let f;
  beforeEach(async function () {
    f = await deploy();
  });

  describe('setup', function () {
    it('initializes roles and configuration', async function () {
      const { exchange, card, admin, operator, taker, inventory, token } = f;
      assert.equal(await exchange.hasRole(await exchange.DEFAULT_ADMIN_ROLE(), admin.address), true);
      assert.equal(await exchange.hasRole(await exchange.OPERATOR_ROLE(), operator.address), true);
      assert.equal(await exchange.hasRole(await exchange.TAKER_ROLE(), taker.address), true);
      assert.equal(await exchange.hasRole(await exchange.TAKER_ROLE(), operator.address), false);
      assert.equal(await exchange.collection(), await card.getAddress());
      assert.equal(await exchange.inventory(), inventory.address);
      assert.equal(await exchange.proceedsRecipient(), taker.address);
      assert.equal(await exchange.isCurrencyAllowed(await token.getAddress()), true);
      assert.equal(await exchange.askSignatureRequired(), false);
      const limit = await exchange.takerLimit(await token.getAddress());
      assert.equal(limit.maxPerFill, USD(1000));
      assert.equal(limit.maxPerWindow, USD(1500));
      assert.equal(await exchange.DOMAIN_SEPARATOR(), ethers.TypedDataEncoder.hashDomain(f.exchangeDomain));
    });

    it('cannot be initialized twice or with missing addresses', async function () {
      const { exchange, admin, operator, taker } = f;
      const config = {
        collection: ethers.ZeroAddress, inventory: admin.address, proceedsRecipient: admin.address,
        currencies: [], takerMaxPerFill: [], takerMaxPerWindow: [], takerWindow: 0n,
      };
      await rejects(exchange.initialize(admin.address, operator.address, taker.address, config), exchange, 'InvalidInitialization');
      const Exchange = await ethers.getContractFactory('OpenHypeExchange');
      await assert.rejects(upgrades.deployProxy(Exchange, [admin.address, operator.address, taker.address, config], { kind: 'uups' }));
    });
  });

  describe('purchases', function () {
    it('takes the payment and delivers inventory and minted tokens in one transaction', async function () {
      const { exchange, card, token, asRelayer, buyer, inventory, taker } = f;
      await asRelayer.mintBatch(inventory.address, [1n, 2n]);
      const before = await token.balanceOf(taker.address);
      const receipt = await (await buy(f)).wait();
      for (const tokenId of [1n, 2n, 3n]) assert.equal(await card.ownerOf(tokenId), buyer.address);
      assert.equal(await token.balanceOf(taker.address), before + USD(30));
      assert.equal(await token.balanceOf(buyer.address), USD(9970));
      assert.equal(await token.balanceOf(f.exchangeAddress), 0n, 'nothing stays in the contract');
      assert.equal(await exchange.isOrderIdUsed(id('order-1')), true);
      assert.equal(await token.authorizationState(buyer.address, id('order-1')), true);
      // One Trade per token, each with its own price.
      const trades = events(receipt, exchange, 'Trade');
      assert.deepEqual(trades.map(t => [t.args.tokenId, t.args.price]), [[1n, USD(10)], [2n, USD(10)], [3n, USD(10)]]);
      for (const trade of trades) {
        assert.equal(trade.args.orderId, id('order-1'));
        assert.equal(trade.args.seller, inventory.address);
        assert.equal(trade.args.buyer, buyer.address);
        assert.equal(trade.args.collection, await card.getAddress());
        assert.equal(trade.args.currency, await token.getAddress());
      }
      assert.equal(events(receipt, exchange, 'Paid').length, 0);
      // One transaction carries both sides: the payment and the card transfers / mints.
      const cardTransfers = events(receipt, card, 'Transfer');
      assert.deepEqual(cardTransfers.map(e => [e.args.from, e.args.to, e.args.tokenId]), [
        [inventory.address, buyer.address, 1n],
        [inventory.address, buyer.address, 2n],
        [ethers.ZeroAddress, buyer.address, 3n],
      ]);
      const payments = events(receipt, token, 'Transfer');
      assert.deepEqual(payments.map(e => [e.args.from, e.args.to, e.args.value]), [
        [buyer.address, f.exchangeAddress, USD(30)],
        [f.exchangeAddress, taker.address, USD(30)],
      ]);
    });

    it('takes only the payment when the items are delivered later', async function () {
      const { exchange, token, taker } = f;
      const before = await token.balanceOf(taker.address);
      const receipt = await (await buy(f, { tokenIds: [], price: USD(5) })).wait();
      assert.equal(await token.balanceOf(taker.address), before + USD(5));
      assert.equal(events(receipt, exchange, 'Trade').length, 0, 'no token traded');
      const [paid] = events(receipt, exchange, 'Paid');
      assert.equal(paid.args.orderId, id('order-1'));
      assert.equal(paid.args.buyer, f.buyer.address);
      assert.equal(paid.args.currency, await token.getAddress());
      assert.equal(paid.args.amount, USD(5));
    });

    it('reports the part of the price for items delivered later separately from the tokens traded', async function () {
      const { exchange } = f;
      const receipt = await (await buy(f, { tokenIds: [1n, 2n], prices: [USD(7), USD(8)], price: USD(20) })).wait();
      assert.deepEqual(events(receipt, exchange, 'Trade').map(t => [t.args.tokenId, t.args.price]), [[1n, USD(7)], [2n, USD(8)]]);
      assert.equal(events(receipt, exchange, 'Paid')[0].args.amount, USD(5));
    });

    it('refuses prices that do not name one price per token or exceed the price', async function () {
      const { exchange } = f;
      await rejects(buy(f, { tokenIds: [1n, 2n], prices: [USD(1)] }), exchange, 'PricesMismatch');
      await rejects(buy(f, { tokenIds: [1n], prices: [USD(31)], price: USD(30) }), exchange, 'PricesMismatch');
      await rejects(buy(f, { tokenIds: [], prices: [USD(1)], price: USD(30) }), exchange, 'PricesMismatch');
    });

    it('rejects reused ids, other currencies, zero prices, the inventory as buyer and non-operators', async function () {
      const { exchange, other, outsider } = f;
      const first = await signedPurchase(f, { tokenIds: [1n] });
      await f.asOperator.buyWithAuthorization(first.purchase, first.signature);
      await rejects(f.asOperator.buyWithAuthorization(first.purchase, first.signature), exchange, 'OrderIdUsed');
      await rejects(buy(f, { orderId: id('order-2'), price: 0n }), exchange, 'InvalidAmount');
      await rejects(buy(f, { orderId: id('order-3'), currency: await other.getAddress() }), exchange, 'CurrencyNotAllowed');
      const signed = await signedPurchase(f, { orderId: id('order-4') });
      await rejects(exchange.connect(outsider).buyWithAuthorization(signed.purchase, signed.signature), exchange, 'AccessControlUnauthorizedAccount');
      await rejects(
        f.asOperator.buyWithAuthorization({ ...signed.purchase, buyer: ethers.ZeroAddress }, signed.signature),
        exchange, 'ZeroAddress',
      );
      // The inventory cannot trade with itself.
      const fromInventory = await signedPurchase(f, { orderId: id('order-5'), from: f.inventory });
      await rejects(f.asOperator.buyWithAuthorization(fromInventory.purchase, fromInventory.signature), exchange, 'InvalidBuyer');
    });

    it('only accepts an authorization made out to the exchange for that price and id', async function () {
      const { token, buyer, outsider } = f;
      await revertsWith(buy(f, { to: outsider.address }), 'invalid signature');
      const signed = await signedPurchase(f);
      await revertsWith(f.asOperator.buyWithAuthorization({ ...signed.purchase, price: USD(31) }, signed.signature), 'invalid signature');
      await revertsWith(f.asOperator.buyWithAuthorization({ ...signed.purchase, orderId: id('order-2') }, signed.signature), 'invalid signature');
      await revertsWith(f.asOperator.buyWithAuthorization({ ...signed.purchase, buyer: outsider.address }, signed.signature), 'invalid signature');
      // Nobody else can redeem it: receiveWithAuthorization requires the payee to submit.
      await revertsWith(
        token.connect(outsider).receiveWithAuthorization(buyer.address, f.exchangeAddress, USD(30), signed.purchase.validAfter, signed.purchase.validBefore, id('order-1'), signed.signature),
        'caller must be the payee',
      );
      // A failed settlement moves nothing; the same signature still settles once.
      assert.equal(await token.balanceOf(buyer.address), USD(10000));
      await f.asOperator.buyWithAuthorization(signed.purchase, signed.signature);
      assert.equal(await token.balanceOf(buyer.address), USD(9970));
    });

    it('refuses tokens outside the inventory, burned tokens, duplicates and oversized trades', async function () {
      const { exchange, card, asRelayer, seller, inventory, token, buyer } = f;
      await asRelayer.mint(seller.address, 5n);
      await asRelayer.mint(inventory.address, 6n);
      await asRelayer.burn(6n);
      const err = await rejects(buy(f, { tokenIds: [5n] }), exchange, 'NotInInventory');
      assert.equal(err.args.tokenId, 5n);
      await rejects(buy(f, { tokenIds: [6n] }), card, 'TokenBurned');
      await rejects(buy(f, { tokenIds: [7n, 7n] }), exchange, 'NotInInventory');
      const many = Array.from({ length: 51 }, (_, i) => BigInt(100 + i));
      await rejects(buy(f, { tokenIds: many }), exchange, 'TooManyTokens');
      // Nothing was paid by the failed settlements.
      assert.equal(await token.balanceOf(buyer.address), USD(10000));
    });

    it('settles an authorization that is not valid yet only from validAfter', async function () {
      const start = (await now()) + 600n;
      const signed = await signedPurchase(f, { validAfter: start });
      await revertsWith(f.asOperator.buyWithAuthorization(signed.purchase, signed.signature), 'authorization is not yet valid');
      await increaseTime(601n);
      await f.asOperator.buyWithAuthorization(signed.purchase, signed.signature);
    });
  });

  describe('asks', function () {
    it('fills an unsigned ask: tokens to the inventory, payment from the taker', async function () {
      const { exchange, card, token, asRelayer, asTaker, seller, inventory, taker } = f;
      await asRelayer.mintBatch(seller.address, [11n, 12n]);
      const a = await ask(f, { tokenIds: [11n, 12n], prices: [USD(5), USD(20)], price: USD(25) });
      const receipt = await (await asTaker.fillAsk(a, '0x')).wait();
      assert.equal(await card.ownerOf(11n), inventory.address);
      assert.equal(await card.ownerOf(12n), inventory.address);
      assert.equal(await token.balanceOf(seller.address), USD(25));
      assert.equal(await token.balanceOf(taker.address), USD(10000) - USD(25));
      const trades = events(receipt, exchange, 'Trade');
      assert.deepEqual(trades.map(t => [t.args.tokenId, t.args.price]), [[11n, USD(5)], [12n, USD(20)]]);
      for (const trade of trades) {
        assert.equal(trade.args.orderId, a.askId);
        assert.equal(trade.args.seller, seller.address);
        assert.equal(trade.args.buyer, inventory.address);
      }
      assert.deepEqual(events(receipt, token, 'Transfer').map(e => [e.args.from, e.args.to]), [[taker.address, seller.address]]);
      assert.equal(await exchange.isOrderIdUsed(a.askId), true);
      await rejects(asTaker.fillAsk(a, '0x'), exchange, 'OrderIdUsed');
    });

    it('is only for the taker and pays from the caller', async function () {
      const { exchange, asRelayer, asOperator, seller, outsider } = f;
      await asRelayer.mint(seller.address, 11n);
      await rejects(asOperator.fillAsk(await ask(f), '0x'), exchange, 'AccessControlUnauthorizedAccount');
      await exchange.connect(f.admin).grantRole(await exchange.TAKER_ROLE(), outsider.address);
      // The new taker has no allowance of its own: it cannot spend the other taker's funds.
      await rejects(exchange.connect(outsider).fillAsk(await ask(f), '0x'), f.token, 'ERC20InsufficientAllowance');
    });

    it('rejects expired, zero-price, empty and invalid asks', async function () {
      const { exchange, card, asRelayer, asTaker, seller, inventory, other } = f;
      await asRelayer.mint(seller.address, 11n);
      await rejects(asTaker.fillAsk(await ask(f, { validBefore: await now() }), '0x'), exchange, 'AskExpired');
      await rejects(asTaker.fillAsk(await ask(f, { price: 0n }), '0x'), exchange, 'InvalidAmount');
      await rejects(asTaker.fillAsk(await ask(f, { tokenIds: [] }), '0x'), exchange, 'EmptyTrade');
      await rejects(asTaker.fillAsk(await ask(f, { prices: [USD(19)] }), '0x'), exchange, 'PricesMismatch');
      await rejects(asTaker.fillAsk(await ask(f, { prices: [USD(10), USD(10)] }), '0x'), exchange, 'PricesMismatch');
      await rejects(asTaker.fillAsk(await ask(f, { seller: inventory.address }), '0x'), exchange, 'InvalidSeller');
      await rejects(asTaker.fillAsk(await ask(f, { currency: await other.getAddress() }), '0x'), exchange, 'CurrencyNotAllowed');
      await rejects(asTaker.fillAsk(await ask(f, { tokenIds: [99n] }), '0x'), card, 'ERC721NonexistentToken');
      await asRelayer.mint(inventory.address, 12n);
      await rejects(asTaker.fillAsk(await ask(f, { tokenIds: [12n] }), '0x'), card, 'ERC721IncorrectOwner');
    });

    it('enforces the per-fill and per-window taker limits', async function () {
      const { exchange, asRelayer, asTaker, seller, token, admin } = f;
      await asRelayer.mintBatch(seller.address, [1n, 2n, 3n, 4n]);
      await rejects(asTaker.fillAsk(await ask(f, { askId: id('a1'), tokenIds: [1n], price: USD(1001) }), '0x'), exchange, 'TakerLimitExceeded');
      await asTaker.fillAsk(await ask(f, { askId: id('a1'), tokenIds: [1n], price: USD(1000) }), '0x');
      await rejects(asTaker.fillAsk(await ask(f, { askId: id('a2'), tokenIds: [2n], price: USD(501) }), '0x'), exchange, 'TakerLimitExceeded');
      await asTaker.fillAsk(await ask(f, { askId: id('a2'), tokenIds: [2n], price: USD(500) }), '0x');
      await increaseTime(3600n);
      await asTaker.fillAsk(await ask(f, { askId: id('a3'), tokenIds: [3n], price: USD(1000) }), '0x');
      await exchange.connect(admin).setTakerLimit(await token.getAddress(), 0n, 0n, 0n);
      await rejects(asTaker.fillAsk(await ask(f, { askId: id('a4'), tokenIds: [4n], price: USD(1) }), '0x'), exchange, 'TakerLimitNotSet');
    });

    it('drains the taker window continuously, so the end of a window lets no second burst through', async function () {
      const { exchange, asRelayer, asTaker, seller } = f;
      await asRelayer.mintBatch(seller.address, [1n, 2n, 3n, 4n]);
      const fill = async (tokenId, price) =>
        asTaker.fillAsk(await ask(f, { askId: id(`w${tokenId}-${price}`), tokenIds: [tokenId], price }), '0x');
      // 1500 per hour, all of it at once.
      await fill(1n, USD(1000));
      await fill(2n, USD(500));
      await rejects(fill(3n, USD(10)), exchange, 'TakerLimitExceeded');
      // Half an hour drains half of it.
      await increaseTime(1800n);
      await fill(3n, USD(700));
      await rejects(fill(4n, USD(100)), exchange, 'TakerLimitExceeded');
      // An hour after the first fill a fixed window would allow 1500 again; only what drained is available.
      await increaseTime(1800n);
      await rejects(fill(4n, USD(1000)), exchange, 'TakerLimitExceeded');
      await fill(4n, USD(750));
    });

    it('checks seller signatures, and requires them once enabled', async function () {
      const { exchange, asRelayer, asTaker, seller, outsider, admin, exchangeDomain } = f;
      await asRelayer.mintBatch(seller.address, [1n, 2n, 3n]);
      const a1 = await ask(f, { askId: id('a1'), tokenIds: [1n] });
      const sig1 = await seller.signTypedData(exchangeDomain, ASK_TYPES, a1);
      assert.equal(await exchange.hashAsk(a1), ethers.TypedDataEncoder.hash(exchangeDomain, ASK_TYPES, a1));
      await rejects(asTaker.fillAsk({ ...a1, price: USD(21), prices: [USD(21)] }, sig1), exchange, 'InvalidSignature');
      await rejects(asTaker.fillAsk(a1, await outsider.signTypedData(exchangeDomain, ASK_TYPES, a1)), exchange, 'InvalidSignature');
      await asTaker.fillAsk(a1, sig1);

      await exchange.connect(admin).setAskSignatureRequired(true);
      const a2 = await ask(f, { askId: id('a2'), tokenIds: [2n] });
      await rejects(asTaker.fillAsk(a2, '0x'), exchange, 'SignatureRequired');
      await asTaker.fillAsk(a2, await seller.signTypedData(exchangeDomain, ASK_TYPES, a2));
    });

    it('accepts ERC-1271 signatures from contract wallets', async function () {
      const { card, asRelayer, asTaker, seller, exchangeDomain, inventory } = f;
      const wallet = await (await ethers.getContractFactory('Erc1271WalletMock')).deploy(seller.address);
      const walletAddress = await wallet.getAddress();
      await asRelayer.mint(walletAddress, 1n);
      const a = await ask(f, { seller: walletAddress, tokenIds: [1n] });
      await asTaker.fillAsk(a, await seller.signTypedData(exchangeDomain, ASK_TYPES, a));
      assert.equal(await card.ownerOf(1n), inventory.address);
    });
  });

  describe('upgrades', function () {
    const upgrade = (f, overrides = {}) => ({
      upgradeId: id('upgrade-1'),
      owner: f.buyer.address,
      sourceTokenIds: [21n],
      targetTokenIds: [31n],
      ...overrides,
    });

    it('settles a won upgrade in one transaction: sources to the inventory, the target minted to the owner', async function () {
      const { exchange, card, asRelayer, asOperator, buyer, inventory } = f;
      await asRelayer.mintBatch(buyer.address, [21n, 22n]);
      const u = upgrade(f, { sourceTokenIds: [21n, 22n] });
      const receipt = await (await asOperator.settleUpgrade(u)).wait();
      assert.equal(await card.ownerOf(21n), inventory.address);
      assert.equal(await card.ownerOf(22n), inventory.address);
      assert.equal(await card.ownerOf(31n), buyer.address);
      const [settled] = events(receipt, exchange, 'Upgraded');
      assert.equal(settled.args.upgradeId, u.upgradeId);
      assert.equal(settled.args.owner, buyer.address);
      assert.equal(settled.args.collection, await card.getAddress());
      assert.deepEqual([...settled.args.sourceTokenIds], [21n, 22n]);
      assert.deepEqual([...settled.args.targetTokenIds], [31n]);
      assert.deepEqual(
        events(receipt, card, 'Transfer').map(e => [e.args.from, e.args.to, e.args.tokenId]),
        [[buyer.address, inventory.address, 21n], [buyer.address, inventory.address, 22n], [ethers.ZeroAddress, buyer.address, 31n]],
      );
      assert.equal(await exchange.isOrderIdUsed(u.upgradeId), true);
      await rejects(asOperator.settleUpgrade(u), exchange, 'OrderIdUsed');
    });

    it('moves a target already in the inventory, and settles a lost upgrade with no target', async function () {
      const { card, asRelayer, asOperator, buyer, inventory } = f;
      await asRelayer.mint(buyer.address, 21n);
      await asRelayer.mint(inventory.address, 31n);
      await asOperator.settleUpgrade(upgrade(f));
      assert.equal(await card.ownerOf(31n), buyer.address);
      await asRelayer.mint(buyer.address, 23n);
      await asOperator.settleUpgrade(upgrade(f, { upgradeId: id('upgrade-2'), sourceTokenIds: [23n], targetTokenIds: [] }));
      assert.equal(await card.ownerOf(23n), inventory.address);
    });

    it('refuses sources the owner does not hold, targets outside the inventory and empty upgrades, atomically', async function () {
      const { exchange, card, asRelayer, asOperator, buyer, seller, inventory } = f;
      await asRelayer.mint(seller.address, 21n);
      await rejects(asOperator.settleUpgrade(upgrade(f)), card, 'ERC721IncorrectOwner');
      await asRelayer.mint(buyer.address, 22n);
      await asRelayer.mint(seller.address, 31n);
      await rejects(asOperator.settleUpgrade(upgrade(f, { sourceTokenIds: [22n] })), exchange, 'NotInInventory');
      // Nothing moved: the failed call rolled back the source too.
      assert.equal(await card.ownerOf(22n), buyer.address);
      assert.equal(await exchange.isOrderIdUsed(id('upgrade-1')), false);
      await rejects(asOperator.settleUpgrade(upgrade(f, { sourceTokenIds: [] })), exchange, 'EmptyTrade');
      await rejects(asOperator.settleUpgrade(upgrade(f, { owner: inventory.address })), exchange, 'InvalidSeller');
      await rejects(asOperator.settleUpgrade(upgrade(f, { owner: ethers.ZeroAddress })), exchange, 'InvalidSeller');
      const many = Array.from({ length: 50 }, (_, i) => BigInt(100 + i));
      await rejects(asOperator.settleUpgrade(upgrade(f, { sourceTokenIds: many })), exchange, 'TooManyTokens');
    });

    it('is only for the operator and stops while paused', async function () {
      const { exchange, admin, asRelayer, asOperator, asTaker, buyer } = f;
      await asRelayer.mint(buyer.address, 21n);
      await rejects(asTaker.settleUpgrade(upgrade(f)), exchange, 'AccessControlUnauthorizedAccount');
      await exchange.connect(admin).pause();
      await rejects(asOperator.settleUpgrade(upgrade(f)), exchange, 'EnforcedPause');
      await exchange.connect(admin).unpause();
      await asOperator.settleUpgrade(upgrade(f));
    });

    it('shares the order id space with purchases and asks', async function () {
      const { exchange, asRelayer, asOperator, buyer } = f;
      await buy(f, { orderId: id('shared'), tokenIds: [1n] });
      await asRelayer.mint(buyer.address, 21n);
      await rejects(asOperator.settleUpgrade(upgrade(f, { upgradeId: id('shared') })), exchange, 'OrderIdUsed');
    });
  });

  describe('deliveries', function () {
    const delivery = (f, overrides = {}) => ({ deliveryId: id('delivery-1'), to: f.buyer.address, tokenIds: [41n, 42n], ...overrides });

    it('delivers inventory tokens and mints missing ones in one transaction', async function () {
      const { exchange, card, asRelayer, asOperator, buyer, inventory } = f;
      await asRelayer.mint(inventory.address, 41n);
      const d = delivery(f);
      const receipt = await (await asOperator.deliver(d)).wait();
      assert.equal(await card.ownerOf(41n), buyer.address);
      assert.equal(await card.ownerOf(42n), buyer.address);
      const [delivered] = events(receipt, exchange, 'Delivered');
      assert.equal(delivered.args.deliveryId, d.deliveryId);
      assert.equal(delivered.args.to, buyer.address);
      assert.deepEqual([...delivered.args.tokenIds], [41n, 42n]);
      assert.deepEqual(
        events(receipt, card, 'Transfer').map(e => [e.args.from, e.args.to, e.args.tokenId]),
        [[inventory.address, buyer.address, 41n], [ethers.ZeroAddress, buyer.address, 42n]],
      );
      await rejects(asOperator.deliver(d), exchange, 'OrderIdUsed');
    });

    it('refuses tokens outside the inventory, empty or oversized deliveries, others and pauses, atomically', async function () {
      const { exchange, card, admin, asRelayer, asOperator, asTaker, seller, inventory } = f;
      await asRelayer.mint(seller.address, 42n);
      await rejects(asOperator.deliver(delivery(f)), exchange, 'NotInInventory');
      await rejects(card.ownerOf(41n), card, 'ERC721NonexistentToken');
      assert.equal(await exchange.isOrderIdUsed(id('delivery-1')), false);
      await rejects(asOperator.deliver(delivery(f, { tokenIds: [] })), exchange, 'EmptyTrade');
      await rejects(asOperator.deliver(delivery(f, { to: inventory.address })), exchange, 'InvalidSeller');
      const many = Array.from({ length: 51 }, (_, i) => BigInt(100 + i));
      await rejects(asOperator.deliver(delivery(f, { tokenIds: many })), exchange, 'TooManyTokens');
      await rejects(asTaker.deliver(delivery(f, { tokenIds: [41n] })), exchange, 'AccessControlUnauthorizedAccount');
      await exchange.connect(admin).pause();
      await rejects(asOperator.deliver(delivery(f, { tokenIds: [41n] })), exchange, 'EnforcedPause');
    });
  });

  describe('admin', function () {
    it('pauses purchases and asks', async function () {
      const { exchange, admin, asOperator, asTaker, asRelayer, seller } = f;
      await asRelayer.mint(seller.address, 11n);
      const signed = await signedPurchase(f, { tokenIds: [1n] });
      await exchange.connect(admin).pause();
      await rejects(asOperator.buyWithAuthorization(signed.purchase, signed.signature), exchange, 'EnforcedPause');
      await rejects(asTaker.fillAsk(await ask(f), '0x'), exchange, 'EnforcedPause');
      await exchange.connect(admin).unpause();
      await asOperator.buyWithAuthorization(signed.purchase, signed.signature);
    });

    it('fails when the collection roles are revoked', async function () {
      const { card, admin, exchangeAddress } = f;
      await card.connect(admin).revokeRole(await card.MINTER_ROLE(), exchangeAddress);
      await rejects(buy(f, { tokenIds: [1n] }), card, 'AccessControlUnauthorizedAccount');
    });

    it('restricts configuration to the admin and validates it', async function () {
      const { exchange, admin, outsider, token, operator } = f;
      const asAdmin = exchange.connect(admin);
      await rejects(exchange.connect(outsider).setInventory(outsider.address), exchange, 'AccessControlUnauthorizedAccount');
      await rejects(exchange.connect(operator).setProceedsRecipient(outsider.address), exchange, 'AccessControlUnauthorizedAccount');
      await rejects(exchange.connect(outsider).pause(), exchange, 'AccessControlUnauthorizedAccount');
      await rejects(asAdmin.setInventory(ethers.ZeroAddress), exchange, 'ZeroAddress');
      await rejects(asAdmin.setTakerLimit(await token.getAddress(), USD(2), USD(1), 60n), exchange, 'InvalidAmount');
      await rejects(asAdmin.setTakerLimit(await token.getAddress(), USD(1), USD(2), 0n), exchange, 'InvalidAmount');
      await asAdmin.setCurrencyAllowed(await token.getAddress(), false);
      await rejects(buy(f, { tokenIds: [1n] }), exchange, 'CurrencyNotAllowed');
      await asAdmin.setCurrencyAllowed(await token.getAddress(), true);
      await buy(f, { tokenIds: [1n] });
    });

    it('recovers tokens sent to it by mistake, for the admin only', async function () {
      const { exchange, token, admin, taker, outsider, exchangeAddress } = f;
      await token.mint(exchangeAddress, USD(7));
      await rejects(exchange.connect(outsider).recoverERC20(await token.getAddress()), exchange, 'AccessControlUnauthorizedAccount');
      const before = await token.balanceOf(taker.address);
      await exchange.connect(admin).recoverERC20(await token.getAddress());
      assert.equal(await token.balanceOf(taker.address), before + USD(7));
      assert.equal(await token.balanceOf(exchangeAddress), 0n);
      await exchange.connect(admin).recoverERC20(await token.getAddress());
    });

    it('upgrades only through the admin', async function () {
      const { exchange, admin, outsider } = f;
      const Exchange = await ethers.getContractFactory('OpenHypeExchange', outsider);
      await assert.rejects(upgrades.upgradeProxy(await exchange.getAddress(), Exchange, { kind: 'uups' }));
      const AsAdmin = await ethers.getContractFactory('OpenHypeExchange', admin);
      await upgrades.upgradeProxy(await exchange.getAddress(), AsAdmin, { kind: 'uups', redeployImplementation: 'always' });
      assert.equal(await exchange.inventory(), f.inventory.address);
    });
  });
});
