// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandatePay} from "../../src/MandatePay.sol";

interface ITUSD8 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function nonces(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32) external;
}

/// @notice Runs MandatePay against the REAL tUSD8 on a local fork of Aevum testnet.
///         No funds needed: `deal` writes balances into the fork only.
///         Run: forge test --match-path 'test/fork/*' --fork-url aevum
contract MandatePayForkTest is Test {
    ITUSD8 constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MandatePay mp;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address payee = makeAddr("payee");

    function setUp() public {
        // Skip (not fail) under a plain `forge test`: this suite needs the Aevum fork.
        if (block.chainid != 44005) vm.skip(true);
        mp = new MandatePay(address(TUSD8));
        deal(address(TUSD8), owner, 100e6);
        vm.prank(owner);
        TUSD8.approve(address(mp), type(uint256).max);
    }

    function test_fork_createPayRevoke_realTusd8() public {
        vm.prank(owner);
        uint256 id = mp.createMandate(agent, payee, 2e6, 5e6, uint64(block.timestamp + 1 days), "fork e2e");
        assertEq(TUSD8.balanceOf(address(mp)), 5e6);

        vm.prank(agent);
        mp.pay(id, 2e6, bytes32("invoice-fork-1"));
        assertEq(TUSD8.balanceOf(payee), 2e6);

        uint256 ownerBefore = TUSD8.balanceOf(owner);
        vm.prank(owner);
        mp.revoke(id);
        assertEq(TUSD8.balanceOf(owner), ownerBefore + 3e6, "remaining 3 tUSD8 refunded");
    }

    function test_fork_createWithPermit_realTusd8() public {
        (address signer, uint256 key) = makeAddrAndKey("permit-owner");
        deal(address(TUSD8), signer, 100e6);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, signer, address(mp), 5e6, TUSD8.nonces(signer), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", TUSD8.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        assertEq(TUSD8.allowance(signer, address(mp)), 0, "no allowance before");
        vm.prank(signer);
        uint256 id = mp.createMandateWithPermit(
            agent, payee, 2e6, 5e6, uint64(block.timestamp + 1 days), "permit fork", deadline, v, r, s
        );
        assertEq(TUSD8.balanceOf(address(mp)), 5e6);
        assertEq(mp.getMandate(id).owner, signer);
    }
}
