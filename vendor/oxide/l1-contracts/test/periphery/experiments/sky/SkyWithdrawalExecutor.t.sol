// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {PlainWithdrawalExecutor} from "@periphery/PlainWithdrawalExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";
import {SkyWithdrawalExecutor} from "@periphery/experiments/sky/SkyWithdrawalExecutor.sol";
import {SkyErrors} from "@periphery/experiments/sky/SkyErrors.sol";
import {SkyRoute} from "@periphery/experiments/sky/SkyTypes.sol";
import {IDaiUsds} from "@periphery/experiments/sky/interfaces/IDaiUsds.sol";
import {ISUsds} from "@periphery/experiments/sky/interfaces/ISUsds.sol";
import {SkyTestBase} from "@test/periphery/experiments/sky/SkyTestBase.sol";
import {MockDaiUsds} from "@test/periphery/experiments/sky/mocks/MockDaiUsds.sol";
import {MockSUsds} from "@test/periphery/experiments/sky/mocks/MockSUsds.sol";
import {ReenteringSUsds} from "@test/periphery/experiments/sky/mocks/ReenteringSUsds.sol";

contract SkyWithdrawalExecutorTest is SkyTestBase {
  IExecutor.Flow internal constant WITHDRAWAL = IExecutor.Flow.Withdrawal;

  bytes internal constant NO_RELAYER = abi.encodePacked(address(0));

  event SharesSettlement(IExecutor.Flow indexed flow, address indexed recipient, uint256 shares);

  function test_GivenTheExecutor_ThenItAdvertisesDaiAsThePayoutToken() external view {
    assertEq(address(skyExecutor.ASSET()), address(dai));
    assertEq(skyExecutor.PORTAL(), address(sUsdsPortal));
    assertEq(address(skyExecutor.USDS()), address(usds));
    assertEq(address(skyExecutor.SUSDS()), address(sUsds));
    assertEq(address(skyExecutor.DAI_USDS()), address(converter));
    assertEq(usds.allowance(address(skyExecutor), address(converter)), type(uint256).max);
  }

  function test_GivenTheExecutor_ThenItCreatesASubsidyBoundToItselfThatPaysInDai() external view {
    assertEq(skySubsidy.EXECUTOR(), address(skyExecutor));
    assertEq(address(skySubsidy.TOKEN()), address(dai));
    assertEq(address(skySubsidy.PRICE_FEED()), address(ethUsdFeed));
    assertEq(skySubsidy.owner(), OWNER);
    assertEq(address(skySubsidy), vm.computeCreateAddress(address(skyExecutor), 1));
  }

  function test_GivenAPortalThatDoesNotHoldShares_WhenConstructed_ThenReverts() external {
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__PortalUnderlyingMismatch.selector);
    new SkyWithdrawalExecutor(portal, _skyRoute(), OWNER, ethUsdFeed);
  }

  function test_GivenAPortalWithoutCode_WhenConstructed_ThenReverts() external {
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__InvalidPortal.selector);
    new SkyWithdrawalExecutor(IOxidePortal(makeAddr("noCode")), _skyRoute(), OWNER, ethUsdFeed);
  }

  function test_GivenAZeroRouteAddress_WhenConstructed_ThenReverts() external {
    SkyRoute memory route = _skyRoute();
    route.daiUsds = IDaiUsds(address(0));
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__ZeroSkyRoute.selector);
    new SkyWithdrawalExecutor(sUsdsPortal, route, OWNER, ethUsdFeed);
  }

  function test_GivenAWithdrawal_WhenReleased_ThenTheRecipientIsPaidInDaiWithATipAndASubsidy() external {
    _configureSkySubsidy(1e18);
    sUsds.setPricePerShare(1.25e18);
    uint256 shares = 100e18;
    uint256 tip = 4e18;
    _fundSUsdsPortal(shares);
    uint256 subsidy = skySubsidy.quoteSubsidy(WITHDRAWAL);
    assertGt(subsidy, 0, "the subsidy is configured");

    vm.prank(RELAYER);
    sUsdsPortal.withdraw(_skyWithdrawArgs(shares, abi.encode(RECIPIENT, tip), abi.encodePacked(RELAYER)));

    assertEq(dai.balanceOf(RELAYER), tip + subsidy, "the tip and the subsidy are paid in dai");
    assertEq(dai.balanceOf(RECIPIENT), 125e18 - tip, "the rest is paid in dai at the share price");
    assertEq(sUsds.balanceOf(address(skyExecutor)), 0, "no shares are left behind");
    assertEq(usds.balanceOf(address(skyExecutor)), 0, "no usds is stranded");
    assertEq(dai.balanceOf(address(skyExecutor)), 0, "no dai is stranded");
  }

  function test_GivenATipRecipient_WhenReleased_ThenTheSubsidyIsClaimedForIt() external {
    _fundSUsdsPortal(10e18);
    vm.expectCall(address(skySubsidy), abi.encodeCall(PlainWithdrawalSubsidy.paySubsidy, (WITHDRAWAL, RELAYER)), 1);

    vm.prank(RELAYER);
    sUsdsPortal.withdraw(_skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 0), abi.encodePacked(RELAYER)));
  }

  function test_GivenNoTipRecipient_WhenReleased_ThenNoSubsidyIsClaimed() external {
    _fundSUsdsPortal(10e18);
    vm.expectCall(address(skySubsidy), abi.encodeWithSelector(PlainWithdrawalSubsidy.paySubsidy.selector), 0);

    sUsdsPortal.withdraw(_skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 0), NO_RELAYER));

    assertEq(dai.balanceOf(RECIPIENT), 10e18);
  }

  function test_GivenATipAboveTheDaiAmount_WhenExecuted_ThenReverts() external {
    _mintShares(address(skyExecutor), 10e18);
    vm.prank(address(sUsdsPortal));
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__RelayerTipExceedsAmount.selector);
    skyExecutor.execute(WITHDRAWAL, 10e18, abi.encode(RECIPIENT, 10e18 + 1), abi.encodePacked(RELAYER));
  }

  function test_GivenATipEqualToTheShareAmount_WhenReleased_ThenTheTipIsPayable() external {
    sUsds.setPricePerShare(1.01e18);
    uint256 shares = 10e18;
    _fundSUsdsPortal(shares);

    vm.prank(RELAYER);
    sUsdsPortal.withdraw(_skyWithdrawArgs(shares, abi.encode(RECIPIENT, shares), abi.encodePacked(RELAYER)));

    assertEq(dai.balanceOf(RELAYER), shares, "a tip the app accepted in shares is payable in dai");
    assertEq(dai.balanceOf(RECIPIENT), 0.1e18, "the recipient gets what the share price adds");
  }

  function test_GivenATipWithoutATipRecipient_WhenExecuted_ThenReverts() external {
    _mintShares(address(skyExecutor), 10e18);
    vm.prank(address(sUsdsPortal));
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__ZeroTipRecipient.selector);
    skyExecutor.execute(WITHDRAWAL, 10e18, abi.encode(RECIPIENT, 1e18), NO_RELAYER);
  }

  function test_GivenANonPortalCaller_WhenExecuted_ThenReverts() external {
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__UnauthorizedCaller.selector);
    skyExecutor.execute(WITHDRAWAL, 0, abi.encode(RECIPIENT, 0), NO_RELAYER);
  }

  function test_GivenAUserPayloadOfTheWrongLength_WhenExecuted_ThenReverts() external {
    vm.prank(address(sUsdsPortal));
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__InvalidUserPayload.selector);
    skyExecutor.execute(WITHDRAWAL, 0, abi.encode(RECIPIENT, 0, 0), NO_RELAYER);
  }

  function test_GivenARelayerPayloadOfTheWrongLength_WhenExecuted_ThenReverts() external {
    vm.prank(address(sUsdsPortal));
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__InvalidRelayerPayload.selector);
    skyExecutor.execute(WITHDRAWAL, 0, abi.encode(RECIPIENT, 0), hex"00");
  }

  function test_GivenDirtyRecipientPadding_WhenExecuted_ThenReverts() external {
    bytes memory userPayload = abi.encode(bytes32(uint256(uint160(RECIPIENT)) | (uint256(1) << 160)), uint256(0));
    vm.prank(address(sUsdsPortal));
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__InvalidUserPayload.selector);
    skyExecutor.execute(WITHDRAWAL, 0, userPayload, NO_RELAYER);
  }

  function test_GivenARelayerPayloadThatNamesASubsidy_WhenExecuted_ThenReverts() external {
    vm.prank(address(sUsdsPortal));
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__InvalidRelayerPayload.selector);
    skyExecutor.execute(WITHDRAWAL, 0, abi.encode(RECIPIENT, 0), abi.encodePacked(RELAYER, address(skySubsidy)));
  }

  function test_GivenAZeroRecipient_WhenExecuted_ThenReverts() external {
    vm.prank(address(sUsdsPortal));
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__ZeroRecipient.selector);
    skyExecutor.execute(WITHDRAWAL, 0, abi.encode(address(0), 0), NO_RELAYER);
  }

  function test_GivenABrokenConverter_WhenReleased_ThenTheWholeWithdrawRevertsAndStaysUnspent() external {
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory args =
      _skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 1e18), abi.encodePacked(RELAYER));
    converter.setBroken(true);

    vm.prank(RELAYER);
    vm.expectRevert(MockDaiUsds.MockDaiUsds__Paused.selector);
    sUsdsPortal.withdraw(args);

    assertFalse(sUsdsPortal.$isWithdrawalSpent(args.withdrawalId), "the withdrawal stays unspent");
    assertEq(sUsds.balanceOf(address(sUsdsPortal)), 10e18, "the portal keeps the shares");
    assertEq(sUsds.balanceOf(RECIPIENT), 0, "a failed conversion never pays shares");

    converter.setBroken(false);
    vm.prank(RELAYER);
    sUsdsPortal.withdraw(args);
    assertEq(dai.balanceOf(RECIPIENT), 9e18, "the withdrawal completes in dai when Sky works again");
  }

  function test_GivenABrokenVault_WhenReleased_ThenTheWholeWithdrawReverts() external {
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory args = _skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 0), NO_RELAYER);
    sUsds.setBroken(true);

    vm.expectRevert(MockSUsds.MockSUsds__Paused.selector);
    sUsdsPortal.withdraw(args);
    assertFalse(sUsdsPortal.$isWithdrawalSpent(args.withdrawalId));
  }

  function test_GivenTheRecipient_WhenItWithdrawsInShares_ThenItGetsAllTheSharesAndNoTipOrSubsidyIsPaid() external {
    sUsds.setPricePerShare(1.25e18);
    uint256 shares = 100e18;
    _fundSUsdsPortal(shares);
    converter.setBroken(true);
    IOxidePortal.WithdrawArgs memory args =
      _skyWithdrawArgs(shares, abi.encode(RECIPIENT, 5e18), abi.encodePacked(RELAYER));

    vm.expectCall(address(skySubsidy), abi.encodeWithSelector(PlainWithdrawalSubsidy.paySubsidy.selector), 0);
    vm.expectEmit(true, true, false, true, address(skyExecutor));
    emit SharesSettlement(WITHDRAWAL, RECIPIENT, shares);
    vm.prank(RECIPIENT);
    skyExecutor.withdrawInShares(args);

    assertEq(sUsds.balanceOf(RECIPIENT), shares, "the recipient gets every share");
    assertEq(dai.balanceOf(RELAYER), 0, "no tip is paid");
    assertEq(sUsds.balanceOf(RELAYER), 0, "no tip is paid");
    assertTrue(sUsdsPortal.$isWithdrawalSpent(args.withdrawalId));
  }

  function test_GivenAnotherCaller_WhenItWithdrawsInShares_ThenReverts() external {
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory args = _skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 0), NO_RELAYER);

    vm.prank(RELAYER);
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__CallerNotRecipient.selector);
    skyExecutor.withdrawInShares(args);
    assertFalse(sUsdsPortal.$isWithdrawalSpent(args.withdrawalId));
  }

  function test_GivenASettlementInShares_WhenItEnds_ThenTheNextWithdrawalConvertsToDai() external {
    _fundSUsdsPortal(20e18);
    IOxidePortal.WithdrawArgs memory inShares = _skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 0), NO_RELAYER);
    IOxidePortal.WithdrawArgs memory inDai = _skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 0), NO_RELAYER);

    vm.prank(RECIPIENT);
    skyExecutor.withdrawInShares(inShares);
    vm.prank(RECIPIENT);
    sUsdsPortal.withdraw(inDai);

    assertEq(sUsds.balanceOf(RECIPIENT), 10e18, "the first withdrawal pays shares");
    assertEq(dai.balanceOf(RECIPIENT), 10e18, "the slot is clear, so the second one converts");
  }

  function test_GivenASettlementInShares_WhenANestedOneStarts_ThenReverts() external {
    ReenteringSUsds hooked = new ReenteringSUsds(usds, address(this));
    usds.addMinter(address(hooked));
    OxidePortal hookedPortal = _newPortal(address(hooked), bytes32(uint256(0x4E57)));
    SkyRoute memory route = _skyRoute();
    route.sUsds = ISUsds(address(hooked));
    SkyWithdrawalExecutor hookedExecutor = new SkyWithdrawalExecutor(hookedPortal, route, OWNER, ethUsdFeed);

    deal(address(hooked), address(hookedPortal), 20e18, true);
    IOxidePortal.WithdrawArgs memory outer =
      _withdrawArgs(hookedPortal, address(hookedExecutor), 10e18, abi.encode(RECIPIENT, 0), NO_RELAYER);
    IOxidePortal.WithdrawArgs memory inner =
      _withdrawArgs(hookedPortal, address(hookedExecutor), 10e18, abi.encode(RECIPIENT, 0), NO_RELAYER);
    hooked.arm(address(hookedExecutor), abi.encodeCall(SkyWithdrawalExecutor.withdrawInShares, (inner)));

    vm.prank(RECIPIENT);
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__SharesSettlementInProgress.selector);
    hookedExecutor.withdrawInShares(outer);
  }

  function test_GivenARefundThroughTheSkyExecutor_WhenRefunded_ThenItConvertsToDai() external {
    _fundSUsdsPortal(10e18);
    _freezePortal(sUsdsPortal);
    frozenNotesRefundVerifier.setAcceptAll(true);

    sUsdsPortal.refundFrozenNotes(
      _frozenNotesRefundArgs(sUsdsPortal, address(skyExecutor), 10e18, abi.encode(RECIPIENT, 0))
    );

    assertEq(dai.balanceOf(RECIPIENT), 10e18, "a refund through the Sky executor pays dai");
    assertEq(sUsds.balanceOf(RECIPIENT), 0);
  }

  function test_GivenDonatedShares_WhenReleased_ThenTheDonationStaysInTheExecutor() external {
    _mintShares(address(skyExecutor), 2e18);
    _fundSUsdsPortal(10e18);

    sUsdsPortal.withdraw(_skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 0), NO_RELAYER));

    assertEq(sUsds.balanceOf(address(skyExecutor)), 2e18, "the donation is not converted");
    assertEq(dai.balanceOf(RECIPIENT), 10e18);
  }

  function test_GivenAWithdrawal_ThenTheReleaseGasIsMeasured() external {
    bytes memory userPayload = abi.encode(RECIPIENT, uint256(1e18));
    bytes memory relayerPayload = abi.encodePacked(RELAYER);

    dai.mint(address(portal), 30e18);
    _fundSUsdsPortal(30e18);
    portal.withdraw(_daiWithdrawArgs(10e18, userPayload, relayerPayload));
    sUsdsPortal.withdraw(_skyWithdrawArgs(10e18, userPayload, relayerPayload));

    IOxidePortal.WithdrawArgs memory plainArgs = _daiWithdrawArgs(10e18, userPayload, relayerPayload);
    uint256 before = gasleft();
    portal.withdraw(plainArgs);
    uint256 plainGas = before - gasleft();

    IOxidePortal.WithdrawArgs memory skyArgs = _skyWithdrawArgs(10e18, userPayload, relayerPayload);
    before = gasleft();
    sUsdsPortal.withdraw(skyArgs);
    uint256 skyGas = before - gasleft();

    console2.log("mocks: plain DAI withdraw, gas:", plainGas);
    console2.log("mocks: sUSDS withdraw through SkyWithdrawalExecutor, gas:", skyGas);
    assertGt(skyGas, plainGas, "the Sky conversion cannot be cheaper than a plain withdrawal");
  }

  function test_GivenAFrozenSUsdsPortal_WhenARefundGoesThroughTheSkyExecutor_ThenTheTipAndSubsidyArePaidInDai()
    external
  {
    _configureSkySubsidy(1e18);
    sUsds.setPricePerShare(1.25e18);
    _fundSUsdsPortal(10e18);
    _freezePortal(sUsdsPortal);
    frozenNotesRefundVerifier.setAcceptAll(true);
    IOxidePortal.RefundFrozenNotesArgs memory args =
      _frozenNotesRefundArgs(sUsdsPortal, address(skyExecutor), 10e18, abi.encode(RECIPIENT, 1e18));
    args.relayerPayload = abi.encodePacked(RELAYER);
    uint256 subsidy = skySubsidy.quoteSubsidy(IExecutor.Flow.FrozenNotesRefund);
    assertGt(subsidy, 0, "the subsidy is configured");
    uint256 subsidyBalance = dai.balanceOf(address(skySubsidy));

    vm.prank(RELAYER);
    sUsdsPortal.refundFrozenNotes(args);

    assertEq(dai.balanceOf(RELAYER), 1e18 + subsidy, "the tip and the subsidy are paid in dai");
    assertEq(dai.balanceOf(address(skySubsidy)), subsidyBalance - subsidy);
    assertEq(dai.balanceOf(RECIPIENT), 12.5e18 - 1e18, "the rest is paid in dai at the share price");
    assertEq(sUsds.balanceOf(RELAYER), 0);
    assertEq(sUsds.balanceOf(RECIPIENT), 0);
    assertEq(sUsds.balanceOf(address(skyExecutor)), 0);
    assertEq(dai.balanceOf(address(skyExecutor)), 0);
  }

  function test_GivenAFrozenSUsdsPortal_WhenTheRecipientSettlesAPreFreezeWithdrawalInShares_ThenItGetsTheShares()
    external
  {
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory args =
      _skyWithdrawArgs(10e18, abi.encode(RECIPIENT, 1e18), abi.encodePacked(RELAYER));
    rollup.setCheckpoint(DEFAULT_CHECKPOINT_NUMBER + 1, bytes32(uint256(0xA12)), 3);
    rollup.setProvenCheckpointNumber(DEFAULT_CHECKPOINT_NUMBER + 1);
    _freezePortal(sUsdsPortal);
    assertTrue(sUsdsPortal.$frozen());
    assertGt(sUsdsPortal.$freezeCheckpointNumber(), args.checkpointNumber, "the withdrawal is before the freeze");
    converter.setBroken(true);

    vm.prank(RELAYER);
    vm.expectRevert(MockDaiUsds.MockDaiUsds__Paused.selector);
    sUsdsPortal.withdraw(args);

    vm.prank(RECIPIENT);
    skyExecutor.withdrawInShares(args);

    assertTrue(sUsdsPortal.$isWithdrawalSpent(args.withdrawalId));
    assertEq(sUsds.balanceOf(RECIPIENT), 10e18, "the recipient gets every share");
    assertEq(sUsds.balanceOf(RELAYER), 0, "no tip is paid");
    assertEq(dai.balanceOf(RELAYER), 0, "no tip is paid");
    assertEq(sUsds.balanceOf(address(sUsdsPortal)), 0);
  }

  function test_GivenAWithdrawalForAnotherExecutor_WhenWithdrawnInShares_ThenReverts() external {
    PlainWithdrawalExecutor sharesExecutor =
      new PlainWithdrawalExecutor(address(sUsdsPortal), 0, address(0), OWNER, ethUsdFeed);
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory other = _withdrawArgs(
      sUsdsPortal, address(sharesExecutor), 10e18, abi.encode(RECIPIENT, 1e18), abi.encodePacked(RELAYER)
    );

    vm.prank(RECIPIENT);
    vm.expectRevert(SkyErrors.SkyWithdrawalExecutor__NotThisExecutor.selector);
    skyExecutor.withdrawInShares(other);

    assertFalse(sUsdsPortal.$isWithdrawalSpent(other.withdrawalId));
  }

  function test_GivenAFrozenSUsdsPortal_WhenARefundUsesThePlainExecutor_ThenItPreservesShares() external {
    PlainWithdrawalExecutor sharesExecutor =
      new PlainWithdrawalExecutor(address(sUsdsPortal), 0, address(0), OWNER, ethUsdFeed);
    sUsds.setPricePerShare(1.25e18);
    _fundSUsdsPortal(10e18);
    _freezePortal(sUsdsPortal);
    frozenNotesRefundVerifier.setAcceptAll(true);
    IOxidePortal.RefundFrozenNotesArgs memory args =
      _frozenNotesRefundArgs(sUsdsPortal, address(sharesExecutor), 10e18, abi.encode(RECIPIENT, 1e18));
    args.relayerPayload = abi.encodePacked(RELAYER);
    converter.setBroken(true);

    vm.prank(RELAYER);
    sUsdsPortal.refundFrozenNotes(args);

    assertEq(address(sharesExecutor.ASSET()), address(sUsds));
    assertEq(sUsds.balanceOf(RECIPIENT), 9e18);
    assertEq(sUsds.balanceOf(RELAYER), 1e18);
    assertEq(sUsds.balanceOf(address(sharesExecutor)), 0);
    assertEq(dai.balanceOf(RECIPIENT), 0);
    assertEq(dai.balanceOf(RELAYER), 0);
  }
}
