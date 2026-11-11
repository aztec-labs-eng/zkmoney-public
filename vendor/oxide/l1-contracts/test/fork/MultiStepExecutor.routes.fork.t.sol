// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC4626} from "@oz/interfaces/IERC4626.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {DAI, USDC, USDT, THREE_POOL, POOL3_DAI_IDX, POOL3_USDT_IDX} from "@periphery/ThreePoolLib.sol";
import {Errors} from "@periphery/Errors.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {IDaiUsds} from "@periphery/interfaces/IDaiUsds.sol";
import {StandardOrder} from "@periphery/interfaces/ILifiInputSettlerEscrow.sol";
import {IMakerPsm} from "@periphery/interfaces/IMakerPsm.sol";
import {MultiStepExecutor} from "@periphery/MultiStepExecutor.sol";
import {AcrossAdapter} from "@periphery/adapters/AcrossAdapter.sol";
import {CctpAdapter} from "@periphery/adapters/CctpAdapter.sol";
import {CurveAdapter} from "@periphery/adapters/CurveAdapter.sol";
import {ERC4626Adapter} from "@periphery/adapters/ERC4626Adapter.sol";
import {LifiIntentAdapter} from "@periphery/adapters/LifiIntentAdapter.sol";
import {MakerPsmAdapter} from "@periphery/adapters/MakerPsmAdapter.sol";
import {PortalDepositAdapter} from "@periphery/adapters/PortalDepositAdapter.sol";
import {SkyConverterAdapter} from "@periphery/adapters/SkyConverterAdapter.sol";
import {UniswapV3Adapter} from "@periphery/adapters/UniswapV3Adapter.sol";
import {WethAdapter} from "@periphery/adapters/WethAdapter.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {ILifiInputSettlerEscrowSolver, LifiOrderStatus, LifiSolverFixture} from "@test/fork/LifiSolverFixture.sol";
import {MultiStepExecutorHelpers} from "@test/periphery/MultiStepExecutorTestBase.sol";

