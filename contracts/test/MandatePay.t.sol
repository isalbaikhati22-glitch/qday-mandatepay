// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandatePay} from "../src/MandatePay.sol";
import {MockUSD8} from "../src/MockUSD8.sol";

contract MandatePayTest is Test {
    MockUSD8 token;
    MandatePay mp;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address payee = makeAddr("payee");
    address stranger = makeAddr("stranger");

    uint256 constant PER_PAY = 2e6; // 2 tUSD8
    uint256 constant TOTAL = 5e6; // 5 tUSD8

    function setUp() public {
        token = new MockUSD8();
        mp = new MandatePay(address(token));
        token.mint(owner, 100e6);
        vm.prank(owner);
        token.approve(address(mp), type(uint256).max);
    }

    function _create(uint64 expiry) internal returns (uint256 id) {
        vm.prank(owner);
        id = mp.createMandate(agent, payee, PER_PAY, TOTAL, expiry, "API credits - research agent");
    }

    function _future() internal view returns (uint64) {
        return uint64(block.timestamp + 1 days);
    }

    // ------------------------------------------------------------ creation

    function test_create_escrowsAndRecords() public {
        uint256 id = _create(_future());
        assertEq(id, 0);
        assertEq(token.balanceOf(address(mp)), TOTAL, "escrow holds the total cap");
        assertEq(token.balanceOf(owner), 100e6 - TOTAL);

        MandatePay.Mandate memory m = mp.getMandate(id);
        assertEq(m.owner, owner);
        assertEq(m.agent, agent);
        assertEq(m.payee, payee);
        assertEq(m.perPaymentCap, PER_PAY);
        assertEq(m.totalCap, TOTAL);
        assertEq(m.spent, 0);
        assertEq(mp.remainingOf(id), TOTAL);
        assertEq(mp.statusOf(id), 0, "active");
        assertEq(mp.mandateIdsOfOwner(owner).length, 1);
        assertEq(mp.mandateIdsOfAgent(agent).length, 1);
    }

    function test_create_reverts() public {
        vm.startPrank(owner);
        vm.expectRevert(MandatePay.ZeroAddress.selector);
        mp.createMandate(address(0), payee, PER_PAY, TOTAL, _future(), "x");
        vm.expectRevert(MandatePay.ZeroAddress.selector);
        mp.createMandate(agent, address(0), PER_PAY, TOTAL, _future(), "x");
        vm.expectRevert(MandatePay.ZeroAmount.selector);
        mp.createMandate(agent, payee, 0, TOTAL, _future(), "x");
        vm.expectRevert(MandatePay.TotalCapBelowPerPaymentCap.selector);
        mp.createMandate(agent, payee, TOTAL, PER_PAY, _future(), "x");
        vm.expectRevert(MandatePay.ExpiryNotInFuture.selector);
        mp.createMandate(agent, payee, PER_PAY, TOTAL, uint64(block.timestamp), "x");
        vm.stopPrank();
    }

    function test_createWithPermit_oneTransaction() public {
        (address ownerKey, uint256 key) = makeAddrAndKey("permit-owner");
        token.mint(ownerKey, 100e6);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(token.PERMIT_TYPEHASH(), ownerKey, address(mp), TOTAL, token.nonces(ownerKey), deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);

        // No approve() call anywhere: the permit inside create must fund the escrow.
        vm.prank(ownerKey);
        uint256 id = mp.createMandateWithPermit(agent, payee, PER_PAY, TOTAL, _future(), "permit-funded", deadline, v, r, s);
        assertEq(token.balanceOf(address(mp)), TOTAL);
        assertEq(mp.getMandate(id).owner, ownerKey);
    }

    // ------------------------------------------------------------ payments

    function test_pay_happyPath() public {
        uint256 id = _create(_future());
        vm.expectEmit(true, true, true, true);
        emit MandatePay.PaymentExecuted(id, agent, payee, PER_PAY, PER_PAY, bytes32("invoice-1"));
        vm.prank(agent);
        mp.pay(id, PER_PAY, bytes32("invoice-1"));

        assertEq(token.balanceOf(payee), PER_PAY);
        assertEq(mp.getMandate(id).spent, PER_PAY);
        assertEq(mp.remainingOf(id), TOTAL - PER_PAY);
    }

    function test_pay_reverts() public {
        uint256 id = _create(_future());

        vm.prank(stranger);
        vm.expectRevert(MandatePay.NotAgent.selector);
        mp.pay(id, 1e6, bytes32(0));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(MandatePay.OverPerPaymentCap.selector, PER_PAY + 1, PER_PAY));
        mp.pay(id, PER_PAY + 1, bytes32(0));

        vm.prank(agent);
        vm.expectRevert(MandatePay.ZeroAmount.selector);
        mp.pay(id, 0, bytes32(0));

        // Spend 2 + 2, then 2 more exceeds the remaining 1 of the total cap.
        vm.startPrank(agent);
        mp.pay(id, PER_PAY, bytes32(0));
        mp.pay(id, PER_PAY, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(MandatePay.OverTotalCap.selector, PER_PAY, TOTAL - 2 * PER_PAY));
        mp.pay(id, PER_PAY, bytes32(0));
        vm.stopPrank();
    }

    function test_pay_expiredReverts() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        uint256 id = _create(expiry);
        vm.warp(expiry + 1);
        assertEq(mp.statusOf(id), 1, "expired");
        vm.prank(agent);
        vm.expectRevert(MandatePay.MandateExpired.selector);
        mp.pay(id, 1e6, bytes32(0));
    }

    // ------------------------------------------------------------ closing

    function test_revoke_refundsRemainderInstantly() public {
        uint256 id = _create(_future());
        vm.prank(agent);
        mp.pay(id, PER_PAY, bytes32(0));

        uint256 ownerBefore = token.balanceOf(owner);
        vm.prank(owner);
        mp.revoke(id);

        assertEq(token.balanceOf(owner), ownerBefore + (TOTAL - PER_PAY), "unspent escrow returned");
        assertEq(mp.statusOf(id), 2, "revoked");

        vm.prank(agent);
        vm.expectRevert(MandatePay.MandateNotActive.selector);
        mp.pay(id, 1e6, bytes32(0));

        vm.prank(owner);
        vm.expectRevert(MandatePay.MandateNotActive.selector);
        mp.revoke(id);
    }

    function test_revoke_onlyOwner() public {
        uint256 id = _create(_future());
        vm.prank(stranger);
        vm.expectRevert(MandatePay.NotOwner.selector);
        mp.revoke(id);
    }

    function test_settleExpired() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        uint256 id = _create(expiry);

        vm.prank(owner);
        vm.expectRevert(MandatePay.MandateNotExpired.selector);
        mp.settleExpired(id);

        vm.prank(agent);
        mp.pay(id, PER_PAY, bytes32(0));

        vm.warp(expiry + 1);
        uint256 ownerBefore = token.balanceOf(owner);
        vm.prank(owner);
        mp.settleExpired(id);
        assertEq(token.balanceOf(owner), ownerBefore + (TOTAL - PER_PAY));
        assertEq(mp.statusOf(id), 3, "settled");
    }

    // ------------------------------------------------------------ agent helpers

    function test_canPay_explains() public {
        uint256 id = _create(_future());
        (bool ok, string memory reason) = mp.canPay(id, PER_PAY);
        assertTrue(ok);
        assertEq(reason, "");

        (bool ok2, string memory reason2) = mp.canPay(id, PER_PAY + 1);
        assertFalse(ok2);
        assertEq(reason2, "amount exceeds the per-payment cap");
    }

    function test_multipleMandates_isolated() public {
        uint256 a = _create(_future());
        uint256 b = _create(_future());
        vm.prank(agent);
        mp.pay(a, PER_PAY, bytes32(0));
        assertEq(mp.getMandate(a).spent, PER_PAY);
        assertEq(mp.getMandate(b).spent, 0);
        assertEq(token.balanceOf(address(mp)), 2 * TOTAL - PER_PAY);
    }
}
