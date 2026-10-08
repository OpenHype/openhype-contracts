// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// Test fixture only: compiles ERC1967Proxy so integration tests can deploy
// OpenHypeCollectible behind a proxy without the Hardhat upgrades plugin.
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
