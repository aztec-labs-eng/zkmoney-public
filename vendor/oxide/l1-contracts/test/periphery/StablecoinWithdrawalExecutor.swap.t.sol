// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {stdError} from "forge-std/StdError.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors as CoreErrors} from "@core/lib/Errors.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {Errors} from "@periphery/Errors.sol";
import {
  StablecoinWithdrawalExecutor,
  LITE_PSM_USDC,
  WETH,
  DAI_WETH_PAIR
} from "@periphery/StablecoinWithdrawalExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";
import {RecoveryAuthLib} from "@periphery/RecoveryAuthLib.sol";
import {USDC, USDT, THREE_POOL, MAINNET_CHAIN_ID} from "@periphery/ThreePoolLib.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {MockBlocklistToken} from "@test/mocks/MockBlocklistToken.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MockMakerPsm} from "@test/mocks/MockMakerPsm.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {MockWETH9} from "@test/mocks/MockWETH9.sol";
import {StablecoinWithdrawalExecutorHelpers} from "@test/periphery/StablecoinWithdrawalExecutorTestBase.sol";
import {MockUniswapV2Pair} from "@test/periphery/swap_on_withdraw_feature/MockUniswapV2Pair.sol";

contract EthRejectingRecipient {}

contract PortalReenteringRecipient {
  address internal immutable PORTAL;
  bytes internal $reentry;
  bool public reentrySucceeded;

  constructor(address _portal) {
    PORTAL = _portal;
  }

  function setReentry(bytes calldata _call) external {
    $reentry = _call;
  }

  receive() external payable {
    (reentrySucceeded,) = PORTAL.call($reentry);
  }
}

