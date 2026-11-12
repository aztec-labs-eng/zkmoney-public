// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors} from "@periphery/Errors.sol";
import {
  StablecoinWithdrawalExecutor,
  LITE_PSM_USDC,
  WETH,
  DAI_WETH_PAIR
} from "@periphery/StablecoinWithdrawalExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";
import {StablecoinWithdrawalExecutorHelpers} from "@test/periphery/StablecoinWithdrawalExecutorTestBase.sol";

contract StablecoinWithdrawalExecutorRoutesForkTest is MainnetForkFixture, StablecoinWithdrawalExecutorHelpers {
  using stdStorage for StdStorage;

  AggregatorV3Interface internal constant CHAINLINK_ETH_USD =
    AggregatorV3Interface(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);

  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant FEE = 1e18;
  uint256 internal constant TIP = 5e18;
  uint256 internal constant SWAPPED = AMOUNT - FEE - TIP;
  uint256 internal constant DUST = 456_789_012_345;
  uint256 internal constant TO_18 = 1e12;
  uint256 internal constant HALTED = type(uint256).max;

  uint256 internal constant USDC_MIN_OUT = SWAPPED / TO_18;
  uint256 internal constant USDT_MIN_OUT = 2460e6;
  uint256 internal constant USDT_OUT_BAND_HIGH = 2520e6;
  uint256 internal constant USDT_MIN_OUT_TOO_HIGH = 2520e6;

  uint256 internal constant GAS_SHARE = 15e18;
  uint256 internal constant USDC_MIN_OUT_AFTER_GAS_SHARE = (SWAPPED - GAS_SHARE) / TO_18;
  uint256 internal constant USDT_MIN_OUT_AFTER_GAS_SHARE = 2445e6;
  uint256 internal constant USDT_OUT_AFTER_GAS_SHARE_BAND_HIGH = 2505e6;
  uint256 internal constant SANDWICH_DAI = 200_000e18;
  uint256 internal constant BPS = 10_000;
  uint256 internal constant GAS_SHARE_SLIPPAGE_BPS = 200;

  OxidePortal internal daiPortal;
  StablecoinWithdrawalExecutor internal executor;
  PlainWithdrawalSubsidy internal subsidy;

  address internal relayer = makeAddr("relayer");
  address internal recipient = makeAddr("recipient");
  address internal feeBeneficiary = makeAddr("feeBeneficiary");
  address internal recoveryRecipient = makeAddr("recoveryRecipient");
  address internal attacker = makeAddr("attacker");

  function setUp() public override(OxidePortalBase) {
    _selectMainnetFork();
    super.setUp();
    _registerSigner();

    daiPortal = _buildPortal(address(DAI));
    executor = new StablecoinWithdrawalExecutor(address(daiPortal), FEE, feeBeneficiary, OWNER, CHAINLINK_ETH_USD);
    subsidy = executor.SUBSIDY();
    vm.prank(OWNER);
    subsidy.setFlowPricing(
      IExecutor.Flow.Withdrawal, PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: 10e18})
    );
    deal(address(DAI), address(subsidy), 1000e18);
    deal(address(DAI), feeBeneficiary, 1);
    deal(address(DAI), relayer, 1);
    vm.txGasPrice(block.basefee + 1 gwei);
  }

  function test_GivenTheDaiPayload_WhenRelayed_ThenTheRecipientGetsTheDai() external {
    uint256 gasUsed = _relay(_payload(recipient, TIP, ROUTE_DAI, 0, 0, bytes32(0)), AMOUNT);
    console2.log("fork: stablecoin withdrawal executor, DAI payout, portal withdraw gas:", gasUsed);

    assertEq(DAI.balanceOf(recipient), SWAPPED);
    _assertFeeTipAndSubsidyPaid();
  }

  function test_GivenTheUsdcPayload_WhenRelayed_ThenTheRecipientGetsAtLeastTheMinOutInUsdc() external {
    uint256 gasUsed = _relay(_payload(recipient, TIP, ROUTE_USDC, USDC_MIN_OUT), AMOUNT);
    console2.log("fork: stablecoin withdrawal executor, USDC payout, portal withdraw gas:", gasUsed);

    assertEq(USDC.balanceOf(recipient), USDC_MIN_OUT);
    assertEq(DAI.balanceOf(recipient), 0);
    _assertFeeTipAndSubsidyPaid();
  }

  function test_GivenTheUsdcPayloadWithDaiDust_WhenRelayed_ThenTheRecipientGetsTheUsdcAndTheRelayerTheDust() external {
    uint256 gasUsed = _relay(_payload(recipient, TIP, ROUTE_USDC, USDC_MIN_OUT), AMOUNT + DUST);
    console2.log("fork: stablecoin withdrawal executor, USDC payout with DAI dust, portal withdraw gas:", gasUsed);

    assertEq(USDC.balanceOf(recipient), USDC_MIN_OUT);
    assertEq(DAI.balanceOf(recipient), 0);
    assertGt(DAI.balanceOf(relayer), 1 + TIP + DUST, "the relayer gets the tip, the dust and a subsidy");
    _assertFeeTipAndSubsidyPaid();
  }

  function test_GivenTheUsdtPayload_WhenRelayed_ThenTheRecipientGetsAtLeastTheMinOutInUsdt() external {
    uint256 gasUsed = _relay(_payload(recipient, TIP, ROUTE_USDT, USDT_MIN_OUT), AMOUNT);
    console2.log("fork: stablecoin withdrawal executor, USDT payout, portal withdraw gas:", gasUsed);

    uint256 usdtOut = USDT.balanceOf(recipient);
    console2.log("fork: stablecoin withdrawal executor, USDT out:", usdtOut);
    assertGe(usdtOut, USDT_MIN_OUT);
    assertLt(usdtOut, USDT_OUT_BAND_HIGH);
    assertEq(DAI.balanceOf(recipient), 0);
    _assertFeeTipAndSubsidyPaid();
  }

  function test_GivenADaiPayoutWithAGasShare_WhenRelayed_ThenTheRecipientGetsEthWithinTheFeedBand() external {
    _relayWithAndWithoutAGasShare("DAI", ROUTE_DAI, 0, 0);

    assertEq(DAI.balanceOf(recipient), SWAPPED - GAS_SHARE);
    _assertFeeTipAndSubsidyPaid();
  }

  function test_GivenAUsdcPayoutWithAGasShare_WhenRelayed_ThenTheRecipientGetsEthWithinTheFeedBand() external {
    _relayWithAndWithoutAGasShare("USDC", ROUTE_USDC, USDC_MIN_OUT, USDC_MIN_OUT_AFTER_GAS_SHARE);

    assertEq(USDC.balanceOf(recipient), USDC_MIN_OUT_AFTER_GAS_SHARE);
    assertEq(DAI.balanceOf(recipient), 0);
    _assertFeeTipAndSubsidyPaid();
  }

  function test_GivenAUsdtPayoutWithAGasShare_WhenRelayed_ThenTheRecipientGetsEthWithinTheFeedBand() external {
    _relayWithAndWithoutAGasShare("USDT", ROUTE_USDT, USDT_MIN_OUT, USDT_MIN_OUT_AFTER_GAS_SHARE);

    uint256 usdtOut = USDT.balanceOf(recipient);
    assertGe(usdtOut, USDT_MIN_OUT_AFTER_GAS_SHARE);
    assertLt(usdtOut, USDT_OUT_AFTER_GAS_SHARE_BAND_HIGH);
    assertEq(DAI.balanceOf(recipient), 0);
    _assertFeeTipAndSubsidyPaid();
  }

  function test_GivenASandwichThatMovesThePairPrice_WhenAGasShareIsRelayed_ThenTheRouteGetsTheDai() external {
    deal(address(DAI), attacker, SANDWICH_DAI);
    _sellDai(attacker, SANDWICH_DAI);
    assertLt(_pairEthOut(GAS_SHARE), _feedFloor(GAS_SHARE), "the sandwich moves the pair below the floor");

    _relay(_payload(recipient, TIP, ROUTE_DAI, 0, GAS_SHARE), AMOUNT);

    assertEq(recipient.balance, 0);
    assertEq(DAI.balanceOf(recipient), SWAPPED);
    _assertFeeTipAndSubsidyPaid();
  }

  function test_GivenAUsdcMinOutAboveThePsmOutput_WhenRelayed_ThenTheWithdrawalStaysPending() external {
    _assertRelayReverts(
      _withdrawalArgs(_payload(recipient, TIP, ROUTE_USDC, USDC_MIN_OUT + 1)),
      abi.encodeWithSelector(
        Errors.StablecoinWithdrawalExecutor__InsufficientOutput.selector, USDC_MIN_OUT, USDC_MIN_OUT + 1
      )
    );
  }

  function test_GivenAUsdtMinOutAboveThe3poolOutput_WhenRelayed_ThenItStaysPendingAndRecoverPaysTheDai() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(recipient, TIP, ROUTE_USDT, USDT_MIN_OUT_TOO_HIGH));
    _assertRelayFails(args);

    _assertRecoverPaysTheDai(args);
  }

  function test_GivenThePsmIsHalted_WhenTheUsdcPayloadIsRelayed_ThenItStaysPendingAndRecoverPaysTheDai() external {
    stdstore.target(address(LITE_PSM_USDC)).sig(LITE_PSM_USDC.tout.selector).checked_write(HALTED);
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(recipient, TIP, ROUTE_USDC, 0));
    _assertRelayFails(args);

    _assertRecoverPaysTheDai(args);
  }

  function _relayWithAndWithoutAGasShare(
    string memory _token,
    uint8 _route,
    uint256 _minOut,
    uint256 _minOutAfterGasShare
  ) internal {
    uint256 snapshot = vm.snapshotState();
    uint256 withoutGasShare = _relay(_payload(recipient, TIP, _route, _minOut), AMOUNT);
    uint256 ethOut = _pairEthOut(GAS_SHARE);
    vm.revertToState(snapshot);

    uint256 withGasShare = _relay(_payload(recipient, TIP, _route, _minOutAfterGasShare, GAS_SHARE), AMOUNT);
    console2.log(
      string.concat("fork: stablecoin withdrawal executor, ", _token, " swap payload, portal withdraw gas:"),
      withoutGasShare
    );
    console2.log(
      string.concat("fork: stablecoin withdrawal executor, ", _token, " payout with a gas share, portal withdraw gas:"),
      withGasShare
    );
    console2.log(
      string.concat("fork: stablecoin withdrawal executor, ", _token, " payout, gas share gas:"),
      withGasShare - withoutGasShare
    );

    assertEq(recipient.balance, ethOut, "the recipient gets the pair's ETH");
    assertGe(recipient.balance, _feedFloor(GAS_SHARE), "the gas share pays at least the feed floor");
    assertApproxEqRel(recipient.balance, _feedEthValue(GAS_SHARE), 0.02e18);
  }

  function _sellDai(address _seller, uint256 _daiIn) internal {
    uint256 wethOut = _pairEthOut(_daiIn);
    vm.startPrank(_seller);
    DAI.transfer(address(DAI_WETH_PAIR), _daiIn);
    DAI_WETH_PAIR.swap(0, wethOut, _seller, "");
    vm.stopPrank();
  }

  function _pairEthOut(uint256 _daiIn) internal view returns (uint256) {
    (uint256 daiReserve, uint256 wethReserve,) = DAI_WETH_PAIR.getReserves();
    uint256 amountInWithFee = _daiIn * 997;
    return (amountInWithFee * wethReserve) / (daiReserve * 1000 + amountInWithFee);
  }

  function _feedEthValue(uint256 _daiIn) internal view returns (uint256) {
    (, int256 answer,,,) = CHAINLINK_ETH_USD.latestRoundData();
    return (_daiIn * 10 ** CHAINLINK_ETH_USD.decimals()) / uint256(answer);
  }

  function _feedFloor(uint256 _daiIn) internal view returns (uint256) {
    return (_feedEthValue(_daiIn) * (BPS - GAS_SHARE_SLIPPAGE_BPS)) / BPS;
  }

  function _assertRecoverPaysTheDai(IOxidePortal.WithdrawArgs memory _args) internal {
    bytes memory signature =
      _recoverySignature(executor, _args.withdrawalId, recoveryRecipient, block.timestamp, RECOVERY_KEY);
    address account = _recoveryAccount();
    uint256 before = gasleft();
    executor.recover(_args, RECOVERY_SALT, account, signature, recoveryRecipient, block.timestamp);
    console2.log("fork: stablecoin withdrawal executor, recover gas:", before - gasleft());

    assertTrue(daiPortal.$isWithdrawalSpent(_args.withdrawalId));
    assertEq(DAI.balanceOf(recoveryRecipient), AMOUNT - FEE);
    assertEq(DAI.balanceOf(relayer), 1);
    assertEq(USDC.balanceOf(recipient), 0);
    assertEq(USDT.balanceOf(recipient), 0);
    _assertNothingSticks();
  }

  function _assertFeeTipAndSubsidyPaid() internal view {
    assertEq(DAI.balanceOf(feeBeneficiary), 1 + FEE);
    assertGt(DAI.balanceOf(relayer), 1 + TIP, "the relayer gets the tip and a subsidy");
    assertEq(DAI.balanceOf(address(daiPortal)), 0);
    _assertNothingSticks();
  }

  function _assertNothingSticks() internal view {
    assertEq(DAI.balanceOf(address(executor)), 0, "no DAI sticks");
    assertEq(USDC.balanceOf(address(executor)), 0, "no USDC sticks");
    assertEq(USDT.balanceOf(address(executor)), 0, "no USDT sticks");
    assertEq(DAI.allowance(address(executor), address(LITE_PSM_USDC)), 0, "no PSM allowance sticks");
    assertEq(DAI.allowance(address(executor), address(THREE_POOL)), 0, "no 3pool allowance sticks");
    assertEq(address(executor).balance, 0, "no ETH sticks");
    assertEq(WETH.balanceOf(address(executor)), 0, "no WETH sticks");
  }

  function _withdrawalArgs(bytes memory _userPayload) internal returns (IOxidePortal.WithdrawArgs memory) {
    return _withdrawalArgsFor(_userPayload, AMOUNT);
  }

  function _withdrawalArgsFor(bytes memory _userPayload, uint256 _amount)
    internal
    returns (IOxidePortal.WithdrawArgs memory args)
  {
    args = _relayedArgs(daiPortal, executor, _amount, 0, _userPayload, relayer);
    deal(address(DAI), address(daiPortal), _amount);
  }

  function _relay(bytes memory _userPayload, uint256 _amount) internal returns (uint256 gasUsed) {
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgsFor(_userPayload, _amount);
    vm.prank(relayer);
    uint256 before = gasleft();
    daiPortal.withdraw(args);
    gasUsed = before - gasleft();
    assertTrue(daiPortal.$isWithdrawalSpent(args.withdrawalId));
  }

  function _assertRelayReverts(IOxidePortal.WithdrawArgs memory _args, bytes memory _revertData) internal {
    vm.prank(relayer);
    vm.expectRevert(_revertData);
    daiPortal.withdraw(_args);

    _assertStaysPending(_args);
  }

  function _assertRelayFails(IOxidePortal.WithdrawArgs memory _args) internal {
    vm.prank(relayer);
    vm.expectRevert();
    daiPortal.withdraw(_args);

    _assertStaysPending(_args);
  }

  function _assertStaysPending(IOxidePortal.WithdrawArgs memory _args) internal view {
    assertFalse(daiPortal.$isWithdrawalSpent(_args.withdrawalId), "the withdrawal stays pending");
    assertEq(DAI.balanceOf(address(daiPortal)), AMOUNT, "the portal keeps the funds");
    assertEq(DAI.balanceOf(relayer), 1);
  }
}
