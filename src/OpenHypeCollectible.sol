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
 *  OpenHype Collectibles
 *
 *  Every token is one physical trading card held in the OpenHype vault.
 *  tokenId is the card's permanent inventory identity.
 *
 *  - Cards are locked (ERC-5192): holders cannot approve or transfer them directly.
 *  - The platform mirrors ownership from the OpenHype app: it mints when a card is
 *    delivered to a collector or pre-minted into the inventory, moves it whenever it changes
 *    hands in the app, and burns it when the physical card is shipped to its owner.
 *  - A holder can consent to a move by signing an EIP-712 TransferWithAuthorization
 *    (modelled on EIP-3009); the platform relays it and pays the gas.
 *  - A burned tokenId can never be minted again. A tokenId stands for one stay of the card
 *    in the vault: a card deposited again later is a new inventory unit with a new tokenId.
 *  - Token metadata includes the grading certificate, verifiable with the grader;
 *    collection metadata is published through contractURI (ERC-7572), and metadata
 *    changes are announced with ERC-4906 events.
 *  - A card's identity and grading can be recorded on chain once (CardRecorded), so they stay
 *    fixed whatever the metadata later says; only the admin can correct a record (CardCorrected).
 */

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @title OpenHype Collectibles
/// @notice Non-transferable ERC-721 for vaulted physical cards, moved only by the platform.
/// @custom:security-contact team@binatir.com
contract OpenHypeCollectible is
    ERC721Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    string private constant NAME = "OpenHype Collectibles";
    string private constant SYMBOL = "OHC";

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @notice Can pause but not unpause: a fast emergency stop that does not wait for the admin.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 tokenId,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    string private baseURI_;
    /// @dev A burned token left the vault as a physical card and is never minted again.
    mapping(uint256 => bool) public burned;
    /// @notice Whether an authorizer's nonce was used or cancelled (EIP-3009 semantics).
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    string private contractURI_;
    /// @dev Display owner for marketplaces (`owner()`); grants nothing on chain.
    address private owner_;
    /// @notice keccak256(abi.encode(card, grader, certNumber, grade)) of a token's card record; zero until recorded.
    mapping(uint256 => bytes32) public cardRecordHash;

    /// @notice What a token stands for: `card` identifies the card in one readable string (e.g. game | set | number |
    /// name | language | variant); `grader`, `certNumber` and `grade` are set for a graded card and empty otherwise.
    struct CardRecord {
        string card;
        string grader;
        string certNumber;
        string grade;
    }

    error NonTransferable();
    error TokenBurned(uint256 tokenId);
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationUsedOrCanceled(address authorizer, bytes32 nonce);
    error InvalidSignature();
    error LengthMismatch();
    error InvalidCardRecord(uint256 tokenId);
    error CardAlreadyRecorded(uint256 tokenId);
    error CardNotRecorded(uint256 tokenId);

    /// @dev ERC-5192
    event Locked(uint256 tokenId);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    /// @dev ERC-7572
    event ContractURIUpdated();
    /// @dev Same signature as Ownable / ERC-173, so marketplaces index owner changes.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    /// @dev ERC-4906
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
    /// @notice A token's card record, written once: verify a graded card's `certNumber` with its `grader`.
    event CardRecorded(uint256 indexed tokenId, string card, string grader, string certNumber, string grade);
    /// @notice The admin replaced a token's card record; the earlier CardRecorded / CardCorrected stays on chain.
    event CardCorrected(uint256 indexed tokenId, string card, string grader, string certNumber, string grade);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param uri Token metadata base URI: tokenURI is this plus the decimal tokenId.
    /// @param collectionURI Collection metadata (ERC-7572), so a Safe-administered deployment
    /// shows its name and image from the start.
    function initialize(address admin, address relayer, string calldata uri, string calldata collectionURI)
        external
        initializer
    {
        __ERC721_init(NAME, SYMBOL);
        __AccessControl_init();
        __Pausable_init();
        __EIP712_init(_EIP712Name(), _EIP712Version());
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, relayer);
        _grantRole(OPERATOR_ROLE, relayer);
        baseURI_ = uri;
        contractURI_ = collectionURI;
        emit ContractURIUpdated();
        _setOwner(admin);
    }

    // ---------------------------------------------------------------- platform moves

    function mint(address to, uint256 tokenId) external onlyRole(MINTER_ROLE) whenNotPaused {
        _mintLocked(to, tokenId);
    }

    /// @notice Pre-mints tokens, usually into the inventory address.
    function mintBatch(address to, uint256[] calldata tokenIds) external onlyRole(MINTER_ROLE) whenNotPaused {
        for (uint256 i = 0; i < tokenIds.length; i++) _mintLocked(to, tokenIds[i]);
    }

    function operatorTransfer(address from, address to, uint256 tokenId) external onlyRole(OPERATOR_ROLE) whenNotPaused {
        _transfer(from, to, tokenId);
    }

    /// @notice Physical redemption: the card is shipped and its token is retired for good.
    function burn(uint256 tokenId) external onlyRole(OPERATOR_ROLE) whenNotPaused {
        _burn(tokenId);
        burned[tokenId] = true;
    }

    // ---------------------------------------------------------------- card records

    /// @notice Records what each token stands for, once per token: a token that already has a record reverts.
    /// The token must exist or have been burned (a record can be added for a card already shipped).
    function recordCards(uint256[] calldata tokenIds, CardRecord[] calldata records)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
    {
        if (tokenIds.length != records.length) revert LengthMismatch();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 tokenId = tokenIds[i];
            if (cardRecordHash[tokenId] != 0) revert CardAlreadyRecorded(tokenId);
            if (_ownerOf(tokenId) == address(0) && !burned[tokenId]) revert ERC721NonexistentToken(tokenId);
            CardRecord calldata r = records[i];
            cardRecordHash[tokenId] = _cardRecordHash(tokenId, r);
            emit CardRecorded(tokenId, r.card, r.grader, r.certNumber, r.grade);
        }
    }

    /// @notice Replaces a token's card record, e.g. a certificate number entered wrongly. Admin only.
    function correctCard(uint256 tokenId, CardRecord calldata record) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (cardRecordHash[tokenId] == 0) revert CardNotRecorded(tokenId);
        cardRecordHash[tokenId] = _cardRecordHash(tokenId, record);
        emit CardCorrected(tokenId, record.card, record.grader, record.certNumber, record.grade);
    }

    // ---------------------------------------------------------------- holder consent

    /// @notice Moves a card with its holder's EIP-712 consent. Relayed by the platform, which pays gas.
    /// @param signature 65-byte ECDSA signature of an EOA, or an ERC-1271 signature of a contract wallet.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 tokenId,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external onlyRole(OPERATOR_ROLE) whenNotPaused {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        _useAuthorization(from, nonce);
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, tokenId, validAfter, validBefore, nonce)
        );
        if (!_isValidSignature(from, _hashTypedDataV4(structHash), signature)) revert InvalidSignature();
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, tokenId);
    }

    /// @notice Revokes a signed authorization that has not been used. Anyone may submit it.
    function cancelAuthorization(address authorizer, bytes32 nonce, bytes calldata signature) external {
        _useAuthorization(authorizer, nonce);
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        if (!_isValidSignature(authorizer, _hashTypedDataV4(structHash), signature)) revert InvalidSignature();
        emit AuthorizationCanceled(authorizer, nonce);
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------- locked token (ERC-5192)

    function locked(uint256 tokenId) external view returns (bool) {
        _requireOwned(tokenId);
        return true;
    }

    function approve(address, uint256) public pure override {
        revert NonTransferable();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert NonTransferable();
    }

    /// @dev Both safeTransferFrom overloads route through transferFrom.
    function transferFrom(address, address, uint256) public pure override {
        revert NonTransferable();
    }

    // ---------------------------------------------------------------- admin

    function setBaseURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseURI_ = uri;
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    /// @notice Collection metadata (ERC-7572): name, description, image, banner and links.
    function contractURI() external view returns (string memory) {
        return contractURI_;
    }

    function setContractURI(string calldata uri) external onlyRole(DEFAULT_ADMIN_ROLE) {
        contractURI_ = uri;
        emit ContractURIUpdated();
    }

    // ---------------------------------------------------------------- metadata refresh (ERC-4906)

    /// @notice Asks explorers and wallets to re-read these tokens' metadata (image, grade or
    /// certificate changed off chain). tokenIds are sparse, so there is no range form.
    function refreshMetadata(uint256[] calldata tokenIds) external onlyOperatorOrAdmin {
        for (uint256 i = 0; i < tokenIds.length; i++) emit MetadataUpdate(tokenIds[i]);
    }

    /// @notice Asks explorers and wallets to re-read every token's metadata.
    function refreshAllMetadata() external onlyOperatorOrAdmin {
        emit BatchMetadataUpdate(0, type(uint256).max);
    }

    /// @notice The account marketplaces treat as the collection's owner (EIP-5313 `owner()`), e.g. to edit
    /// the collection page. It grants no permission in this contract: DEFAULT_ADMIN_ROLE holds all control
    /// and decides who the owner is.
    function owner() external view returns (address) {
        return owner_;
    }

    function setOwner(address newOwner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setOwner(newOwner);
    }

    /// @notice Stops every platform move. A pauser or the admin can pause; only the admin unpauses.
    function pause() external onlyPauserOrAdmin {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @dev Constant, like the EIP-712 domain: a proxy initialized under an earlier name reports this one
    /// after an upgrade without re-initializing.
    function name() public pure override returns (string memory) {
        return NAME;
    }

    function symbol() public pure override returns (string memory) {
        return SYMBOL;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        // ERC-5192 (locked) and ERC-4906 (metadata update events).
        return interfaceId == 0xb45a3c0e || interfaceId == 0x49064906 || super.supportsInterface(interfaceId);
    }

    // ---------------------------------------------------------------- internal

    modifier onlyOperatorOrAdmin() {
        if (!hasRole(OPERATOR_ROLE, _msgSender())) _checkRole(DEFAULT_ADMIN_ROLE);
        _;
    }

    modifier onlyPauserOrAdmin() {
        if (!hasRole(PAUSER_ROLE, _msgSender())) _checkRole(DEFAULT_ADMIN_ROLE);
        _;
    }

    function _mintLocked(address to, uint256 tokenId) private {
        if (burned[tokenId]) revert TokenBurned(tokenId);
        _mint(to, tokenId);
        emit Locked(tokenId);
    }

    /// @dev A card is always identified; a grading names both its grader and its certificate, and a grade only with them.
    function _cardRecordHash(uint256 tokenId, CardRecord calldata r) private pure returns (bytes32) {
        bool graded = bytes(r.grader).length > 0;
        if (bytes(r.card).length == 0 || graded != (bytes(r.certNumber).length > 0) || (!graded && bytes(r.grade).length > 0))
            revert InvalidCardRecord(tokenId);
        return keccak256(abi.encode(r.card, r.grader, r.certNumber, r.grade));
    }

    function _setOwner(address newOwner) private {
        emit OwnershipTransferred(owner_, newOwner);
        owner_ = newOwner;
    }

    function _useAuthorization(address authorizer, bytes32 nonce) private {
        if (authorizationState[authorizer][nonce]) revert AuthorizationUsedOrCanceled(authorizer, nonce);
        authorizationState[authorizer][nonce] = true;
    }

    /// @dev ECDSA first, ERC-1271 only for accounts with code whose ECDSA check failed: an EIP-7702
    /// delegated EOA has code but still signs with its key. Kept local instead of SignatureChecker so
    /// the contract compiles for pre-Cancun EVMs.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        (address recovered, ECDSA.RecoverError error, ) = ECDSA.tryRecover(digest, signature);
        if (error == ECDSA.RecoverError.NoError && recovered == signer) return true;
        if (signer.code.length == 0) return false;
        (bool ok, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        return ok && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    /// @dev Constant domain: proxies deployed before EIP-712 was added upgrade in place without re-initializing.
    function _EIP712Name() internal pure override returns (string memory) {
        return NAME;
    }

    function _EIP712Version() internal pure override returns (string memory) {
        return "1";
    }

    function _baseURI() internal view override returns (string memory) {
        return baseURI_;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
