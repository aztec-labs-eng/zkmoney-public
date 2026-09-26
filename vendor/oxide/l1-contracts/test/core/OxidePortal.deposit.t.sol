// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortal} from "@core/OxidePortal.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Caps} from "@core/Caps.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortalDepositTest is OxidePortalBase {
  function test_GivenPortalIsUninitialized_WhenDepositIsCalled() external {
    vm.expectRevert(Errors.OxidePortal__Uninitialized.selector);
    vm.prank(USER);
    portal.deposit(bytes32(uint256(1)), 10 ether);
  }

  function test_GivenAmountExceedsTxLimit_WhenDepositIsCalled() external givenPortalIsInitialized {
    vm.expectRevert(Errors.Caps__TxLimitSurpassed.selector);
    vm.prank(USER);
    portal.deposit(bytes32(uint256(1)), OxideConstants.TX_AMOUNT_CAP + 1);
  }

  function test_GivenPortalIsInitialized_WhenDepositIsCalled() external givenPortalIsInitialized {
    bytes32 recipientCommitment = bytes32(uint256(0xDEADBEEF));
    uint256 amount = 100 ether;
    bytes32 expectedContentHash = Hash.sha256ToField(abi.encodeWithSignature("deposit(uint256)", amount));
    bytes32 primedKey = bytes32(uint256(0x1234));
    uint256 primedIndex = 42;
    inbox.primeNext(primedKey, primedIndex);

    uint256 userBalanceBefore = underlying.balanceOf(USER);

    vm.expectEmit(true, true, true, true, address(portal));
    emit Deposit(recipientCommitment, amount, primedKey, primedIndex);

    vm.prank(USER);
    (bytes32 key, uint256 index, uint256 creditedAmount) = portal.deposit(recipientCommitment, amount);

    assertEq(key, primedKey);
    assertEq(index, primedIndex);
    assertEq(creditedAmount, amount);
    assertEq(underlying.balanceOf(USER), userBalanceBefore - amount);
    assertEq(underlying.balanceOf(address(portal)), amount);

    assertEq(inbox.callCount(), 1);
    (bytes32 recipientActor, uint256 recipientVersion, bytes32 contentHash, bytes32 secretHash) = inbox.calls(0);
    assertEq(recipientActor, L2_PORTAL);
    assertEq(recipientVersion, ROLLUP_VERSION);
    assertEq(contentHash, expectedContentHash);
    assertEq(secretHash, recipientCommitment);
    assertEq(portal.getCurrentAvailable(), GLOBAL_LIMIT - amount);
  }

  function test_GivenPortalIsFrozen_WhenDepositIsCalled() external givenPortalIsInitialized givenPortalIsFrozen {
    vm.expectRevert(Errors.OxidePortal__FrozenPortal.selector);
    vm.prank(USER);
    portal.deposit(bytes32(uint256(1)), 10 ether);
  }

  function test_GivenZeroRecipientCommitment_WhenDepositIsCalled() external givenPortalIsInitialized {
    vm.expectRevert(Errors.OxidePortal__ZeroRecipientCommitment.selector);
    vm.prank(USER);
    portal.deposit(bytes32(0), 10 ether);
  }

  function test_GivenZeroAmount_WhenDepositIsCalled() external givenPortalIsInitialized {
    vm.expectRevert(Errors.OxidePortal__AmountNotAboveFpcFundingCut.selector);
    vm.prank(USER);
    portal.deposit(bytes32(uint256(1)), 0);
  }
}

contract OxidePortalDepositFpcCutTest is OxidePortalBase {
  uint256 internal constant CUT = 10e16;

  function setUp() public override {
    fpcFundingCut = CUT;
    super.setUp();
  }

  function test_GivenAmountAboveCut_WhenDepositIsCalled() external givenPortalIsInitialized {
    bytes32 recipientCommitment = bytes32(uint256(0xDEADBEEF));
    uint256 amount = 100 ether;
    uint256 netAmount = amount - CUT;
    bytes32 expectedContentHash = Hash.sha256ToField(abi.encodeWithSignature("deposit(uint256)", netAmount));
    inbox.primeNext(bytes32(uint256(0x1234)), 42);

    vm.expectEmit(true, true, true, true, address(portal));
    emit Deposit(recipientCommitment, netAmount, bytes32(uint256(0x1234)), 42);

    vm.prank(USER);
    (,, uint256 creditedAmount) = portal.deposit(recipientCommitment, amount);

    assertEq(creditedAmount, netAmount);
    assertEq(underlying.balanceOf(address(portal)), netAmount);
    assertEq(underlying.balanceOf(FPC_FUNDER), CUT);
    (,, bytes32 contentHash,) = inbox.calls(0);
    assertEq(contentHash, expectedContentHash);
    assertEq(portal.getCurrentAvailable(), GLOBAL_LIMIT - netAmount);
  }

  function test_GivenAmountAtCut_WhenDepositIsCalled() external givenPortalIsInitialized {
    vm.expectRevert(Errors.OxidePortal__AmountNotAboveFpcFundingCut.selector);
    vm.prank(USER);
    portal.deposit(bytes32(uint256(1)), CUT);
  }
}
