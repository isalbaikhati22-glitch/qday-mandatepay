// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MandatePay} from "../src/MandatePay.sol";
import {MockUSD8} from "../src/MockUSD8.sol";

/// @notice Deploys MandatePay.
/// @dev Aevum testnet (real tUSD8):
///        TOKEN=0x456569838f1d43009A91ebA4263147Afd7233483 \
///        forge script script/Deploy.s.sol --rpc-url aevum --broadcast --legacy \
///          --private-key $DEPLOYER_PRIVATE_KEY
///      Local anvil (deploys a MockUSD8 first when TOKEN is unset):
///        forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///          --private-key $DEPLOYER_PRIVATE_KEY
contract Deploy is Script {
    function run() external {
        address token = vm.envOr("TOKEN", address(0));
        vm.startBroadcast();
        if (token == address(0)) {
            MockUSD8 mock = new MockUSD8();
            token = address(mock);
            console.log("MockUSD8 deployed:", token);
        }
        MandatePay mp = new MandatePay(token);
        vm.stopBroadcast();
        console.log("MandatePay deployed:", address(mp));
        console.log("Token:", token);
        console.log("Chain ID:", block.chainid);
    }
}