contract StablecoinWithdrawalExecutorSwapTest is StablecoinWithdrawalExecutorHelpers {
  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant FEE = 3e18;
  uint256 internal constant TIP = 25e18;
  uint256 internal constant PROVER_TIP = 100e18;
  uint256 internal constant SWAPPED = AMOUNT - FEE - TIP;
  uint256 internal constant DUST = 456_789_012_345;

  uint256 internal constant WAD = 1e18;
  uint256 internal constant TO_18 = 1e12;
  uint256 internal constant USDC_OUT = SWAPPED / TO_18;
  uint256 internal constant TOUT = 1e15;
  uint256 internal constant USDT_RATE = 0.998e6;
  uint256 internal constant USDT_OUT = (SWAPPED * USDT_RATE) / WAD;
  uint256 internal constant USDT_LOW_RATE = 0.98e6;
  uint256 internal constant USDT_BOUND_RATE = 0.99e6;

  uint256 internal constant SEPOLIA_CHAIN_ID = 11_155_111;
  uint256 internal constant OTHER_KEY = 0xBAD;
  uint256 internal constant SUBSIDY_GAS_PRICE = 10 gwei;

  uint256 internal constant GAS_SHARE = 15e18;
  uint256 internal constant PAIR_DAI_RESERVE = 2_500_000e18;
  uint256 internal constant PAIR_WETH_RESERVE = 1000e18;
  int256 internal constant FEED_BELOW_PAIR_PRICE = 2400e8;
  uint256 internal constant BPS = 10_000;
  uint256 internal constant GAS_SHARE_SLIPPAGE_BPS = 200;

  TestERC20 internal dai;
  MockBlocklistToken internal usdc;
  MintableToken internal usdt;
  MockMakerPsm internal psm;
  MockCurve3Pool internal threePool;
  MockUniswapV2Pair internal pair;
  MockV3Aggregator internal feed;
  StablecoinWithdrawalExecutor internal executor;
  PlainWithdrawalSubsidy internal subsidy;

  address internal relayer = makeAddr("relayer");
  address internal alice = makeAddr("alice");
  address internal feeBeneficiary = makeAddr("fee-beneficiary");
  address internal recoveryRecipient = makeAddr("recovery-recipient");
  uint256 internal deadline;

  function setUp() public override {
    vm.chainId(MAINNET_CHAIN_ID);
    super.setUp();
    _registerSigner();

    dai = underlying;
    vm.etch(address(USDC), address(new MockBlocklistToken("USD Coin", "USDC", 6)).code);
    vm.etch(address(USDT), address(new MintableToken("Tether USD", "USDT", 6)).code);
    vm.etch(address(LITE_PSM_USDC), address(new MockMakerPsm(address(dai), address(USDC), 6)).code);
    vm.etch(address(THREE_POOL), address(new MockCurve3Pool()).code);
    usdc = MockBlocklistToken(address(USDC));
    usdt = MintableToken(address(USDT));
    psm = MockMakerPsm(address(LITE_PSM_USDC));
    threePool = MockCurve3Pool(address(THREE_POOL));
    threePool.setCoins(address(dai), address(usdc), address(usdt));
    threePool.setRate(address(usdt), USDT_RATE);
    usdc.mint(address(psm), 1_000_000e6);
    usdt.mint(address(threePool), 1_000_000e6);

    vm.etch(address(WETH), address(new MockWETH9()).code);
    vm.etch(address(DAI_WETH_PAIR), address(new MockUniswapV2Pair(address(dai), address(WETH))).code);
    pair = MockUniswapV2Pair(address(DAI_WETH_PAIR));
    dai.mint(address(pair), PAIR_DAI_RESERVE);
    vm.deal(address(this), PAIR_WETH_RESERVE);
    WETH.deposit{value: PAIR_WETH_RESERVE}();
    WETH.transfer(address(pair), PAIR_WETH_RESERVE);
    pair.sync();
    feed = MockV3Aggregator(address(ethUsdFeed));

    executor = new StablecoinWithdrawalExecutor(address(portal), FEE, feeBeneficiary, OWNER, ethUsdFeed);
    subsidy = executor.SUBSIDY();
    deadline = block.timestamp + 1 days;
  }

  function test_GivenTheUsdcPayload_WhenRelayed_ThenTheRecipientGetsThePsmUsdcAndTheRelayerTheDaiDust() external {
    _relay(_payload(alice, TIP, ROUTE_USDC, USDC_OUT), AMOUNT + DUST);

    assertEq(usdc.balanceOf(alice), USDC_OUT);
    assertEq(dai.balanceOf(alice), 0);
    assertEq(dai.balanceOf(address(psm)), USDC_OUT * TO_18);
    assertEq(dai.balanceOf(feeBeneficiary), FEE);
    assertEq(dai.balanceOf(relayer), TIP + DUST);
    _assertNothingSticks();
  }

  // solhint-disable-next-line oxide/no-comments
  // Intended: dust under one USDC unit stays; nothing reads it, and a self-relayer names itself to collect it.
  function test_GivenNoTipRecipient_WhenTheUsdcPayloadIsRelayed_ThenTheDaiDustStaysInTheExecutor() external {
    IOxidePortal.WithdrawArgs memory args =
      _relayedArgs(portal, executor, AMOUNT + DUST, 0, _payload(alice, 0, ROUTE_USDC, 0), address(0));
    dai.mint(address(portal), AMOUNT + DUST);

    vm.prank(alice);
    portal.withdraw(args);

    assertEq(usdc.balanceOf(alice), (AMOUNT - FEE) / TO_18);
    assertEq(dai.balanceOf(alice), 0);
    assertEq(dai.balanceOf(address(executor)), DUST);
    assertEq(dai.allowance(address(executor), address(psm)), 0);
  }

  function test_GivenThePsmChargesAFee_WhenTheUsdcPayloadIsRelayed_ThenTheRecipientGetsTheUsdcThatTheDaiBuys()
    external
  {
    psm.setTout(TOUT);
    uint256 gemAmt = (SWAPPED * WAD) / (TO_18 * (WAD + TOUT));
    uint256 daiIn = gemAmt * TO_18 + (gemAmt * TO_18 * TOUT) / WAD;

    _relay(_payload(alice, TIP, ROUTE_USDC, gemAmt), AMOUNT);

    assertEq(usdc.balanceOf(alice), gemAmt);
    assertEq(dai.balanceOf(alice), 0);
    assertEq(dai.balanceOf(address(psm)), daiIn);
    assertEq(dai.balanceOf(feeBeneficiary), FEE);
    assertEq(dai.balanceOf(relayer), TIP + SWAPPED - daiIn);
    _assertNothingSticks();
  }

  function test_GivenUsdtAlreadyInTheExecutor_WhenRelayed_ThenOnlyTheSwapOutputIsPaid() external {
    uint256 donation = 123e6;
    usdt.mint(address(executor), donation);

    _relay(_payload(alice, TIP, ROUTE_USDT, USDT_OUT), AMOUNT);

    assertEq(usdt.balanceOf(alice), USDT_OUT);
    assertEq(usdt.balanceOf(address(executor)), donation);
  }

  function test_GivenNoUsdtMinOut_WhenThe3poolPaysAtThe1PercentBound_ThenItPaysAndOneUnitLessReverts() external {
    threePool.setRate(address(usdt), USDT_BOUND_RATE);
    _relay(_payload(alice, TIP, ROUTE_USDT, 0), AMOUNT);
    assertEq(usdt.balanceOf(alice), (SWAPPED * 9900) / 10_000 / TO_18);

    threePool.setRate(address(usdt), USDT_BOUND_RATE - 1);
    _assertRelayFails(_withdrawalArgs(_payload(alice, TIP, ROUTE_USDT, 0), AMOUNT, 0));
  }

  function test_GivenEachRoute_WhenRelayed_ThenTheTipRecipientGetsTheTipAndTheSubsidy() external {
    _priceTheSubsidy();
    bytes[4] memory payloads = [
      _payload(alice, TIP, ROUTE_DAI, 0),
      _payload(alice, TIP, ROUTE_USDC, 0),
      _payload(alice, TIP, ROUTE_USDT, 0),
      _payload(alice, TIP, ROUTE_USDC, 0, GAS_SHARE)
    ];
    for (uint256 i = 0; i < payloads.length; i++) {
      uint256 quoted = subsidy.quoteSubsidy(IExecutor.Flow.Withdrawal);
      assertGt(quoted, 0, "the subsidy must quote a payout");
      uint256 relayerBefore = dai.balanceOf(relayer);
      uint256 subsidyBefore = dai.balanceOf(address(subsidy));

      _relay(payloads[i], AMOUNT);

      assertEq(dai.balanceOf(relayer) - relayerBefore, TIP + quoted);
      assertEq(subsidyBefore - dai.balanceOf(address(subsidy)), quoted);
    }
    _assertNothingSticks();
  }

  function test_GivenAUserPayloadOfAnotherLength_WhenRelayed_ThenItRevertsAndTheWithdrawalStaysPending() external {
    bytes memory words = bytes.concat(_payload(alice, TIP, ROUTE_USDC, 0), _payload(alice, TIP, ROUTE_USDC, 0));
    uint256[13] memory lengths = [uint256(0), 20, 32, 63, 64, 65, 96, 100, 102, 128, 160, 192, 202];
    for (uint256 i = 0; i < lengths.length; i++) {
      _assertRelayReverts(
        _withdrawalArgs(_prefix(words, lengths[i]), AMOUNT, 0),
        abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__InvalidUserPayload.selector)
      );
    }
  }

  function test_GivenARouteOtherThanUsdcUsdtOrDai_WhenRelayed_ThenItReverts() external {
    uint8[3] memory routes = [uint8(3), 4, type(uint8).max];
    for (uint256 i = 0; i < routes.length; i++) {
      _assertRelayReverts(
        _withdrawalArgs(_payload(alice, TIP, routes[i], 0), AMOUNT, 0),
        abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__UnknownRoute.selector, routes[i])
      );
    }
  }

  function test_GivenAChainOtherThanMainnet_WhenASwapOrGasSharePayloadIsRelayed_ThenItRevertsAndTheDaiPayloadPays()
    external
  {
    vm.chainId(SEPOLIA_CHAIN_ID);
    _assertRelayReverts(
      _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, 0),
      abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__SwapOffMainnet.selector)
    );
    _assertRelayReverts(
      _withdrawalArgs(_payload(alice, TIP, ROUTE_USDT, 0), AMOUNT, 0),
      abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__SwapOffMainnet.selector)
    );
    _assertRelayReverts(
      _withdrawalArgs(_payload(alice, TIP, ROUTE_DAI, 0, GAS_SHARE), AMOUNT, 0),
      abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__SwapOffMainnet.selector)
    );

    _relay(_payload(alice, TIP, ROUTE_DAI, 0), AMOUNT);

    assertEq(dai.balanceOf(alice), SWAPPED);
    assertEq(threePool.callCount(), 0);
  }

  function test_GivenAChainOtherThanMainnet_WhenASwapWithdrawalIsRecovered_ThenTheRecipientGetsTheDai() external {
    vm.chainId(SEPOLIA_CHAIN_ID);
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, 0);
    _assertRelayReverts(args, abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__SwapOffMainnet.selector));

    _recover(executor, args, recoveryRecipient, deadline);

    _assertRecovered(args, AMOUNT - FEE);
  }

  function test_GivenAUsdtMinOutAtThe3poolOutput_WhenRelayed_ThenItPaysAndOneMoreReverts() external {
    _relay(_payload(alice, TIP, ROUTE_USDT, USDT_OUT), AMOUNT);
    assertEq(usdt.balanceOf(alice), USDT_OUT);

    _assertRelayFails(_withdrawalArgs(_payload(alice, TIP, ROUTE_USDT, USDT_OUT + 1), AMOUNT, 0));
  }

  function test_GivenThe3poolMissesTheMinOut_WhenTheUsdtPayloadIsRelayed_ThenItRevertsAndRecoverPaysTheDai() external {
    threePool.setRate(address(usdt), USDT_LOW_RATE);
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDT, 0), AMOUNT, 0);
    _assertRelayFails(args);

    _assertRecoverPaysTheDai(args);
  }

  function test_GivenUsdcBlocksTheRecipient_WhenTheUsdcPayloadIsRelayed_ThenItRevertsAndRecoverPaysTheDai() external {
    usdc.setBlocked(alice, true);
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, 0);
    _assertRelayFails(args);

    _assertRecoverPaysTheDai(args);
  }

  function test_GivenAProverTip_WhenRecovered_ThenTheRecipientGetsTheRestAfterTheFeeWithNoTipOrSubsidy() external {
    _priceTheSubsidy();
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, PROVER_TIP);
    bytes memory signature = _recoverySignature(executor, args.withdrawalId, recoveryRecipient, deadline, RECOVERY_KEY);
    address account = _recoveryAccount();
    uint256 subsidyBefore = dai.balanceOf(address(subsidy));

    vm.expectEmit(true, true, true, true, address(executor));
    emit StablecoinWithdrawalExecutor.Recovered(args.withdrawalId, recoveryRecipient, AMOUNT - PROVER_TIP - FEE);
    executor.recover(args, RECOVERY_SALT, account, signature, recoveryRecipient, deadline);

    _assertRecovered(args, AMOUNT - PROVER_TIP - FEE);
    assertEq(dai.balanceOf(address(portal)), PROVER_TIP);
    assertEq(dai.balanceOf(address(subsidy)), subsidyBefore, "no subsidy");
  }

  function test_GivenAWrongSignatureSaltOrDeadline_WhenRecovered_ThenItReverts() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, 0);
    IOxidePortal.WithdrawArgs memory other = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, 0);
    bytes memory signature = _recoverySignature(executor, args.withdrawalId, recoveryRecipient, deadline, RECOVERY_KEY);
    bytes4 invalid = RecoveryAuthLib.RecoveryAuthLib__InvalidSignature.selector;
    address account = _recoveryAccount();

    bytes memory otherKey = _recoverySignature(executor, args.withdrawalId, recoveryRecipient, deadline, OTHER_KEY);
    vm.expectRevert(invalid);
    executor.recover(args, RECOVERY_SALT, account, otherKey, recoveryRecipient, deadline);
    vm.expectRevert(invalid);
    executor.recover(args, RECOVERY_SALT, account, signature, makeAddr("thief"), deadline);
    vm.expectRevert(invalid);
    executor.recover(other, RECOVERY_SALT, account, signature, recoveryRecipient, deadline);
    vm.expectRevert(RecoveryAuthLib.RecoveryAuthLib__RecoveryCommitmentMismatch.selector);
    executor.recover(args, keccak256("wrong-salt"), account, signature, recoveryRecipient, deadline);
    vm.expectRevert(RecoveryAuthLib.RecoveryAuthLib__RecoveryCommitmentMismatch.selector);
    executor.recover(args, RECOVERY_SALT, vm.addr(OTHER_KEY), otherKey, recoveryRecipient, deadline);
    vm.warp(deadline + 1);
    vm.expectRevert(abi.encodeWithSelector(RecoveryAuthLib.RecoveryAuthLib__RecoveryExpired.selector, deadline));
    executor.recover(args, RECOVERY_SALT, account, signature, recoveryRecipient, deadline);

    assertFalse(portal.$isWithdrawalSpent(args.withdrawalId));
    assertEq(dai.balanceOf(recoveryRecipient), 0);
  }

  function test_GivenARecoveredWithdrawal_WhenRecoveredAgain_ThenItReverts() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, 0);
    _recover(executor, args, recoveryRecipient, deadline);
    bytes memory signature = _recoverySignature(executor, args.withdrawalId, recoveryRecipient, deadline, RECOVERY_KEY);

    vm.expectRevert(CoreErrors.OxidePortal__WithdrawalAlreadyClaimed.selector);
    executor.recover(args, RECOVERY_SALT, _recoveryAccount(), signature, recoveryRecipient, deadline);

    assertEq(dai.balanceOf(recoveryRecipient), AMOUNT - FEE);
  }

  function test_GivenARelayedWithdrawal_WhenRecovered_ThenItReverts() external {
    IOxidePortal.WithdrawArgs memory args = _relay(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT);
    bytes memory signature = _recoverySignature(executor, args.withdrawalId, recoveryRecipient, deadline, RECOVERY_KEY);

    vm.expectRevert(CoreErrors.OxidePortal__WithdrawalAlreadyClaimed.selector);
    executor.recover(args, RECOVERY_SALT, _recoveryAccount(), signature, recoveryRecipient, deadline);
  }

  function test_GivenAPayloadWithNoRecoveryCommitment_WhenRecovered_ThenItReverts() external {
    IOxidePortal.WithdrawArgs memory args =
      _withdrawalArgs(_payload(alice, TIP, ROUTE_DAI, 0, 0, bytes32(0)), AMOUNT, 0);
    bytes memory signature = _recoverySignature(executor, args.withdrawalId, recoveryRecipient, deadline, RECOVERY_KEY);

    vm.expectRevert(RecoveryAuthLib.RecoveryAuthLib__RecoveryCommitmentMismatch.selector);
    executor.recover(args, RECOVERY_SALT, _recoveryAccount(), signature, recoveryRecipient, deadline);
  }

  function test_GivenAUserPayloadOfAnotherLength_WhenRecovered_ThenItReverts() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(abi.encode(alice, TIP), AMOUNT, 0);
    bytes memory signature = _recoverySignature(executor, args.withdrawalId, recoveryRecipient, deadline, RECOVERY_KEY);

    vm.expectRevert(Errors.StablecoinWithdrawalExecutor__InvalidUserPayload.selector);
    executor.recover(args, RECOVERY_SALT, _recoveryAccount(), signature, recoveryRecipient, deadline);
  }

  function test_GivenAWithdrawalToAnotherExecutor_WhenRecovered_ThenItReverts() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawArgsFor(
      portal,
      address(plainWithdrawalExecutor),
      AMOUNT,
      0,
      _payload(alice, TIP, ROUTE_USDC, 0),
      abi.encodePacked(relayer)
    );
    bytes memory signature = _recoverySignature(executor, args.withdrawalId, recoveryRecipient, deadline, RECOVERY_KEY);

    vm.expectRevert(Errors.StablecoinWithdrawalExecutor__NotThisExecutor.selector);
    executor.recover(args, RECOVERY_SALT, _recoveryAccount(), signature, recoveryRecipient, deadline);
  }

  function test_GivenAZeroRecoveryRecipient_WhenRecovered_ThenItReverts() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, 0);
    bytes memory signature = _recoverySignature(executor, args.withdrawalId, address(0), deadline, RECOVERY_KEY);

    vm.expectRevert(Errors.StablecoinWithdrawalExecutor__ZeroRecoveryRecipient.selector);
    executor.recover(args, RECOVERY_SALT, _recoveryAccount(), signature, address(0), deadline);
  }

  function test_GivenARecover_WhenAnotherWithdrawalIsRelayedInTheSameTransaction_ThenItRunsItsRoute() external {
    _recover(executor, _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT, 0), recoveryRecipient, deadline);

    _relay(_payload(alice, TIP, ROUTE_USDC, 0), AMOUNT);

    assertEq(dai.balanceOf(recoveryRecipient), AMOUNT - FEE);
    assertEq(usdc.balanceOf(alice), USDC_OUT);
    assertEq(dai.balanceOf(relayer), TIP);
    _assertNothingSticks();
  }

  function test_GivenTheDaiRoute_WhenRelayed_ThenTheRecipientGetsTheAssetWhateverTheMinOut() external {
    _relay(_payload(alice, TIP, ROUTE_DAI, type(uint128).max), AMOUNT);

    assertEq(dai.balanceOf(alice), SWAPPED);
    assertEq(alice.balance, 0);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(threePool.callCount(), 0);
    assertEq(pair.callCount(), 0);
    _assertNothingSticks();
  }

  function test_GivenAGasShare_WhenEachOutputTokenIsRelayed_ThenTheRecipientGetsTheEthAndTheRestInTheToken() external {
    address[3] memory tokens = [address(dai), address(USDC), address(USDT)];
    uint8[3] memory routes = [ROUTE_DAI, ROUTE_USDC, ROUTE_USDT];
    uint256[3] memory routeOut =
      [SWAPPED - GAS_SHARE, (SWAPPED - GAS_SHARE) / TO_18, ((SWAPPED - GAS_SHARE) * USDT_RATE) / WAD];
    for (uint256 i = 0; i < tokens.length; i++) {
      uint256 ethOut = _pairEthOut(GAS_SHARE);
      assertGe(ethOut, _feedFloor(GAS_SHARE));
      uint256 ethBefore = alice.balance;
      uint256 tokenBefore = IERC20(tokens[i]).balanceOf(alice);
      uint256 relayerBefore = dai.balanceOf(relayer);

      _relay(_payload(alice, TIP, routes[i], 0, GAS_SHARE), AMOUNT);

      assertEq(alice.balance - ethBefore, ethOut, "the recipient gets the pair's ETH");
      assertEq(IERC20(tokens[i]).balanceOf(alice) - tokenBefore, routeOut[i], "the route gets the rest");
      assertEq(dai.balanceOf(relayer) - relayerBefore, TIP);
    }
    assertEq(pair.callCount(), tokens.length);
    _assertNothingSticks();
  }

  function test_GivenTheMaxDaiForGas_WhenRelayed_ThenTheRecipientGetsItsEth() external {
    uint256 maxDaiForGas = executor.MAX_DAI_FOR_GAS();
    assertEq(maxDaiForGas, 50e18);
    uint256 ethOut = _pairEthOut(maxDaiForGas);

    _relay(_payload(alice, TIP, ROUTE_DAI, 0, maxDaiForGas), AMOUNT);

    assertEq(alice.balance, ethOut);
    assertEq(dai.balanceOf(alice), SWAPPED - maxDaiForGas);
    _assertNothingSticks();
  }

  function test_GivenDaiForGasAboveTheMax_WhenRelayed_ThenItReverts() external {
    uint256 daiForGas = executor.MAX_DAI_FOR_GAS() + 1;
    _assertRelayReverts(
      _withdrawalArgs(_payload(alice, TIP, ROUTE_DAI, 0, daiForGas), AMOUNT, 0),
      abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__DaiForGasExceedsMax.selector, daiForGas)
    );
  }

  function test_GivenATipAndDaiForGasThatTakeTheWholeAmount_WhenRelayed_ThenTheRecipientGetsOnlyTheEth() external {
    uint256 amount = FEE + TIP + GAS_SHARE;
    uint256 ethOut = _pairEthOut(GAS_SHARE);

    _relay(_payload(alice, TIP, ROUTE_DAI, 0, GAS_SHARE), amount);

    assertEq(alice.balance, ethOut);
    assertEq(dai.balanceOf(alice), 0);
    assertEq(dai.balanceOf(relayer), TIP);
    _assertNothingSticks();
  }

  function test_GivenATipAndDaiForGasAboveTheAmount_WhenRelayed_ThenItReverts() external {
    _assertRelayReverts(
      _withdrawalArgs(_payload(alice, TIP, ROUTE_DAI, 0, GAS_SHARE + 1), FEE + TIP + GAS_SHARE, 0),
      abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__DaiForGasExceedsAmountAfterTip.selector)
    );
  }

  function test_GivenThePairPaysBelowTheFeedFloor_WhenAGasShareIsRelayed_ThenTheRouteGetsTheDai() external {
    feed.setAnswer(FEED_BELOW_PAIR_PRICE);
    assertLt(_pairEthOut(GAS_SHARE), _feedFloor(GAS_SHARE));

    _assertGasShareSkipped(GAS_SHARE);
  }

  function test_GivenAFeedPriceThatIsNotPositive_WhenAGasShareIsRelayed_ThenItRevertsAndRecoverPaysTheDai() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0, GAS_SHARE), AMOUNT, 0);
    int256[2] memory answers = [int256(0), -1];
    for (uint256 i = 0; i < answers.length; i++) {
      feed.setAnswer(answers[i]);
      _assertRelayReverts(args, abi.encodeWithSelector(Errors.EthUsdMinOut__InvalidPrice.selector, answers[i]));
    }

    _assertRecoverPaysTheDai(args);
  }

  function test_GivenAStaleOrFutureFeedPrice_WhenAGasShareIsRelayed_ThenItRevertsAndRecoverPaysTheDai() external {
    vm.warp(block.timestamp + 2 * EthUsdMinOutLib.MAX_PRICE_AGE);
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0, GAS_SHARE), AMOUNT, 0);

    uint256 staleAt = block.timestamp - EthUsdMinOutLib.MAX_PRICE_AGE - 1;
    feed.setUpdatedAt(staleAt);
    _assertRelayReverts(args, abi.encodeWithSelector(Errors.EthUsdMinOut__StalePrice.selector, staleAt));

    feed.setUpdatedAt(block.timestamp + 1);
    _assertRelayFails(args);

    _assertRecoverPaysTheDai(args);
  }

  function test_GivenAGasShareThatBuysNoEth_WhenRelayed_ThenTheRouteGetsTheDai() external {
    assertEq(_pairEthOut(1), 0);

    _assertGasShareSkipped(1);
  }

  function test_GivenAUsdcMinOutOnTheAmountAfterTheGasShare_WhenRelayed_ThenItPaysAndOneMoreReverts() external {
    uint256 minOut = (SWAPPED - GAS_SHARE) / TO_18;
    _relay(_payload(alice, TIP, ROUTE_USDC, minOut, GAS_SHARE), AMOUNT);
    assertEq(usdc.balanceOf(alice), minOut);

    _assertRelayReverts(
      _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, minOut + 1, GAS_SHARE), AMOUNT, 0),
      abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__InsufficientOutput.selector, minOut, minOut + 1)
    );
  }

  function test_GivenTheGasShareIsSkipped_WhenTheUsdcPayloadIsRelayed_ThenTheRecipientGetsMoreThanTheMinOut() external {
    feed.setAnswer(FEED_BELOW_PAIR_PRICE);
    uint256 minOut = (SWAPPED - GAS_SHARE) / TO_18;

    _relay(_payload(alice, TIP, ROUTE_USDC, minOut, GAS_SHARE), AMOUNT);

    assertEq(usdc.balanceOf(alice), SWAPPED / TO_18);
    assertEq(alice.balance, 0);
    _assertNothingSticks();
  }

  function test_GivenARecipientThatRejectsEth_WhenAGasShareIsRelayed_ThenItRevertsAndRecoverPaysTheDai() external {
    address rejecting = address(new EthRejectingRecipient());
    IOxidePortal.WithdrawArgs memory args =
      _withdrawalArgs(_payload(rejecting, TIP, ROUTE_USDC, 0, GAS_SHARE), AMOUNT, 0);
    _assertRelayReverts(args, abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__EthTransferFailed.selector));

    _assertRecoverPaysTheDai(args);
    assertEq(usdc.balanceOf(rejecting), 0);
  }

  function test_GivenARecipientThatReentersThePortal_WhenAGasShareIsRelayed_ThenThePayoutRunsOnce() external {
    PortalReenteringRecipient reentering = new PortalReenteringRecipient(address(portal));
    IOxidePortal.WithdrawArgs memory args =
      _withdrawalArgs(_payload(address(reentering), TIP, ROUTE_DAI, 0, GAS_SHARE), AMOUNT, 0);
    reentering.setReentry(abi.encodeCall(IOxidePortal.withdraw, (args)));
    uint256 ethOut = _pairEthOut(GAS_SHARE);

    vm.prank(relayer);
    portal.withdraw(args);

    assertFalse(reentering.reentrySucceeded());
    assertTrue(portal.$isWithdrawalSpent(args.withdrawalId));
    assertEq(address(reentering).balance, ethOut);
    assertEq(dai.balanceOf(address(reentering)), SWAPPED - GAS_SHARE);
    _assertNothingSticks();
  }

  function test_GivenAGasSharePayload_WhenRecovered_ThenTheRecipientGetsAllTheDaiAndNoEth() external {
    IOxidePortal.WithdrawArgs memory args = _withdrawalArgs(_payload(alice, TIP, ROUTE_USDC, 0, GAS_SHARE), AMOUNT, 0);

    _assertRecoverPaysTheDai(args);

    assertEq(recoveryRecipient.balance, 0);
    assertEq(alice.balance, 0);
    assertEq(pair.callCount(), 0);
  }

  function test_GivenEthFromAnAddressOtherThanWeth_WhenSent_ThenTheExecutorRejectsIt() external {
    vm.deal(alice, 1 ether);

    vm.prank(alice);
    (bool sent, bytes memory result) = address(executor).call{value: 1 ether}("");

    assertFalse(sent);
    assertEq(result, abi.encodeWithSelector(Errors.StablecoinWithdrawalExecutor__EthNotFromWeth.selector));
    assertEq(address(executor).balance, 0);
  }

  function _assertGasShareSkipped(uint256 _daiForGas) internal {
    uint256 daiBefore = dai.balanceOf(alice);
    uint256 relayerBefore = dai.balanceOf(relayer);
    uint256 pairSwapsBefore = pair.callCount();

    _relay(_payload(alice, TIP, ROUTE_DAI, 0, _daiForGas), AMOUNT);

    assertEq(alice.balance, 0, "no ETH");
    assertEq(dai.balanceOf(alice) - daiBefore, SWAPPED, "the route gets the gas share");
    assertEq(dai.balanceOf(relayer) - relayerBefore, TIP);
    assertEq(pair.callCount(), pairSwapsBefore, "no pair swap");
    _assertNothingSticks();
  }

  function _pairEthOut(uint256 _daiIn) internal view returns (uint256) {
    (uint256 reserve0, uint256 reserve1,) = pair.getReserves();
    (uint256 daiReserve, uint256 wethReserve) =
      pair.token0() == address(dai) ? (reserve0, reserve1) : (reserve1, reserve0);
    uint256 amountInWithFee = _daiIn * 997;
    return (amountInWithFee * wethReserve) / (daiReserve * 1000 + amountInWithFee);
  }

  function _feedFloor(uint256 _daiIn) internal view returns (uint256) {
    (, int256 answer,,,) = feed.latestRoundData();
    return (_daiIn * 10 ** feed.decimals() * (BPS - GAS_SHARE_SLIPPAGE_BPS)) / (uint256(answer) * BPS);
  }

  function _assertRecoverPaysTheDai(IOxidePortal.WithdrawArgs memory _args) internal {
    bytes memory signature = _recoverySignature(executor, _args.withdrawalId, recoveryRecipient, deadline, RECOVERY_KEY);
    address account = _recoveryAccount();

    vm.expectEmit(true, true, true, true, address(executor));
    emit StablecoinWithdrawalExecutor.Recovered(_args.withdrawalId, recoveryRecipient, AMOUNT - FEE);
    vm.prank(makeAddr("anyone"));
    executor.recover(_args, RECOVERY_SALT, account, signature, recoveryRecipient, deadline);

    _assertRecovered(_args, AMOUNT - FEE);
  }

  function _assertRecovered(IOxidePortal.WithdrawArgs memory _args, uint256 _paid) internal view {
    assertTrue(portal.$isWithdrawalSpent(_args.withdrawalId));
    assertEq(dai.balanceOf(recoveryRecipient), _paid);
    assertEq(dai.balanceOf(feeBeneficiary), FEE);
    assertEq(dai.balanceOf(relayer), 0);
    assertEq(dai.balanceOf(alice), 0);
    assertEq(usdc.balanceOf(alice), 0);
    assertEq(usdt.balanceOf(alice), 0);
    _assertNothingSticks();
  }

  function _assertNothingSticks() internal view {
    assertEq(dai.balanceOf(address(executor)), 0, "no DAI sticks");
    assertEq(usdc.balanceOf(address(executor)), 0, "no USDC sticks");
    assertEq(usdt.balanceOf(address(executor)), 0, "no USDT sticks");
    assertEq(dai.allowance(address(executor), address(psm)), 0, "no PSM allowance sticks");
    assertEq(dai.allowance(address(executor), address(threePool)), 0, "no 3pool allowance sticks");
    assertEq(address(executor).balance, 0, "no ETH sticks");
    assertEq(WETH.balanceOf(address(executor)), 0, "no WETH sticks");
  }

  function _priceTheSubsidy() internal {
    vm.prank(OWNER);
    subsidy.setFlowPricing(
      IExecutor.Flow.Withdrawal, PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: 100 ether})
    );
    dai.mint(address(subsidy), 100 ether);
    vm.fee(SUBSIDY_GAS_PRICE);
    vm.txGasPrice(SUBSIDY_GAS_PRICE);
  }

  function _withdrawalArgs(bytes memory _userPayload, uint256 _amount, uint256 _proverTip)
    internal
    returns (IOxidePortal.WithdrawArgs memory args)
  {
    args = _relayedArgs(portal, executor, _amount, _proverTip, _userPayload, relayer);
    dai.mint(address(portal), _amount);
  }

  function _relay(bytes memory _userPayload, uint256 _amount) internal returns (IOxidePortal.WithdrawArgs memory args) {
    args = _withdrawalArgs(_userPayload, _amount, 0);
    vm.prank(relayer);
    portal.withdraw(args);
    assertTrue(portal.$isWithdrawalSpent(args.withdrawalId));
  }

  function _assertRelayReverts(IOxidePortal.WithdrawArgs memory _args, bytes memory _revertData) internal {
    uint256 portalBalance = dai.balanceOf(address(portal));

    vm.prank(relayer);
    vm.expectRevert(_revertData);
    portal.withdraw(_args);

    _assertStaysPending(_args, portalBalance);
  }

  function _assertRelayFails(IOxidePortal.WithdrawArgs memory _args) internal {
    uint256 portalBalance = dai.balanceOf(address(portal));

    vm.prank(relayer);
    vm.expectRevert();
    portal.withdraw(_args);

    _assertStaysPending(_args, portalBalance);
  }

  function _assertStaysPending(IOxidePortal.WithdrawArgs memory _args, uint256 _portalBalance) internal view {
    assertFalse(portal.$isWithdrawalSpent(_args.withdrawalId), "the withdrawal stays pending");
    assertEq(dai.balanceOf(address(portal)), _portalBalance, "the portal keeps the funds");
  }

  function _prefix(bytes memory _data, uint256 _length) internal pure returns (bytes memory prefix) {
    prefix = new bytes(_length);
    for (uint256 i = 0; i < _length; i++) {
      prefix[i] = _data[i];
    }
  }
}
