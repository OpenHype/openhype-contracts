// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {OpenHypeCollectible} from "../OpenHypeCollectible.sol";

/// @dev Test fixture only: proves storage survives a UUPS upgrade. The proxy is already
/// initialized by V1, so V2 needs no initializer of its own.
/// @custom:oz-upgrades-from OpenHypeCollectible
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract OpenHypeCollectibleV2Mock is OpenHypeCollectible {
    function version() external pure returns (uint256) {
        return 2;
    }
}
