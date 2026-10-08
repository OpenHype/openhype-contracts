// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/*
 *   ██████╗ ██████╗ ███████╗███╗   ██╗██╗  ██╗██╗   ██╗██████╗ ███████╗
 *  ██╔═══██╗██╔══██╗██╔════╝████╗  ██║██║  ██║╚██╗ ██╔╝██╔══██╗██╔════╝
 *  ██║   ██║██████╔╝█████╗  ██╔██╗ ██║███████║ ╚████╔╝ ██████╔╝█████╗
 *  ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██╔══██║  ╚██╔╝  ██╔═══╝ ██╔══╝
 *  ╚██████╔╝██║     ███████╗██║ ╚████║██║  ██║   ██║   ██║     ███████╗
 *   ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝   ╚═╝   ╚═╝     ╚══════╝
 *
 *  OpenHype Exchange
 *
 *  Settles trades of OpenHype Collectibles against stablecoin payments, one transaction per trade:
 *  the payment and the token transfers happen together, and every token traded emits one Trade event
 *  with its own price.
 *
 *  - Purchases: a buyer signs an ERC-3009 receiveWithAuthorization, which only this contract can
 *    redeem; nothing moves until the operator settles it. Settlement takes the payment, sends it to
 *    the proceeds recipient and delivers the tokens from the platform inventory (minting tokens that
 *    do not exist yet), all in one transaction. The part of the price for items delivered later (not
 *    tokens of this transaction) is reported by a Paid event. The contract never holds funds between trades.
 *  - Asks: a holder sells tokens at a price; a taker fills the ask with its own funds and the
 *    tokens move to the inventory. Asks can carry the seller's EIP-712 signature, which becomes
 *    mandatory once askSignatureRequired is set.
 *  - Users never need gas: the platform submits every transaction.
 */

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice ERC-3009 receiveWithAuthorization with a bytes signature (ECDSA or ERC-1271).
interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

/// @notice The parts of OpenHype Collectibles this contract uses; it holds the collection's
/// minter and operator roles.
interface IOpenHypeCollection {
    function ownerOf(uint256 tokenId) external view returns (address);
    function mint(address to, uint256 tokenId) external;
    function operatorTransfer(address from, address to, uint256 tokenId) external;
}

