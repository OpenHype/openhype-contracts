# OpenHype Contracts

[OpenHype](https://openhype.com) is a collectible card platform. You open digital packs, battle and trade, and every card you pull is a real, graded trading card (for example PSA or CGC) stored in the OpenHype vault. You can sell a card back, keep it, or have the physical card shipped to you.

Each card also exists on chain as an NFT in the **OpenHype Collectibles** collection (symbol `OHC`, contract `OpenHypeCollectible`) on [X Layer](https://www.okx.com/xlayer), so anyone can check which card a wallet holds and verify its grading certificate. This repository contains that contract.

> **Status:** not audited. Deployed on X Layer testnet only.

## How it works

- **One token per physical card.** `tokenId` is the card's permanent inventory identity. Token metadata includes the grading company and certificate number, which anyone can check with the grader.
- **Locked tokens (ERC-5192).** Holders cannot approve or transfer their cards directly. Ownership follows what happens in the OpenHype app, and the platform mirrors it on chain.
- **Platform-operated moves.** The platform mints a card when it is pulled (or pre-mints vault stock into a custody address), moves it on buyback, battles and trades, and burns it when the physical card is shipped to its owner. A burned `tokenId` can never be minted again.
- **Gasless for users.** The platform sends every transaction and pays the gas.
- **Holder consent (EIP-712).** A holder can authorize a specific move by signing a `TransferWithAuthorization`, modelled on EIP-3009; the platform relays it.
- **Collection metadata** is published through `contractURI` (ERC-7572).

## Trust model

The on-chain token mirrors a physical card held by OpenHype, so the platform is trusted:

- The platform's operator can mint, move and burn cards without the holder's signature. This is how app actions (pulls, buybacks, battles, shipping) are reflected on chain.
- The admin can pause the contract, update token and collection metadata, manage roles and upgrade the contract. On mainnet the admin will be a multisig.
- Holders can't move cards themselves, so a card can't be sent to the wrong address or listed elsewhere without the platform.

## Roles

| Role | Held by | Can |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | admin (multisig on mainnet) | upgrade, grant/revoke roles, pause, set base URI and contract URI |
| `MINTER_ROLE` | platform relayer | `mint`, `mintBatch` |
| `OPERATOR_ROLE` | platform relayer | `operatorTransfer`, `burn`, relay `transferWithAuthorization` |

## Holder consent

A holder can consent to one specific move by signing

```
TransferWithAuthorization(address from,address to,uint256 tokenId,uint256 validAfter,uint256 validBefore,bytes32 nonce)
```

in the EIP-712 domain `{name: "OpenHype Collectibles", version: "1", chainId, verifyingContract}` (see `eip712Domain()` and `DOMAIN_SEPARATOR()`). As in EIP-3009, each random `bytes32` nonce can be used once (`authorizationState`), the authorization is valid only while `validAfter < block.timestamp < validBefore`, and `cancelAuthorization(authorizer, nonce, signature)` revokes an unused one — anyone may submit the cancellation, even while the contract is paused.

`transferWithAuthorization(from, to, tokenId, validAfter, validBefore, nonce, signature)` can only be called by `OPERATOR_ROLE`, so cards stay non-transferable by holders while every consented move carries an on-chain signature. Signatures are checked as ECDSA first and, for smart-contract wallets, ERC-1271.

## Deployments

| Network | Chain ID | Address | Record |
| --- | --- | --- | --- |
| X Layer testnet | 1952 | [`0xD21a980E70d6663a49715Be2E39b068AfF56f11B`](https://www.oklink.com/x-layer-testnet/address/0xD21a980E70d6663a49715Be2E39b068AfF56f11B) | [`deployments/xlayerTestnet-card.json`](deployments/xlayerTestnet-card.json) |

Source code is verified on OKLink. X Layer mainnet: not deployed yet.

## Stablecoin payments

Payments on OpenHype don't need a contract of ours: users sign EIP-3009 `transferWithAuthorization` for the stablecoin itself (USDC, USD₮0, USDG on X Layer) and the platform relays it. [`lib/token_authorization.cjs`](lib/token_authorization.cjs) checks a token's EIP-3009 behavior through its public address before the token is accepted:

```sh
node scripts/inspect_token_authorization.cjs <196|1952> <https-rpc> <token>...
```

It is read-only and passes only when the typehash is standard, a valid zero-value authorization succeeds, a tampered one reverts, and an unfunded one reverts differently from the tampered one.

## Development

Requires Node 22.

```sh
npm ci
npm test
```

Solidity 0.8.30, OpenZeppelin 5.4.0, Hardhat 2.26.3, optimizer 200 runs, EVM `paris`. The compiler is loaded from the pinned `solc` package, so compiling never downloads a compiler. `src/test/` holds test fixtures only. The compiler's "unreachable code" warning in `ERC721Upgradeable.safeTransferFrom` is expected: `transferFrom` always reverts.

## Deploy and upgrade

Copy `.env.example` to `.env` and set `DEPLOYER_PRIVATE_KEY` (it only pays gas and keeps no role unless it is also the admin).

```sh
CARD_ADMIN_ADDRESS=0x... CARD_RELAYER_ADDRESS=0x... CARD_BASE_URI=https://.../asset/ npm run deploy:card:testnet
npm run upgrade:card:testnet
```

The deploy script writes `deployments/<network>-card.json`; running it again verifies the recorded deployment instead of redeploying. The upgrade script checks storage-layout compatibility before upgrading and records the history.

On mainnet (`hardhat.mainnet.config.cjs`, network `xlayer`) the deployer key is `MAINNET_DEPLOYER_PRIVATE_KEY` (the testnet key is refused) and the deploy script first checks that no testnet address holds a role, that the admin is a contract (a Safe multisig), that the deployer keeps no role and that token metadata is served over https from a production host; it then needs `CONFIRM_MAINNET=yes`. Upgrades are proposed to the Safe: `npm run upgrade:card:mainnet` deploys the new implementation and prints the `upgradeToAndCall` transaction, and a second run records it once executed. `npm run verify:card:<testnet|mainnet>` verifies the implementation and proxy sources on OKLink.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
