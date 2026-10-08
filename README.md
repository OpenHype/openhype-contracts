# OpenHype Contracts

[OpenHype](https://openhype.com) is a collectible card platform. Every card on OpenHype is a real, graded trading card (for example PSA or CGC) stored in the OpenHype vault. Collectors can buy, trade and keep cards, or have the physical card shipped to them.

Each card also exists on chain as an NFT in the **OpenHype Collectibles** collection (symbol `OHC`, contract `OpenHypeCollectible`) on [X Layer](https://www.okx.com/xlayer), so anyone can check which card a wallet holds and verify its grading certificate. Trades of these cards against stablecoins settle on chain through `OpenHypeExchange`.

> **Status:** not audited. Deployed on X Layer mainnet and testnet.

## OpenHypeCollectible

- **One token per physical card in the vault.** Token metadata includes the grading company and certificate number, which anyone can check with the grader. A card deposited again later gets a new `tokenId`; a burned `tokenId` is never minted again.
- **Locked tokens (ERC-5192).** Holders cannot approve or transfer cards themselves. The platform mirrors ownership from the OpenHype app: it mints, moves and burns tokens and pays the gas. A token is burned when the physical card is shipped to its owner.
- **Holder consent (EIP-712).** A holder can authorize one specific move by signing a `TransferWithAuthorization`, modelled on EIP-3009, which the platform relays.
- **Metadata.** `contractURI` (ERC-7572), `owner()` for marketplaces (EIP-5313) and refresh events (ERC-4906).

## OpenHypeExchange

Every trade is one transaction in which the stablecoin payment and the token transfers happen together, and each token traded emits its own event:

```
Trade(bytes32 indexed orderId, address indexed seller, address indexed buyer, address collection, uint256 tokenId, address currency, uint256 price)
Paid(bytes32 indexed orderId, address indexed buyer, address currency, uint256 amount)
```

- **Purchases** (`buyWithAuthorization`): the buyer signs an EIP-3009 `ReceiveWithAuthorization` made out to the exchange, with the order id as nonce. Nothing moves until the purchase settles; then the payment and the tokens move in the same transaction. The exchange never holds funds between trades.
- **Asks** (`fillAsk`): a holder sells tokens and a taker pays for them in the same transaction, optionally with the seller's EIP-712 `Ask` signature (domain `OpenHype Exchange`, version `1`). Taker payments are capped per fill and over a rolling window for each currency.
- **Swaps and deliveries** (`settleUpgrade`, `deliver`): tokens move between a holder and the inventory with no payment, emitting `Upgraded` or `Delivered`.

## Trust model

The tokens mirror physical cards held by OpenHype, so the platform is trusted:

- The platform's operator mints, moves and burns cards and settles trades without a holder's signature; this is how actions in the app are reflected on chain. Holders can't move cards themselves, so a card can't be sent to the wrong address or listed elsewhere.
- The admin can pause, update metadata, manage roles and upgrade both contracts. It is held by OpenHype and will move to a multisig.

## Deployments

| Contract | Network | Address |
| --- | --- | --- |
| OpenHypeCollectible | X Layer (196) | [`0xe0FBefbc7c2A5A793b15D51E552Ad142493c7294`](https://www.oklink.com/x-layer/address/0xe0FBefbc7c2A5A793b15D51E552Ad142493c7294) |
| OpenHypeExchange | X Layer (196) | [`0x8784607C6253EF77f16a361688f8767b3cDf9568`](https://www.oklink.com/x-layer/address/0x8784607C6253EF77f16a361688f8767b3cDf9568) |
| OpenHypeCollectible | X Layer testnet (1952) | [`0xD21a980E70d6663a49715Be2E39b068AfF56f11B`](https://www.oklink.com/x-layer-testnet/address/0xD21a980E70d6663a49715Be2E39b068AfF56f11B) |
| OpenHypeExchange | X Layer testnet (1952) | [`0x9F07a7408D03d90f7Ee77E51F2B4FcBf18ea5A21`](https://www.oklink.com/x-layer-testnet/address/0x9F07a7408D03d90f7Ee77E51F2B4FcBf18ea5A21) |

Source code is verified on OKLink.

## Development

Requires Node 22.

```sh
npm ci
npm test
```

Solidity 0.8.30, OpenZeppelin 5.4.0, Hardhat 2.26.3.

## Security

Please report vulnerabilities privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