/// @title OpenHype Exchange
/// @notice Settles OpenHype Collectibles trades against ERC-20 payments, one transaction per trade.
/// @custom:security-contact team@binatir.com
contract OpenHypeExchange is
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    string private constant NAME = "OpenHype Exchange";

    /// @notice Settles purchases.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @notice Fills asks, paying sellers from its own balance.
    bytes32 public constant TAKER_ROLE = keccak256("TAKER_ROLE");

    bytes32 public constant ASK_TYPEHASH = keccak256(
        "Ask(bytes32 askId,address seller,uint256[] tokenIds,uint256[] prices,address currency,uint256 price,uint256 validBefore)"
    );

    /// @notice Most tokens a single trade can move.
    uint256 public constant MAX_TRADE_TOKENS = 50;

    /// @notice An ask: `prices[i]` is the price of `tokenIds[i]`, and `price` their sum.
    struct Ask {
        bytes32 askId;
        address seller;
        uint256[] tokenIds;
        uint256[] prices;
        address currency;
        uint256 price;
        uint256 validBefore;
    }

    /// @notice A purchase; the buyer's ERC-3009 authorization of `price` uses `orderId` as its nonce.
    /// `prices[i]` is the price of `tokenIds[i]`; the rest of `price` pays for items delivered later (may be all
    /// of it, with no tokens).
    struct Purchase {
        bytes32 orderId;
        address buyer;
        uint256[] tokenIds;
        uint256[] prices;
        address currency;
        uint256 price;
        uint256 validAfter;
        uint256 validBefore;
    }

    /// @notice An upgrade: `owner` gives `sourceTokenIds` back to the inventory and receives `targetTokenIds`
    /// (empty when the upgrade was lost). No payment moves.
    struct Upgrade {
        bytes32 upgradeId;
        address owner;
        uint256[] sourceTokenIds;
        uint256[] targetTokenIds;
    }

    /// @notice A delivery of inventory tokens to `to` with no payment (e.g. a game's prize).
    struct Delivery {
        bytes32 deliveryId;
        address to;
        uint256[] tokenIds;
    }

    /// @notice Caps on what the taker can pay out, per currency (in the currency's units). A currency
    /// without a configured cap cannot be used for asks. Fills add to `windowUsed`, which drains at `maxPerWindow`
    /// per `window` from `windowStart` (its last update); a fill fits while `windowUsed` stays within
    /// `maxPerWindow`. Any period of length `t` pays out at most `maxPerWindow * (1 + t / window)`, so never more
    /// than `maxPerWindow` in a burst.
    struct TakerLimit {
        uint128 maxPerFill;
        uint128 maxPerWindow;
        uint64 window;
        uint64 windowStart;
        uint128 windowUsed;
    }

    struct InitConfig {
        address collection;
        address inventory;
        address proceedsRecipient;
        address[] currencies;
        uint128[] takerMaxPerFill;
        uint128[] takerMaxPerWindow;
        uint64 takerWindow;
    }

    /// @custom:storage-location erc7201:openhype.storage.Exchange
    struct ExchangeStorage {
        IOpenHypeCollection collection;
        address inventory;
        address proceedsRecipient;
        bool askSignatureRequired;
        mapping(address => bool) currencyAllowed;
        mapping(address => TakerLimit) takerLimits;
        /// @dev Ids of purchases, asks, upgrades and deliveries (one id space), so an order id is never reused.
        mapping(bytes32 => bool) orderIdUsed;
    }

    // keccak256(abi.encode(uint256(keccak256("openhype.storage.Exchange")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0x45b2325310d41ce1a57ad07b2fde57329079ee598a2fa9c36a45326e856b0700;

    /// @notice One per token traded: `seller` sold `tokenId` of `collection` to `buyer` for `price` of `currency`.
    event Trade(
        bytes32 indexed orderId,
        address indexed seller,
        address indexed buyer,
        address collection,
        uint256 tokenId,
        address currency,
        uint256 price
    );
    /// @notice The part of a purchase paid for items delivered later rather than tokens traded in it.
    event Paid(bytes32 indexed orderId, address indexed buyer, address currency, uint256 amount);
    /// @notice An upgrade settled: `owner` gave `sourceTokenIds` back and received `targetTokenIds`.
    event Upgraded(
        bytes32 indexed upgradeId,
        address indexed owner,
        address collection,
        uint256[] sourceTokenIds,
        uint256[] targetTokenIds
    );
    /// @notice Inventory tokens delivered to `to` in one transaction, with no payment.
    event Delivered(bytes32 indexed deliveryId, address indexed to, address collection, uint256[] tokenIds);
    event InventoryUpdated(address inventory);
    event ProceedsRecipientUpdated(address proceedsRecipient);
    event CurrencyAllowed(address indexed currency, bool allowed);
    event AskSignatureRequiredUpdated(bool required);
    event TakerLimitUpdated(address indexed currency, uint128 maxPerFill, uint128 maxPerWindow, uint64 window);

    error ZeroAddress();
    error InvalidSeller();
    error InvalidBuyer();
    error InvalidAmount();
    error LengthMismatch();
    error CurrencyNotAllowed(address currency);
    error OrderIdUsed(bytes32 orderId);
    error EmptyTrade();
    error TooManyTokens();
    error NotInInventory(uint256 tokenId);
    error PaymentMismatch();
    error PricesMismatch();
    error AskExpired();
    error SignatureRequired();
    error InvalidSignature();
    error TakerLimitNotSet(address currency);
    error TakerLimitExceeded();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address operator, address taker, InitConfig calldata config)
        external
        initializer
    {
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __EIP712_init(NAME, "1");
        if (admin == address(0) || operator == address(0) || taker == address(0)) revert ZeroAddress();
        if (config.collection == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
        _grantRole(TAKER_ROLE, taker);
        _storage().collection = IOpenHypeCollection(config.collection);
        _setInventory(config.inventory);
        _setProceedsRecipient(config.proceedsRecipient);
        uint256 n = config.currencies.length;
        if (config.takerMaxPerFill.length != n || config.takerMaxPerWindow.length != n) revert LengthMismatch();
        for (uint256 i = 0; i < n; i++) {
            _setCurrencyAllowed(config.currencies[i], true);
            _setTakerLimit(config.currencies[i], config.takerMaxPerFill[i], config.takerMaxPerWindow[i], config.takerWindow);
        }
    }

    // ---------------------------------------------------------------- asks

    /// @notice Fills an ask: the seller's tokens move to the inventory and the taker pays the seller
    /// `price` from its own balance (it approves this contract). `sellerSignature` is the seller's
    /// EIP-712 signature of the ask; it may be empty only while askSignatureRequired is false.
    function fillAsk(Ask calldata ask, bytes calldata sellerSignature)
        external
        onlyRole(TAKER_ROLE)
        whenNotPaused
        nonReentrant
    {
        ExchangeStorage storage $ = _storage();
        address stock = $.inventory;
        if (ask.seller == address(0) || ask.seller == stock) revert InvalidSeller();
        if (ask.price == 0) revert InvalidAmount();
        if (ask.tokenIds.length == 0) revert EmptyTrade();
        if (ask.tokenIds.length > MAX_TRADE_TOKENS) revert TooManyTokens();
        if (_sum(ask.tokenIds, ask.prices) != ask.price) revert PricesMismatch();
        if (block.timestamp >= ask.validBefore) revert AskExpired();
        _requireCurrency($, ask.currency);
        _requireNewOrderId($, ask.askId);
        if (sellerSignature.length > 0) {
            if (!_isValidSignature(ask.seller, _hashTypedDataV4(_askStructHash(ask)), sellerSignature)) {
                revert InvalidSignature();
            }
        } else if ($.askSignatureRequired) {
            revert SignatureRequired();
        }
        _useTakerLimit($, ask.currency, ask.price);
        $.orderIdUsed[ask.askId] = true;

        IOpenHypeCollection nft = $.collection;
        for (uint256 i = 0; i < ask.tokenIds.length; i++) {
            nft.operatorTransfer(ask.seller, stock, ask.tokenIds[i]);
        }
        IERC20(ask.currency).safeTransferFrom(_msgSender(), ask.seller, ask.price);
        _emitTrades(ask.askId, ask.seller, stock, address(nft), ask.tokenIds, ask.prices, ask.currency);
    }

    /// @notice EIP-712 digest a seller signs for `ask`.
    function hashAsk(Ask calldata ask) external view returns (bytes32) {
        return _hashTypedDataV4(_askStructHash(ask));
    }

    // ---------------------------------------------------------------- purchases

    /// @notice Settles a purchase: takes the buyer's ERC-3009 authorization to this contract (its nonce is
    /// the order id), pays the proceeds recipient and delivers `tokenIds` from the inventory to the buyer,
    /// minting tokens that do not exist yet. With no tokens it only takes the payment (items delivered later).
    function buyWithAuthorization(Purchase calldata purchase, bytes calldata signature)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        ExchangeStorage storage $ = _storage();
        if (purchase.buyer == address(0)) revert ZeroAddress();
        if (purchase.buyer == $.inventory) revert InvalidBuyer();
        if (purchase.price == 0) revert InvalidAmount();
        if (purchase.tokenIds.length > MAX_TRADE_TOKENS) revert TooManyTokens();
        uint256 traded = _sum(purchase.tokenIds, purchase.prices);
        if (traded > purchase.price) revert PricesMismatch();
        _requireCurrency($, purchase.currency);
        _requireNewOrderId($, purchase.orderId);
        $.orderIdUsed[purchase.orderId] = true;
        _receive(
            purchase.currency,
            purchase.buyer,
            purchase.price,
            purchase.validAfter,
            purchase.validBefore,
            purchase.orderId,
            signature
        );
        _deliver($, purchase.buyer, purchase.tokenIds);
        IERC20(purchase.currency).safeTransfer($.proceedsRecipient, purchase.price);
        _emitTrades(
            purchase.orderId,
            $.inventory,
            purchase.buyer,
            address($.collection),
            purchase.tokenIds,
            purchase.prices,
            purchase.currency
        );
        if (traded < purchase.price) {
            emit Paid(purchase.orderId, purchase.buyer, purchase.currency, purchase.price - traded);
        }
    }

    // ---------------------------------------------------------------- upgrades

    /// @notice Settles an upgrade in one transaction: the owner's source tokens move to the inventory and the
    /// targets move from the inventory to the owner (minted when they do not exist yet). The id is used once.
    function settleUpgrade(Upgrade calldata upgrade) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        ExchangeStorage storage $ = _storage();
        address stock = $.inventory;
        if (upgrade.owner == address(0) || upgrade.owner == stock) revert InvalidSeller();
        uint256 moved = upgrade.sourceTokenIds.length + upgrade.targetTokenIds.length;
        if (upgrade.sourceTokenIds.length == 0) revert EmptyTrade();
        if (moved > MAX_TRADE_TOKENS) revert TooManyTokens();
        _requireNewOrderId($, upgrade.upgradeId);
        $.orderIdUsed[upgrade.upgradeId] = true;

        IOpenHypeCollection nft = $.collection;
        for (uint256 i = 0; i < upgrade.sourceTokenIds.length; i++) {
            nft.operatorTransfer(upgrade.owner, stock, upgrade.sourceTokenIds[i]);
        }
        _deliver($, upgrade.owner, upgrade.targetTokenIds);
        emit Upgraded(upgrade.upgradeId, upgrade.owner, address(nft), upgrade.sourceTokenIds, upgrade.targetTokenIds);
    }

    /// @notice Delivers inventory tokens to `to` in one transaction (minting those that do not exist yet), with no
    /// payment. The id is used once.
    function deliver(Delivery calldata delivery) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        ExchangeStorage storage $ = _storage();
        if (delivery.to == address(0) || delivery.to == $.inventory) revert InvalidSeller();
        if (delivery.tokenIds.length == 0) revert EmptyTrade();
        if (delivery.tokenIds.length > MAX_TRADE_TOKENS) revert TooManyTokens();
        _requireNewOrderId($, delivery.deliveryId);
        $.orderIdUsed[delivery.deliveryId] = true;
        _deliver($, delivery.to, delivery.tokenIds);
        emit Delivered(delivery.deliveryId, delivery.to, address($.collection), delivery.tokenIds);
    }

    // ---------------------------------------------------------------- views

    function collection() external view returns (address) {
        return address(_storage().collection);
    }

    function inventory() external view returns (address) {
        return _storage().inventory;
    }

    function proceedsRecipient() external view returns (address) {
        return _storage().proceedsRecipient;
    }

    function askSignatureRequired() external view returns (bool) {
        return _storage().askSignatureRequired;
    }

    function isCurrencyAllowed(address currency) external view returns (bool) {
        return _storage().currencyAllowed[currency];
    }

    function takerLimit(address currency) external view returns (TakerLimit memory) {
        return _storage().takerLimits[currency];
    }

    /// @notice Whether an id was used by a purchase, an ask, an upgrade or a delivery.
    function isOrderIdUsed(bytes32 orderId) external view returns (bool) {
        return _storage().orderIdUsed[orderId];
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------- admin

    function setInventory(address newInventory) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setInventory(newInventory);
    }

    function setProceedsRecipient(address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setProceedsRecipient(recipient);
    }

    function setCurrencyAllowed(address currency, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setCurrencyAllowed(currency, allowed);
    }

    function setAskSignatureRequired(bool required) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _storage().askSignatureRequired = required;
        emit AskSignatureRequiredUpdated(required);
    }

    function setTakerLimit(address currency, uint128 maxPerFill, uint128 maxPerWindow, uint64 window)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setTakerLimit(currency, maxPerFill, maxPerWindow, window);
    }

    /// @notice Sends tokens sent to this contract by mistake to the proceeds recipient (it holds no funds
    /// between trades).
    function recoverERC20(address currency) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        ExchangeStorage storage $ = _storage();
        uint256 balance = IERC20(currency).balanceOf(address(this));
        if (balance > 0) IERC20(currency).safeTransfer($.proceedsRecipient, balance);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------- internal

    function _storage() private pure returns (ExchangeStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }

    function _requireCurrency(ExchangeStorage storage $, address currency) private view {
        if (!$.currencyAllowed[currency]) revert CurrencyNotAllowed(currency);
    }

    function _requireNewOrderId(ExchangeStorage storage $, bytes32 orderId) private view {
        if ($.orderIdUsed[orderId]) revert OrderIdUsed(orderId);
    }

    /// @dev Receives exactly `amount` from `from` with an authorization only this contract can redeem.
    function _receive(
        address currency,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) private {
        uint256 before = IERC20(currency).balanceOf(address(this));
        IERC3009Receive(currency).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, signature
        );
        if (IERC20(currency).balanceOf(address(this)) - before != amount) revert PaymentMismatch();
    }

    /// @dev Moves inventory tokens to `buyer`, minting those that do not exist yet.
    function _deliver(ExchangeStorage storage $, address buyer, uint256[] calldata tokenIds) private {
        address stock = $.inventory;
        IOpenHypeCollection nft = $.collection;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            try nft.ownerOf(tokenId) returns (address holder) {
                if (holder != stock) revert NotInInventory(tokenId);
                nft.operatorTransfer(stock, buyer, tokenId);
            } catch {
                nft.mint(buyer, tokenId);
            }
        }
    }

    function _useTakerLimit(ExchangeStorage storage $, address currency, uint256 price) private {
        TakerLimit storage limit = $.takerLimits[currency];
        if (limit.maxPerFill == 0) revert TakerLimitNotSet(currency);
        if (price > limit.maxPerFill) revert TakerLimitExceeded();
        // A set maxPerFill implies a non-zero window (_setTakerLimit).
        uint256 drained = (block.timestamp - limit.windowStart) * limit.maxPerWindow / limit.window;
        uint256 used = (drained >= limit.windowUsed ? 0 : limit.windowUsed - drained) + price;
        if (used > limit.maxPerWindow) revert TakerLimitExceeded();
        limit.windowStart = uint64(block.timestamp);
        limit.windowUsed = uint128(used);
    }

    /// @dev The sum of `prices`, which must name one price per token.
    function _sum(uint256[] calldata tokenIds, uint256[] calldata prices) private pure returns (uint256 total) {
        if (prices.length != tokenIds.length) revert PricesMismatch();
        for (uint256 i = 0; i < prices.length; i++) total += prices[i];
    }

    function _emitTrades(
        bytes32 orderId,
        address seller,
        address buyer,
        address nft,
        uint256[] calldata tokenIds,
        uint256[] calldata prices,
        address currency
    ) private {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            emit Trade(orderId, seller, buyer, nft, tokenIds[i], currency, prices[i]);
        }
    }

    function _askStructHash(Ask calldata ask) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ASK_TYPEHASH,
                ask.askId,
                ask.seller,
                keccak256(abi.encodePacked(ask.tokenIds)),
                keccak256(abi.encodePacked(ask.prices)),
                ask.currency,
                ask.price,
                ask.validBefore
            )
        );
    }

    function _setInventory(address newInventory) private {
        if (newInventory == address(0)) revert ZeroAddress();
        _storage().inventory = newInventory;
        emit InventoryUpdated(newInventory);
    }

    function _setProceedsRecipient(address recipient) private {
        if (recipient == address(0)) revert ZeroAddress();
        _storage().proceedsRecipient = recipient;
        emit ProceedsRecipientUpdated(recipient);
    }

    function _setCurrencyAllowed(address currency, bool allowed) private {
        if (currency == address(0)) revert ZeroAddress();
        _storage().currencyAllowed[currency] = allowed;
        emit CurrencyAllowed(currency, allowed);
    }

    /// @dev A zero maxPerFill disables asks in that currency.
    function _setTakerLimit(address currency, uint128 maxPerFill, uint128 maxPerWindow, uint64 window) private {
        if (currency == address(0)) revert ZeroAddress();
        if (maxPerFill > maxPerWindow || (maxPerFill > 0 && window == 0)) revert InvalidAmount();
        TakerLimit storage limit = _storage().takerLimits[currency];
        limit.maxPerFill = maxPerFill;
        limit.maxPerWindow = maxPerWindow;
        limit.window = window;
        emit TakerLimitUpdated(currency, maxPerFill, maxPerWindow, window);
    }

    /// @dev ECDSA first, ERC-1271 only for accounts with code whose ECDSA check failed: an EIP-7702
    /// delegated EOA has code but still signs with its key.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        (address recovered, ECDSA.RecoverError error, ) = ECDSA.tryRecover(digest, signature);
        if (error == ECDSA.RecoverError.NoError && recovered == signer) return true;
        if (signer.code.length == 0) return false;
        (bool ok, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        return ok && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