contract MultiStepExecutorRoutesForkTest is LifiSolverFixture, MultiStepExecutorHelpers {
  address internal constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  address internal constant LITE_PSM_USDC = 0xf6e72Db5454dd049d0788e411b06CfAF16853042;
  address internal constant USDS_PSM_USDC = 0xA188EEC8F81263234dA3622A406892F3D630f98c;
  address internal constant DAI_USDS = 0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A;
  address internal constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
  address internal constant SUSDS = 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD;
  address internal constant WA_ETH_USDC = 0xD4fa2D31b7968E448877f69A96DE69f5de8cD23E;
  uint24 internal constant POOL_FEE_500 = 500;
  ITokenMessengerV2 internal constant CCTP_TOKEN_MESSENGER =
    ITokenMessengerV2(0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d);
  uint32 internal constant CCTP_BASE_DOMAIN = 6;
  uint32 internal constant CCTP_FAST_FINALITY = 1000;
  uint256 internal constant CCTP_MAX_FEE = 1e6;
  IAcrossSpokePool internal constant ACROSS_SPOKE_POOL = IAcrossSpokePool(0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5);
  uint256 internal constant BNB_CHAIN_ID = 56;
  address internal constant BNB_USDT = 0x55d398326f99059fF775485246999027B3197955;
  uint8 internal constant BNB_USDT_DECIMALS = 18;
  uint256 internal constant ACROSS_FEE = 1e6;
  uint32 internal constant ACROSS_FILL_DEADLINE_OFFSET = 6 hours;

  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 5e18;
  uint256 internal constant SWAPPED = AMOUNT - TIP;
  uint256 internal constant GAS_DAI = 50e18;
  uint256 internal constant TO_18 = 1e12;

  uint256 internal constant USDC_MIN_OUT = SWAPPED / TO_18;
  uint256 internal constant USDT_MIN_OUT = 2460e6;
  uint256 internal constant ETH_ROUTE_USDC_MIN_OUT = 2470e6;
  uint256 internal constant ETH_MIN_OUT = 1.3e18;
  uint256 internal constant ETH_MIN_OUT_TOO_HIGH = 1.5e18;
  uint256 internal constant GAS_ETH_MIN_OUT = 0.025e18;
  uint256 internal constant GAS_TOP_UP_ROUTE_USDC_MIN_OUT = 2420e6;
  uint256 internal constant GAS_TOP_UP_ROUTE_ETH_MIN_OUT = 1.27e18;
  uint256 internal constant USDT_OUT_BAND_LOW = 2470e6;
  uint256 internal constant USDT_OUT_BAND_HIGH = 2520e6;
  uint256 internal constant ETH_OUT_BAND_LOW = 1.308e18;
  uint256 internal constant ETH_OUT_BAND_HIGH = 1.348e18;
  uint256 internal constant EXACT_OUT_DAI_IN = 1000e18;
  uint256 internal constant EXACT_OUT_WETH = 0.1e18;
  uint256 internal constant EXACT_OUT_DAI_SPENT_BAND_LOW = 170e18;
  uint256 internal constant EXACT_OUT_DAI_SPENT_BAND_HIGH = 210e18;
  uint256 internal constant REDEPOSIT_SWAPPED_DAI = 1000e18;
  uint256 internal constant REDEPOSIT_WETH_MIN_OUT = 0.52e18;
  uint256 internal constant REDEPOSIT_WETH_BAND_LOW = 0.524e18;
  uint256 internal constant REDEPOSIT_WETH_BAND_HIGH = 0.539e18;
  bytes32 internal constant WETH_REDEPOSIT_COMMITMENT = keccak256("wethRedepositCommitment");
  bytes32 internal constant DAI_REDEPOSIT_COMMITMENT = keccak256("daiRedepositCommitment");
  uint256 internal constant SAVINGS_ENTRY_MIN_SHARES = 2250e18;
  uint256 internal constant SAVINGS_ENTRY_SHARES_BAND_HIGH = 2270e18;
  bytes32 internal constant SAVINGS_COMMITMENT = keccak256("savingsCommitment");
  uint256 internal constant SUSDS_AMOUNT = 2000e18;
  uint256 internal constant SAVINGS_EXIT_MIN_USDS = 2200e18;
  uint256 internal constant SAVINGS_EXIT_USDC_MIN_OUT = 2200e6;
  uint256 internal constant SAVINGS_EXIT_USDC_BAND_HIGH = 2210e6;
  uint256 internal constant SAVINGS_EXIT_DAI_BAND_HIGH = 2210e18;
  uint256 internal constant LIFI_USDC_MIN_OUT = 2490e6;

  uint256 internal constant PLAIN_GAS_CEILING = 386_000;
  uint256 internal constant USDC_GAS_CEILING = 498_000;
  uint256 internal constant USDT_GAS_CEILING = 608_000;
  uint256 internal constant ETH_GAS_CEILING = 698_000;
  uint256 internal constant GAS_TOP_UP_GAS_CEILING = 841_000;
  uint256 internal constant REDEPOSIT_GAS_CEILING = 976_000;
  uint256 internal constant SAVINGS_ENTRY_GAS_CEILING = 955_000;
  uint256 internal constant SAVINGS_EXIT_TO_DAI_GAS_CEILING = 943_000;
  uint256 internal constant SAVINGS_EXIT_TO_USDC_GAS_CEILING = 766_000;
  uint256 internal constant LIFI_GAS_CEILING = 496_000;
  uint256 internal constant CCTP_GAS_CEILING = 609_000;
  uint256 internal constant ACROSS_GAS_CEILING = 685_000;

  OxidePortal internal daiPortal;
  OxidePortal internal wethPortal;
  OxidePortal internal sUsdsPortal;
  MultiStepExecutor internal executor;
  AcrossAdapter internal acrossAdapter;
  CctpAdapter internal cctpAdapter;
  CurveAdapter internal curveAdapter;
  ERC4626Adapter internal erc4626Adapter;
  LifiIntentAdapter internal lifiAdapter;
  MakerPsmAdapter internal psmAdapter;
  PortalDepositAdapter internal depositAdapter;
  SkyConverterAdapter internal skyConverterAdapter;
  UniswapV3Adapter internal uniswapV3Adapter;
  WethAdapter internal wethAdapter;

  address internal relayer = makeAddr("relayer");
  address internal recipient = makeAddr("recipient");
  address internal lifiRefundRecipient = makeAddr("lifiRefundRecipient");
  address internal lifiSolver = makeAddr("lifiSolver");
  address internal acrossDepositor = makeAddr("acrossDepositor");

  function setUp() public override(OxidePortalBase) {
    _selectMainnetFork();
    super.setUp();
    _registerSigner();

    daiPortal = _buildPortal(address(DAI));
    wethPortal = _buildPortal(WETH);
    sUsdsPortal = _buildPortal(SUSDS);
    executor = new MultiStepExecutor();
    acrossAdapter = new AcrossAdapter(ACROSS_SPOKE_POOL);
    cctpAdapter = new CctpAdapter(CCTP_TOKEN_MESSENGER, USDC);
    curveAdapter = new CurveAdapter();
    erc4626Adapter = new ERC4626Adapter();
    lifiAdapter = new LifiIntentAdapter();
    psmAdapter = new MakerPsmAdapter();
    depositAdapter = new PortalDepositAdapter();
    skyConverterAdapter = new SkyConverterAdapter(IDaiUsds(DAI_USDS));
    uniswapV3Adapter = new UniswapV3Adapter(IUniversalRouter(UNIVERSAL_ROUTER));
    wethAdapter = new WethAdapter(IWETH9(WETH));
  }

  function test_GivenThePlainRoute_WhenRelayed_ThenTheRecipientGetsDai() external {
    MultiStepExecutor.UserPayload memory userPayload = _routePayload(recipient, _noTransfers(), _noSteps());
    _logPayloadBytes("plain", userPayload);

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: plain DAI route, portal withdraw gas:", gasUsed);

    assertEq(DAI.balanceOf(recipient), SWAPPED);
    assertLe(gasUsed, PLAIN_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheUsdcRoute_WhenRelayed_ThenParityUsdcToTheRecipient() external {
    MultiStepExecutor.UserPayload memory userPayload = _usdcPayload(USDC_MIN_OUT);
    _logPayloadBytes("usdc", userPayload);

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: USDC route, portal withdraw gas:", gasUsed);

    assertEq(USDC.balanceOf(recipient), USDC_MIN_OUT);
    assertLe(gasUsed, USDC_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheUsdtRoute_WhenRelayed_ThenNearParityUsdtToTheRecipient() external {
    MultiStepExecutor.UserPayload memory userPayload = _curvePayload(POOL3_USDT_IDX, USDT_MIN_OUT);
    _logPayloadBytes("usdt", userPayload);

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: USDT route, portal withdraw gas:", gasUsed);

    uint256 usdtOut = USDT.balanceOf(recipient);
    assertGt(usdtOut, USDT_OUT_BAND_LOW);
    assertLt(usdtOut, USDT_OUT_BAND_HIGH);
    assertLe(gasUsed, USDT_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheEthRoute_WhenRelayed_ThenSpotConsistentEthToTheRecipient() external {
    MultiStepExecutor.UserPayload memory userPayload = _ethPayload(ETH_MIN_OUT);
    _logPayloadBytes("eth", userPayload);

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: ETH route, portal withdraw gas:", gasUsed);

    assertGt(recipient.balance, ETH_OUT_BAND_LOW);
    assertLt(recipient.balance, ETH_OUT_BAND_HIGH);
    assertLe(gasUsed, ETH_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheGasTopUpRoute_WhenRelayed_ThenGasEthAndRouteEthToTheRecipient() external {
    MultiStepExecutor.UserPayload memory userPayload = _gasTopUpPayload();
    _logPayloadBytes("gas top-up", userPayload);

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: gas top-up route, portal withdraw gas:", gasUsed);

    assertGt(recipient.balance, ETH_OUT_BAND_LOW);
    assertLt(recipient.balance, ETH_OUT_BAND_HIGH);
    assertLe(gasUsed, GAS_TOP_UP_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheRedepositRoute_WhenRelayed_ThenTheSwappedWethAndTheRestOfTheDaiAreDepositedBack() external {
    MultiStepExecutor.UserPayload memory userPayload = _routePayload(
      address(depositAdapter),
      _transfers(REDEPOSIT_SWAPPED_DAI, address(uniswapV3Adapter)),
      _steps(
        _uniswapV3ExactInStep(
          _v3Path(address(DAI), POOL_FEE_500, WETH), MAX, REDEPOSIT_WETH_MIN_OUT, address(depositAdapter)
        ),
        _portalDepositStep(wethPortal, MAX, WETH_REDEPOSIT_COMMITMENT),
        _portalDepositStep(daiPortal, MAX, DAI_REDEPOSIT_COMMITMENT)
      )
    );
    _logPayloadBytes("redeposit", userPayload);
    uint256 redepositedDai = SWAPPED - REDEPOSIT_SWAPPED_DAI;
    vm.expectCall(address(wethPortal), abi.encodeWithSelector(IOxidePortal.deposit.selector, WETH_REDEPOSIT_COMMITMENT));
    vm.expectCall(address(daiPortal), abi.encodeCall(IOxidePortal.deposit, (DAI_REDEPOSIT_COMMITMENT, redepositedDai)));

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: redeposit route, portal withdraw gas:", gasUsed);

    uint256 redepositedWeth = IERC20(WETH).balanceOf(address(wethPortal));
    assertGt(redepositedWeth, REDEPOSIT_WETH_BAND_LOW);
    assertLt(redepositedWeth, REDEPOSIT_WETH_BAND_HIGH);
    assertEq(DAI.balanceOf(address(daiPortal)), redepositedDai);
    assertEq(DAI.balanceOf(relayer), TIP);
    assertEq(DAI.balanceOf(address(uniswapV3Adapter)), 0);
    assertEq(DAI.balanceOf(address(depositAdapter)), 0);
    assertEq(IERC20(WETH).balanceOf(address(depositAdapter)), 0);
    assertLe(gasUsed, REDEPOSIT_GAS_CEILING);
  }

  function test_GivenTheSavingsEntryRoute_WhenRelayed_ThenTheDaiLandsInTheSUsdsPortalAsShares() external {
    MultiStepExecutor.UserPayload memory userPayload = _routePayload(
      address(skyConverterAdapter),
      _noTransfers(),
      _steps(
        _daiToUsdsStep(MAX, address(erc4626Adapter)),
        _erc4626DepositStep(IERC4626(SUSDS), MAX, SAVINGS_ENTRY_MIN_SHARES, address(depositAdapter)),
        _portalDepositStep(sUsdsPortal, MAX, SAVINGS_COMMITMENT)
      )
    );
    _logPayloadBytes("savings entry", userPayload);
    vm.expectCall(address(sUsdsPortal), abi.encodeWithSelector(IOxidePortal.deposit.selector, SAVINGS_COMMITMENT));

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: savings entry route, portal withdraw gas:", gasUsed);

    uint256 shares = IERC20(SUSDS).balanceOf(address(sUsdsPortal));
    assertGt(shares, SAVINGS_ENTRY_MIN_SHARES);
    assertLt(shares, SAVINGS_ENTRY_SHARES_BAND_HIGH);
    assertLe(gasUsed, SAVINGS_ENTRY_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheSavingsExitToDaiRoute_WhenRelayed_ThenTheDaiPortalTakesTheDaiForTheSUsds() external {
    MultiStepExecutor.UserPayload memory userPayload = _routePayload(
      address(erc4626Adapter),
      _noTransfers(),
      _steps(
        _erc4626RedeemStep(IERC4626(SUSDS), MAX, SAVINGS_EXIT_MIN_USDS, address(skyConverterAdapter)),
        _usdsToDaiStep(MAX, address(depositAdapter)),
        _portalDepositStep(daiPortal, MAX, DAI_REDEPOSIT_COMMITMENT)
      )
    );
    _logPayloadBytes("savings exit to DAI", userPayload);
    vm.expectCall(address(daiPortal), abi.encodeWithSelector(IOxidePortal.deposit.selector, DAI_REDEPOSIT_COMMITMENT));

    uint256 gasUsed = _relaySUsds(userPayload);
    console2.log("fork: savings exit to DAI route, portal withdraw gas:", gasUsed);

    uint256 deposited = DAI.balanceOf(address(daiPortal));
    assertGt(deposited, SAVINGS_EXIT_MIN_USDS);
    assertLt(deposited, SAVINGS_EXIT_DAI_BAND_HIGH);
    assertEq(IERC20(SUSDS).balanceOf(relayer), TIP);
    assertLe(gasUsed, SAVINGS_EXIT_TO_DAI_GAS_CEILING);
    _assertNothingSticks();
  }

  function test_GivenTheSavingsExitToUsdcRoute_WhenRelayed_ThenTheRecipientGetsUsdcForTheSUsds() external {
    MultiStepExecutor.UserPayload memory userPayload = _routePayload(
      address(erc4626Adapter),
      _noTransfers(),
      _steps(
        _erc4626RedeemStep(IERC4626(SUSDS), MAX, SAVINGS_EXIT_MIN_USDS, address(psmAdapter)),
        _psmBuyGemStep(IMakerPsm(USDS_PSM_USDC), MAX, SAVINGS_EXIT_USDC_MIN_OUT, recipient)
      )
    );
    _logPayloadBytes("savings exit to USDC", userPayload);

    uint256 gasUsed = _relaySUsds(userPayload);
    console2.log("fork: savings exit to USDC route, portal withdraw gas:", gasUsed);

    uint256 usdcOut = USDC.balanceOf(recipient);
    assertGt(usdcOut, SAVINGS_EXIT_USDC_MIN_OUT);
    assertLt(usdcOut, SAVINGS_EXIT_USDC_BAND_HIGH);
    assertEq(IERC20(SUSDS).balanceOf(relayer), TIP);
    assertLe(gasUsed, SAVINGS_EXIT_TO_USDC_GAS_CEILING);
    _assertNothingSticks();
  }

  function test_GivenTheLifiIntentHookRoute_WhenRelayedAndSolved_ThenTheRecipientGetsWaEthUsdcForTheUsdc() external {
    uint256 shares = IERC4626(WA_ETH_USDC).previewDeposit(LIFI_USDC_MIN_OUT);
    LifiIntentAdapter.Open memory open =
      _lifiSameChainOpen(address(lifiAdapter), LIFI_USDC_MIN_OUT, lifiRefundRecipient);
    bytes memory callbackData = abi.encode(
      address(erc4626Adapter), recipient, _steps(_erc4626DepositStep(IERC4626(WA_ETH_USDC), MAX, shares, recipient))
    );
    MultiStepExecutor.UserPayload memory userPayload =
      _routePayload(address(lifiAdapter), _noTransfers(), _steps(_lifiOpenWithHookStep(open, callbackData)));
    _logPayloadBytes("lifi intent with hook", userPayload);
    StandardOrder memory order = _lifiOrder(open, SWAPPED, callbackData);

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: LI.FI intent hook route, portal withdraw gas:", gasUsed);
    assertEq(uint8(_lifiOrderStatus(order)), uint8(LifiOrderStatus.Deposited));

    _lifiSolve(order, lifiSolver);

    assertEq(IERC20(WA_ETH_USDC).balanceOf(recipient), shares);
    assertEq(USDC.balanceOf(recipient), 0);
    assertEq(IERC20(WA_ETH_USDC).balanceOf(address(erc4626Adapter)), 0);
    assertEq(DAI.balanceOf(lifiSolver), SWAPPED);
    assertEq(DAI.balanceOf(lifiRefundRecipient), 0);
    assertEq(uint8(_lifiOrderStatus(order)), uint8(LifiOrderStatus.Claimed));
    assertLe(gasUsed, LIFI_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheLifiIntentRoute_WhenNoSolverFillsBeforeExpiry_ThenTheRefundRecipientGetsTheDai() external {
    LifiIntentAdapter.Open memory open = _lifiSameChainOpen(recipient, LIFI_USDC_MIN_OUT, lifiRefundRecipient);
    MultiStepExecutor.UserPayload memory userPayload =
      _routePayload(address(lifiAdapter), _noTransfers(), _steps(_lifiOpenStep(open)));
    StandardOrder memory order = _lifiOrder(open, SWAPPED, "");
    _relay(userPayload);

    vm.warp(uint256(order.expires) + 1);
    vm.prank(makeAddr("anyone"));
    ILifiInputSettlerEscrowSolver(LIFI_INPUT_SETTLER).refund(order);

    assertEq(DAI.balanceOf(lifiRefundRecipient), SWAPPED);
    assertEq(USDC.balanceOf(recipient), 0);
    assertEq(uint8(_lifiOrderStatus(order)), uint8(LifiOrderStatus.Refunded));
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheCctpRoute_WhenRelayed_ThenTheUsdcIsBurnedForTheRecipientOnBase() external {
    bytes32 mintRecipient = _toBytes32(recipient);
    MultiStepExecutor.UserPayload memory userPayload = _routePayload(
      address(psmAdapter),
      _noTransfers(),
      _steps(
        _psmBuyGemStep(IMakerPsm(LITE_PSM_USDC), MAX, USDC_MIN_OUT, address(cctpAdapter)),
        _cctpDepositStep(MAX, CCTP_BASE_DOMAIN, mintRecipient, CCTP_MAX_FEE, CCTP_FAST_FINALITY)
      )
    );
    _logPayloadBytes("cctp", userPayload);
    uint256 supplyBefore = USDC.totalSupply();
    vm.expectCall(
      address(CCTP_TOKEN_MESSENGER),
      abi.encodeCall(
        ITokenMessengerV2.depositForBurn,
        (USDC_MIN_OUT, CCTP_BASE_DOMAIN, mintRecipient, address(USDC), bytes32(0), CCTP_MAX_FEE, CCTP_FAST_FINALITY)
      )
    );

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: CCTP route, portal withdraw gas:", gasUsed);

    assertEq(USDC.totalSupply(), supplyBefore - USDC_MIN_OUT);
    assertLe(gasUsed, CCTP_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheAcrossRoute_WhenRelayed_ThenTheUsdtIsDepositedOnAcrossForTheRecipientOnBnb() external {
    AcrossAdapter.Deposit memory deposit = AcrossAdapter.Deposit({
      inputToken: USDT,
      amount: MAX,
      destinationChainId: BNB_CHAIN_ID,
      outputToken: BNB_USDT,
      outputDecimals: BNB_USDT_DECIMALS,
      recipient: recipient,
      fee: ACROSS_FEE,
      depositor: acrossDepositor,
      fillDeadlineOffset: ACROSS_FILL_DEADLINE_OFFSET
    });
    MultiStepExecutor.UserPayload memory userPayload = _routePayload(
      address(curveAdapter),
      _noTransfers(),
      _steps(
        _curveStep(THREE_POOL, POOL3_DAI_IDX, POOL3_USDT_IDX, MAX, USDT_MIN_OUT, address(acrossAdapter)),
        _acrossDepositStep(deposit)
      )
    );
    _logPayloadBytes("across", userPayload);
    uint256 usdtIn = _previewDaiToUsdt(SWAPPED);
    uint256 spokePoolBefore = USDT.balanceOf(address(ACROSS_SPOKE_POOL));
    vm.expectEmit(true, false, true, true, address(ACROSS_SPOKE_POOL));
    emit IAcrossSpokePool.FundsDeposited(
      _toBytes32(address(USDT)),
      _toBytes32(BNB_USDT),
      usdtIn,
      (usdtIn - ACROSS_FEE) * TO_18,
      BNB_CHAIN_ID,
      0,
      uint32(block.timestamp),
      uint32(block.timestamp) + ACROSS_FILL_DEADLINE_OFFSET,
      0,
      _toBytes32(acrossDepositor),
      _toBytes32(recipient),
      bytes32(0),
      ""
    );

    uint256 gasUsed = _relay(userPayload);
    console2.log("fork: Across route, portal withdraw gas:", gasUsed);

    assertEq(USDT.balanceOf(address(ACROSS_SPOKE_POOL)), spokePoolBefore + usdtIn);
    assertLe(gasUsed, ACROSS_GAS_CEILING);
    _assertTipPaidAndNothingSticks();
  }

  function test_GivenTheUsdcRoute_WhenTheMinOutIsTooHigh_ThenTheWithdrawalStaysPending() external {
    _assertRelayReverts(
      _usdcPayload(USDC_MIN_OUT + 1),
      abi.encodeWithSelector(Errors.MakerPsmAdapter__InsufficientOutput.selector, USDC_MIN_OUT, USDC_MIN_OUT + 1)
    );
    assertEq(USDC.balanceOf(recipient), 0);
  }

  function test_GivenTheEthRoute_WhenTheMinOutIsTooHigh_ThenTheWithdrawalStaysPending() external {
    _assertRelayReverts(_ethPayload(ETH_MIN_OUT_TOO_HIGH), abi.encodeWithSignature("V3TooLittleReceived()"));
    assertEq(recipient.balance, 0);
  }

  function test_GivenAnExactOutSwap_WhenCalledOnTheAdapter_ThenExactWethOutAndTheUnspentDaiGoesToTheLeftoverRecipient()
    external
  {
    address leftoverRecipient = makeAddr("leftoverRecipient");
    deal(address(DAI), address(uniswapV3Adapter), EXACT_OUT_DAI_IN);

    uniswapV3Adapter.uniswapV3ExactOut(
      _v3Path(WETH, POOL_FEE_500, address(DAI)), EXACT_OUT_WETH, MAX, recipient, leftoverRecipient
    );

    assertEq(IERC20(WETH).balanceOf(recipient), EXACT_OUT_WETH);
    uint256 daiSpent = EXACT_OUT_DAI_IN - DAI.balanceOf(leftoverRecipient);
    assertGt(daiSpent, EXACT_OUT_DAI_SPENT_BAND_LOW);
    assertLt(daiSpent, EXACT_OUT_DAI_SPENT_BAND_HIGH);
    assertEq(DAI.balanceOf(address(uniswapV3Adapter)), 0);
    assertEq(DAI.balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(IERC20(WETH).balanceOf(UNIVERSAL_ROUTER), 0);
  }

  function _routePayload(
    address _remainderRecipient,
    MultiStepExecutor.Transfer[] memory _transferList,
    MultiStepExecutor.Step[] memory _stepList
  ) internal pure returns (MultiStepExecutor.UserPayload memory) {
    return _payload(TIP, keccak256("recovery"), _remainderRecipient, _transferList, _stepList);
  }

  function _usdcPayload(uint256 _minOut) internal view returns (MultiStepExecutor.UserPayload memory) {
    return _routePayload(
      address(psmAdapter), _noTransfers(), _steps(_psmBuyGemStep(IMakerPsm(LITE_PSM_USDC), MAX, _minOut, recipient))
    );
  }

  function _curvePayload(int128 _j, uint256 _minOut) internal view returns (MultiStepExecutor.UserPayload memory) {
    return _routePayload(
      address(curveAdapter), _noTransfers(), _steps(_curveStep(THREE_POOL, POOL3_DAI_IDX, _j, MAX, _minOut, recipient))
    );
  }

  function _ethPayload(uint256 _ethMinOut) internal view returns (MultiStepExecutor.UserPayload memory) {
    return _routePayload(
      address(psmAdapter),
      _noTransfers(),
      _steps(
        _psmBuyGemStep(IMakerPsm(LITE_PSM_USDC), MAX, ETH_ROUTE_USDC_MIN_OUT, address(uniswapV3Adapter)),
        _uniswapV3ExactInStep(_v3Path(address(USDC), POOL_FEE_500, WETH), MAX, _ethMinOut, address(wethAdapter)),
        _unwrapStep(MAX, recipient)
      )
    );
  }

  function _gasTopUpPayload() internal view returns (MultiStepExecutor.UserPayload memory) {
    return _routePayload(
      address(psmAdapter),
      _transfers(GAS_DAI, address(uniswapV3Adapter)),
      _steps(
        _uniswapV3ExactInStep(_v3Path(address(DAI), POOL_FEE_500, WETH), MAX, GAS_ETH_MIN_OUT, address(wethAdapter)),
        _psmBuyGemStep(IMakerPsm(LITE_PSM_USDC), MAX, GAS_TOP_UP_ROUTE_USDC_MIN_OUT, address(uniswapV3Adapter)),
        _uniswapV3ExactInStep(
          _v3Path(address(USDC), POOL_FEE_500, WETH), MAX, GAS_TOP_UP_ROUTE_ETH_MIN_OUT, address(wethAdapter)
        ),
        _unwrapStep(MAX, recipient)
      )
    );
  }

  function _curveStep(ICurve3Pool _pool, int128 _i, int128 _j, uint256 _amountIn, uint256 _minOut, address _recipient)
    internal
    view
    returns (MultiStepExecutor.Step memory)
  {
    return MultiStepExecutor.Step({
      target: address(curveAdapter),
      data: abi.encodeCall(CurveAdapter.curveExchange, (_pool, _i, _j, _amountIn, _minOut, _recipient))
    });
  }

  function _daiToUsdsStep(uint256 _amount, address _recipient) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({
      target: address(skyConverterAdapter), data: abi.encodeCall(SkyConverterAdapter.daiToUsds, (_amount, _recipient))
    });
  }

  function _usdsToDaiStep(uint256 _amount, address _recipient) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({
      target: address(skyConverterAdapter), data: abi.encodeCall(SkyConverterAdapter.usdsToDai, (_amount, _recipient))
    });
  }

  function _erc4626DepositStep(IERC4626 _vault, uint256 _assets, uint256 _minShares, address _recipient)
    internal
    view
    returns (MultiStepExecutor.Step memory)
  {
    return MultiStepExecutor.Step({
      target: address(erc4626Adapter),
      data: abi.encodeCall(ERC4626Adapter.erc4626Deposit, (_vault, _assets, _minShares, _recipient))
    });
  }

  function _erc4626RedeemStep(IERC4626 _vault, uint256 _shares, uint256 _minAssets, address _recipient)
    internal
    view
    returns (MultiStepExecutor.Step memory)
  {
    return MultiStepExecutor.Step({
      target: address(erc4626Adapter),
      data: abi.encodeCall(ERC4626Adapter.erc4626Redeem, (_vault, _shares, _minAssets, _recipient))
    });
  }

  function _psmBuyGemStep(IMakerPsm _psm, uint256 _amountIn, uint256 _minOut, address _recipient)
    internal
    view
    returns (MultiStepExecutor.Step memory)
  {
    return MultiStepExecutor.Step({
      target: address(psmAdapter),
      data: abi.encodeCall(MakerPsmAdapter.psmBuyGem, (_psm, _amountIn, _minOut, _recipient))
    });
  }

  function _uniswapV3ExactInStep(bytes memory _path, uint256 _amountIn, uint256 _minOut, address _recipient)
    internal
    view
    returns (MultiStepExecutor.Step memory)
  {
    return MultiStepExecutor.Step({
      target: address(uniswapV3Adapter),
      data: abi.encodeCall(UniswapV3Adapter.uniswapV3ExactIn, (_path, _amountIn, _minOut, _recipient))
    });
  }

  function _lifiOpenStep(LifiIntentAdapter.Open memory _open) internal view returns (MultiStepExecutor.Step memory) {
    return
      MultiStepExecutor.Step({target: address(lifiAdapter), data: abi.encodeCall(LifiIntentAdapter.lifiOpen, (_open))});
  }

  function _lifiOpenWithHookStep(LifiIntentAdapter.Open memory _open, bytes memory _callbackData)
    internal
    view
    returns (MultiStepExecutor.Step memory)
  {
    LifiIntentAdapter.OpenWithHook memory openWithHook = LifiIntentAdapter.OpenWithHook({
      token: _open.token,
      amount: _open.amount,
      destinationChainId: _open.destinationChainId,
      inputSettler: _open.inputSettler,
      inputOracle: _open.inputOracle,
      outputOracle: _open.outputOracle,
      outputSettler: _open.outputSettler,
      outputToken: _open.outputToken,
      recipient: _open.recipient,
      minOutput: _open.minOutput,
      refundRecipient: _open.refundRecipient,
      nonce: _open.nonce,
      fillWindow: _open.fillWindow,
      expiryWindow: _open.expiryWindow,
      context: _open.context,
      callbackData: _callbackData
    });
    return MultiStepExecutor.Step({
      target: address(lifiAdapter), data: abi.encodeCall(LifiIntentAdapter.lifiOpenWithHook, (openWithHook))
    });
  }

  function _cctpDepositStep(
    uint256 _amount,
    uint32 _destinationDomain,
    bytes32 _mintRecipient,
    uint256 _maxFee,
    uint32 _minFinalityThreshold
  ) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({
      target: address(cctpAdapter),
      data: abi.encodeCall(
        CctpAdapter.cctpDeposit, (_amount, _destinationDomain, _mintRecipient, _maxFee, _minFinalityThreshold)
      )
    });
  }

  function _acrossDepositStep(AcrossAdapter.Deposit memory _deposit)
    internal
    view
    returns (MultiStepExecutor.Step memory)
  {
    return MultiStepExecutor.Step({
      target: address(acrossAdapter), data: abi.encodeCall(AcrossAdapter.acrossDeposit, (_deposit))
    });
  }

  function _portalDepositStep(IOxidePortal _portal, uint256 _amount, bytes32 _recipientCommitment)
    internal
    view
    returns (MultiStepExecutor.Step memory)
  {
    return MultiStepExecutor.Step({
      target: address(depositAdapter),
      data: abi.encodeCall(PortalDepositAdapter.portalDeposit, (_portal, _amount, _recipientCommitment))
    });
  }

  function _unwrapStep(uint256 _amount, address _recipient) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({
      target: address(wethAdapter), data: abi.encodeCall(WethAdapter.unwrapWeth, (_amount, _recipient))
    });
  }

  function _v3Path(address _tokenIn, uint24 _fee, address _tokenOut) internal pure returns (bytes memory) {
    return abi.encodePacked(_tokenIn, _fee, _tokenOut);
  }

  function _toBytes32(address _address) internal pure returns (bytes32) {
    return bytes32(uint256(uint160(_address)));
  }

  function _logPayloadBytes(string memory _route, MultiStepExecutor.UserPayload memory _userPayload) internal pure {
    console2.log(string.concat("fork: ", _route, " route, user payload bytes:"), abi.encode(_userPayload).length);
  }

  function _assertTipPaidAndNothingSticks() internal view {
    assertEq(DAI.balanceOf(relayer), TIP);
    assertEq(DAI.balanceOf(address(daiPortal)), 0);
    _assertNothingSticks();
  }

  function _assertNothingSticks() internal view {
    assertEq(DAI.balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(USDC.balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(IERC20(WETH).balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(UNIVERSAL_ROUTER.balance, 0);
    address[11] memory holders = [
      address(executor),
      address(acrossAdapter),
      address(cctpAdapter),
      address(curveAdapter),
      address(psmAdapter),
      address(uniswapV3Adapter),
      address(wethAdapter),
      address(depositAdapter),
      address(skyConverterAdapter),
      address(erc4626Adapter),
      address(lifiAdapter)
    ];
    for (uint256 i = 0; i < holders.length; i++) {
      if (holders[i] == address(psmAdapter)) {
        assertLt(DAI.balanceOf(holders[i]), TO_18, "only DAI dust below one USDC unit sticks");
        assertLt(IERC20(USDS).balanceOf(holders[i]), TO_18, "only USDS dust below one USDC unit sticks");
      } else {
        assertEq(DAI.balanceOf(holders[i]), 0, "no DAI sticks");
        assertEq(IERC20(USDS).balanceOf(holders[i]), 0, "no USDS sticks");
      }
      assertEq(USDC.balanceOf(holders[i]), 0, "no USDC sticks");
      assertEq(USDT.balanceOf(holders[i]), 0, "no USDT sticks");
      assertEq(IERC20(WETH).balanceOf(holders[i]), 0, "no WETH sticks");
      assertEq(IERC20(SUSDS).balanceOf(holders[i]), 0, "no sUSDS sticks");
      assertEq(holders[i].balance, 0, "no ETH sticks");
    }
  }

  function _relayArgs(
    OxidePortal _portal,
    address _token,
    uint256 _amount,
    MultiStepExecutor.UserPayload memory _userPayload
  ) internal returns (IOxidePortal.WithdrawArgs memory args) {
    args = _withdrawArgsFor(_portal, address(executor), _amount, 0, abi.encode(_userPayload), abi.encodePacked(relayer));
    deal(_token, address(_portal), _amount);
  }

  function _previewDaiToUsdt(uint256 _daiIn) internal returns (uint256 usdtOut) {
    uint256 snapshot = vm.snapshotState();
    uint256 usdtBefore = USDT.balanceOf(address(this));
    deal(address(DAI), address(this), _daiIn);
    DAI.approve(address(THREE_POOL), _daiIn);
    THREE_POOL.exchange(POOL3_DAI_IDX, POOL3_USDT_IDX, _daiIn, 0);
    usdtOut = USDT.balanceOf(address(this)) - usdtBefore;
    vm.revertToState(snapshot);
  }

  function _relay(MultiStepExecutor.UserPayload memory _userPayload) internal returns (uint256 gasUsed) {
    gasUsed = _relayOn(daiPortal, address(DAI), AMOUNT, _userPayload);
  }

  function _relaySUsds(MultiStepExecutor.UserPayload memory _userPayload) internal returns (uint256 gasUsed) {
    gasUsed = _relayOn(sUsdsPortal, SUSDS, SUSDS_AMOUNT, _userPayload);
  }

  function _relayOn(
    OxidePortal _portal,
    address _token,
    uint256 _amount,
    MultiStepExecutor.UserPayload memory _userPayload
  ) internal returns (uint256 gasUsed) {
    IOxidePortal.WithdrawArgs memory args = _relayArgs(_portal, _token, _amount, _userPayload);
    vm.prank(relayer);
    uint256 before = gasleft();
    _portal.withdraw(args);
    gasUsed = before - gasleft();
    assertTrue(_portal.$isWithdrawalSpent(args.withdrawalId));
  }

  function _assertRelayReverts(MultiStepExecutor.UserPayload memory _userPayload, bytes memory _revertData) internal {
    IOxidePortal.WithdrawArgs memory args = _relayArgs(daiPortal, address(DAI), AMOUNT, _userPayload);

    vm.prank(relayer);
    vm.expectRevert(_revertData);
    daiPortal.withdraw(args);

    assertFalse(daiPortal.$isWithdrawalSpent(args.withdrawalId), "the withdrawal stays pending");
    assertEq(DAI.balanceOf(address(daiPortal)), AMOUNT, "the portal keeps the funds");
    assertEq(DAI.balanceOf(relayer), 0);
  }
}
