const assert = require('node:assert/strict');
const { ethers, upgrades } = require('hardhat');

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

async function deploy() {
  const [admin, relayer, user, other, custody] = await ethers.getSigners();
  const Card = await ethers.getContractFactory('OpenHypeCard');
  const card = await upgrades.deployProxy(Card, [admin.address, relayer.address, 'https://meta.example/cards/'], {
    kind: 'uups',
  });
  return { admin, relayer, user, other, custody, card, asRelayer: card.connect(relayer) };
}

describe('OpenHypeCard', function () {
  let f;
  beforeEach(async function () {
    f = await deploy();
  });

  it('grants admin to the admin and mint/operate to the relayer only', async function () {
    const { card, admin, relayer } = f;
    assert.equal(await card.hasRole(await card.DEFAULT_ADMIN_ROLE(), admin.address), true);
    assert.equal(await card.hasRole(await card.MINTER_ROLE(), relayer.address), true);
    assert.equal(await card.hasRole(await card.OPERATOR_ROLE(), relayer.address), true);
    assert.equal(await card.hasRole(await card.MINTER_ROLE(), admin.address), false);
    assert.equal(await card.paused(), false);
    assert.equal(await card.name(), 'OpenHype Card');
  });

  it('mints single and batched tokens with ERC-5192 lock events', async function () {
    const { card, asRelayer, user, custody } = f;
    await assert.doesNotReject(asRelayer.mint(user.address, 1n));
    const tx = await asRelayer.mintBatch(custody.address, [2n, 3n]);
    const locked = (await tx.wait()).logs.map(l => card.interface.parseLog(l)).filter(l => l?.name === 'Locked');
    assert.deepEqual(locked.map(l => l.args.tokenId), [2n, 3n]);
    assert.equal(await card.ownerOf(1n), user.address);
    assert.equal(await card.ownerOf(3n), custody.address);
    assert.equal(await card.locked(1n), true);
    assert.equal(await card.tokenURI(2n), 'https://meta.example/cards/2');
    await rejects(asRelayer.mint(user.address, 1n), card, 'ERC721InvalidSender');
  });

  it('rejects mint, transfer and burn from accounts without the role', async function () {
    const { card, asRelayer, user, other } = f;
    await asRelayer.mint(user.address, 1n);
    await rejects(card.connect(other).mint(other.address, 2n), card, 'AccessControlUnauthorizedAccount');
    await rejects(card.connect(other).mintBatch(other.address, [2n]), card, 'AccessControlUnauthorizedAccount');
    await rejects(card.connect(user).operatorTransfer(user.address, other.address, 1n), card, 'AccessControlUnauthorizedAccount');
    await rejects(card.connect(user).burn(1n), card, 'AccessControlUnauthorizedAccount');
  });

  it('blocks every holder transfer and approval path', async function () {
    const { card, asRelayer, user, other } = f;
    await asRelayer.mint(user.address, 1n);
    const asUser = card.connect(user);
    await rejects(asUser.approve(other.address, 1n), card, 'NonTransferable');
    await rejects(asUser.setApprovalForAll(other.address, true), card, 'NonTransferable');
    await rejects(asUser.transferFrom(user.address, other.address, 1n), card, 'NonTransferable');
    await rejects(
      asUser['safeTransferFrom(address,address,uint256)'](user.address, other.address, 1n),
      card,
      'NonTransferable',
    );
    await rejects(
      asUser['safeTransferFrom(address,address,uint256,bytes)'](user.address, other.address, 1n, '0x'),
      card,
      'NonTransferable',
    );
    assert.equal(await card.ownerOf(1n), user.address);
  });

  it('lets the operator move cards between custody and holders', async function () {
    const { card, asRelayer, user, other, custody } = f;
    await asRelayer.mintBatch(custody.address, [7n]);
    await asRelayer.operatorTransfer(custody.address, user.address, 7n);
    await asRelayer.operatorTransfer(user.address, other.address, 7n);
    assert.equal(await card.ownerOf(7n), other.address);
    await rejects(asRelayer.operatorTransfer(user.address, custody.address, 7n), card, 'ERC721IncorrectOwner');
    await rejects(asRelayer.operatorTransfer(other.address, ethers.ZeroAddress, 7n), card, 'ERC721InvalidReceiver');
  });

  it('burns for physical redemption and never re-mints a burned token', async function () {
    const { card, asRelayer, user } = f;
    await asRelayer.mint(user.address, 9n);
    await asRelayer.burn(9n);
    assert.equal(await card.burned(9n), true);
    await rejects(card.ownerOf(9n), card, 'ERC721NonexistentToken');
    await rejects(card.locked(9n), card, 'ERC721NonexistentToken');
    await rejects(asRelayer.mint(user.address, 9n), card, 'TokenBurned');
    await rejects(asRelayer.mintBatch(user.address, [10n, 9n]), card, 'TokenBurned');
  });

  it('pauses all platform moves', async function () {
    const { card, asRelayer, user, other } = f;
    await asRelayer.mint(user.address, 1n);
    await card.pause();
    await rejects(asRelayer.mint(user.address, 2n), card, 'EnforcedPause');
    await rejects(asRelayer.operatorTransfer(user.address, other.address, 1n), card, 'EnforcedPause');
    await rejects(asRelayer.burn(1n), card, 'EnforcedPause');
    await rejects(card.connect(other).unpause(), card, 'AccessControlUnauthorizedAccount');
    await card.unpause();
    await assert.doesNotReject(asRelayer.burn(1n));
  });

  it('advertises ERC721, ERC-5192 and AccessControl', async function () {
    const { card } = f;
    for (const id of ['0x80ac58cd', '0x5b5e139f', '0xb45a3c0e', '0x7965db0b', '0x01ffc9a7']) {
      assert.equal(await card.supportsInterface(id), true, id);
    }
    assert.equal(await card.supportsInterface('0xffffffff'), false);
  });

  it('lets only the admin change the base URI and upgrade, keeping state', async function () {
    const { card, asRelayer, user, other } = f;
    await asRelayer.mint(user.address, 1n);
    await rejects(card.connect(other).setBaseURI('x/'), card, 'AccessControlUnauthorizedAccount');
    await card.setBaseURI('ipfs://cards/');
    assert.equal(await card.tokenURI(1n), 'ipfs://cards/1');

    const V2 = await ethers.getContractFactory('OpenHypeCardV2Mock');
    await assert.rejects(upgrades.upgradeProxy(await card.getAddress(), V2.connect(other)));
    const upgraded = await upgrades.upgradeProxy(await card.getAddress(), V2);
    assert.equal(await upgraded.version(), 2n);
    assert.equal(await upgraded.ownerOf(1n), user.address);
    assert.equal(await upgraded.tokenURI(1n), 'ipfs://cards/1');
  });

  it('publishes collection metadata through an admin-set contractURI (ERC-7572)', async function () {
    const { card, other } = f;
    assert.equal(await card.contractURI(), '');
    await rejects(card.connect(other).setContractURI('https://x/contract'), card, 'AccessControlUnauthorizedAccount');
    const receipt = await (await card.setContractURI('https://meta.example/contract')).wait();
    assert.equal(await card.contractURI(), 'https://meta.example/contract');
    assert.ok(receipt.logs.some(l => card.interface.parseLog(l)?.name === 'ContractURIUpdated'));
  });

  it('rejects re-initialization', async function () {
    const { card, other } = f;
    await rejects(card.initialize(other.address, other.address, 'x/'), card, 'InvalidInitialization');
  });

  describe('holder-signed transfers (EIP-712)', function () {
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    const cancelTypes = { CancelAuthorization: [{ name: 'authorizer', type: 'address' }, { name: 'nonce', type: 'bytes32' }] };
    let domain, now;
    beforeEach(async function () {
      const { chainId } = await ethers.provider.getNetwork();
      domain = { name: 'OpenHype Card', version: '1', chainId, verifyingContract: await f.card.getAddress() };
      now = BigInt((await ethers.provider.getBlock('latest')).timestamp);
    });
    const authorize = async (signer, fields = {}) => {
      const message = {
        from: signer.address,
        to: f.other.address,
        tokenId: 1n,
        validAfter: 0n,
        validBefore: now + 3600n,
        nonce: ethers.hexlify(ethers.randomBytes(32)),
        ...fields,
      };
      return { message, signature: await signer.signTypedData(domain, types, message) };
    };
    const relay = ({ message: m, signature }, as = f.asRelayer) =>
      as.transferWithAuthorization(m.from, m.to, m.tokenId, m.validAfter, m.validBefore, m.nonce, signature);

    it('exposes a constant EIP-712 domain (EIP-5267) without initialization', async function () {
      const d = await f.card.eip712Domain();
      assert.equal(d.name, 'OpenHype Card');
      assert.equal(d.version, '1');
      assert.equal(await f.card.DOMAIN_SEPARATOR(), ethers.TypedDataEncoder.hashDomain(domain));
    });

    it('moves a card with the holder signature when the operator relays it', async function () {
      const { card, asRelayer, user, other } = f;
      await asRelayer.mint(user.address, 1n);
      const auth = await authorize(user);
      const receipt = await (await relay(auth)).wait();
      assert.equal(await card.ownerOf(1n), other.address);
      assert.equal(await card.authorizationState(user.address, auth.message.nonce), true);
      assert.ok(receipt.logs.some(l => card.interface.parseLog(l)?.name === 'AuthorizationUsed'));
    });

    it('accepts only operator relays, the holder signature, the signed fields and each nonce once', async function () {
      const { card, asRelayer, user, other } = f;
      await asRelayer.mint(user.address, 1n);
      const auth = await authorize(user);
      await rejects(relay(auth, card.connect(other)), card, 'AccessControlUnauthorizedAccount');
      await rejects(relay(await authorize(other, { from: user.address })), card, 'InvalidSignature');
      await rejects(relay({ ...auth, message: { ...auth.message, to: f.admin.address } }), card, 'InvalidSignature');
      await relay(auth);
      await rejects(relay(auth), card, 'AuthorizationUsedOrCanceled');
    });

    it('enforces the validity window', async function () {
      const { card, asRelayer, user } = f;
      await asRelayer.mint(user.address, 1n);
      await rejects(relay(await authorize(user, { validBefore: now })), card, 'AuthorizationExpired');
      await rejects(relay(await authorize(user, { validAfter: now + 3600n })), card, 'AuthorizationNotYetValid');
    });

    it('lets the holder cancel an unused authorization', async function () {
      const { card, asRelayer, user, other } = f;
      await asRelayer.mint(user.address, 1n);
      const auth = await authorize(user);
      const cancel = await user.signTypedData(domain, cancelTypes, { authorizer: user.address, nonce: auth.message.nonce });
      await rejects(card.connect(other).cancelAuthorization(user.address, auth.message.nonce, await other.signTypedData(domain, cancelTypes, { authorizer: user.address, nonce: auth.message.nonce })), card, 'InvalidSignature');
      await card.connect(other).cancelAuthorization(user.address, auth.message.nonce, cancel);
      await rejects(relay(auth), card, 'AuthorizationUsedOrCanceled');
    });

    it('supports ERC-1271 contract wallets', async function () {
      const { card, asRelayer, user } = f;
      const wallet = await (await ethers.getContractFactory('Erc1271WalletMock')).deploy(user.address);
      const walletAddress = await wallet.getAddress();
      await asRelayer.mint(walletAddress, 5n);
      const message = { from: walletAddress, to: f.other.address, tokenId: 5n, validAfter: 0n, validBefore: now + 3600n, nonce: ethers.hexlify(ethers.randomBytes(32)) };
      await relay({ message, signature: await user.signTypedData(domain, types, message) });
      assert.equal(await card.ownerOf(5n), f.other.address);
    });

    it('accepts the key of an EIP-7702 delegated EOA, which has code', async function () {
      const { card, asRelayer } = f;
      const holder = ethers.Wallet.createRandom();
      // A 7702 delegation designator pointing at a contract without ERC-1271.
      await ethers.provider.send('hardhat_setCode', [holder.address, ethers.concat(['0xef0100', await card.getAddress()])]);
      await asRelayer.mint(holder.address, 7n);
      await relay(await authorize(holder, { tokenId: 7n }));
      assert.equal(await card.ownerOf(7n), f.other.address);
    });

    it('stops signed transfers while paused', async function () {
      const { card, asRelayer, user } = f;
      await asRelayer.mint(user.address, 1n);
      await card.pause();
      await rejects(relay(await authorize(user)), card, 'EnforcedPause');
    });
  });
});

