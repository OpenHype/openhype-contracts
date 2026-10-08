// Behavioral EIP-3009 capability check through the token's public address (proxy).
// Read-only eth_call only; ephemeral signer wallets are never funded or persisted.
// Do not judge support from an explorer's implementation ABI: some issuers (e.g. mainnet
// USDG) serve transferWithAuthorization through a fallback module.
const {
  Interface,
  Wallet,
  TypedDataEncoder,
  Signature,
  keccak256,
  id,
  toBeHex,
  getAddress,
  hexlify,
  randomBytes,
} = require("ethers");

const TRANSFER_WITH_AUTHORIZATION_TYPEHASH = id(
  "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
);
const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
const abi = new Interface([
  "function name() view returns(string)",
  "function symbol() view returns(string)",
  "function decimals() view returns(uint8)",
  "function version() view returns(string)",
  "function DOMAIN_SEPARATOR() view returns(bytes32)",
  "function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() view returns(bytes32)",
  "function authorizationState(address,bytes32) view returns(bool)",
  "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
]);

// rpc(method, params) must throw an error with `executionReverted = true` and optional
// `data` (revert bytes) for EVM reverts, and a plain error for transport failures.
async function inspect(rpc, chainId, address) {
  address = getAddress(address.toLowerCase());
  if (BigInt(await rpc("eth_chainId", [])) !== BigInt(chainId)) throw Error("Wrong chain");
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const tag = block.number;
  const call = (name, args = [], from) =>
    rpc("eth_call", [{ to: address, from, data: abi.encodeFunctionData(name, args) }, tag]);
  const read = async (name, args = []) => abi.decodeFunctionResult(name, await call(name, args))[0];
  const code = await rpc("eth_getCode", [address, tag]);
  if (code === "0x") throw Error("No token code");
  const result = {
    chainId,
    address,
    block: tag,
    blockHash: block.hash,
    codeHash: keccak256(code),
    status: "unverified",
  };
  const values = await Promise.allSettled(
    ["name", "symbol", "decimals", "DOMAIN_SEPARATOR", "version"].map(n => read(n)),
  );
  ["name", "symbol", "decimals", "domainSeparator", "version"].forEach((key, i) => {
    if (values[i].status === "fulfilled") result[key] = values[i].value.toString();
  });
  for (const [kind, slot] of [
    ["eip1967", toBeHex(BigInt(id("eip1967.proxy.implementation")) - 1n, 32)],
    ["zeppelinos", id("org.zeppelinos.proxy.implementation")],
  ]) {
    const value = await rpc("eth_getStorageAt", [address, slot, tag]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw Error("Malformed implementation slot");
    if (BigInt(value)) {
      const implementation = getAddress("0x" + value.slice(-40));
      result.proxy = { kind, implementation, codeHash: keccak256(await rpc("eth_getCode", [implementation, tag])) };
      break;
    }
  }
  if (!result.domainSeparator || !result.name) {
    result.reason = "EIP-712 domain unavailable";
    return result;
  }
  const domain = [...new Set([result.version, "1", "2"].filter(Boolean))]
    .map(version => ({ name: result.name, version, chainId, verifyingContract: address }))
    .find(d => TypedDataEncoder.hashDomain(d).toLowerCase() === result.domainSeparator.toLowerCase());
  if (!domain) {
    result.reason = "Token signing domain unresolved";
    return result;
  }
  result.domain = domain;

  const reverted = async promise => {
    try {
      await promise;
      return null;
    } catch (e) {
      if (!e.executionReverted) throw e;
      return e.data || "0x";
    }
  };
  try {
    let typehash;
    try {
      typehash = await read("TRANSFER_WITH_AUTHORIZATION_TYPEHASH");
    } catch (e) {
      throw Error("TRANSFER_WITH_AUTHORIZATION_TYPEHASH unreadable");
    }
    if (typehash.toLowerCase() !== TRANSFER_WITH_AUTHORIZATION_TYPEHASH) throw Error("Non-standard typehash");

    const signer = Wallet.createRandom();
    const relayer = Wallet.createRandom().address;
    const validBefore = BigInt(block.timestamp) + 3600n;
    const attempt = async (value, { tamperTo = false } = {}) => {
      const message = {
        from: signer.address,
        to: Wallet.createRandom().address,
        value,
        validAfter: 0n,
        validBefore,
        nonce: hexlify(randomBytes(32)),
      };
      const sig = Signature.from(await signer.signTypedData(domain, transferWithAuthorizationTypes, message));
      const to = tamperTo ? relayer : message.to;
      return call(
        "transferWithAuthorization",
        [message.from, to, value, 0n, validBefore, message.nonce, sig.v, sig.r, sig.s],
        relayer,
      );
    };
    if (await read("authorizationState", [signer.address, hexlify(randomBytes(32))]))
      throw Error("Unused authorization reported as used");
    if ((await reverted(attempt(0n))) !== null) throw Error("Valid zero-value authorization rejected");
    const tampered = await reverted(attempt(1n, { tamperTo: true }));
    if (tampered === null) throw Error("Tampered authorization accepted");
    // An unfunded signer must fail on balance, i.e. differently from a bad signature.
    const unfunded = await reverted(attempt(1n));
    if (unfunded === null) throw Error("Unfunded transfer accepted");
    if (unfunded === tampered) throw Error("Could not distinguish balance failure from signature failure");
    const checked = await rpc("eth_getBlockByNumber", [tag, false]);
    if (checked.hash !== block.hash) throw Error("Inspection block changed");
    result.status = "eip3009_simulated";
    result.simulation = {
      typehash,
      validZeroValueAccepted: true,
      tamperedRejectedWith: tampered,
      unfundedRejectedWith: unfunded,
    };
  } catch (e) {
    result.reason = "EIP-3009 simulation failed: " + e.message;
  }
  return result;
}

module.exports = { inspect, TRANSFER_WITH_AUTHORIZATION_TYPEHASH, transferWithAuthorizationTypes };
