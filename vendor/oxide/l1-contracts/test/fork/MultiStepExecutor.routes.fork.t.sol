// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {DAI, USDC, USDT, THREE_POOL, POOL3_DAI_IDX, POOL3_USDT_IDX} from "@periphery/ThreePoolLib.sol";
import {Errors} from "@periphery/Errors.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {IMakerPsm} from "@periphery/interfaces/IMakerPsm.sol";
import {MultiStepExecutor} from "@periphery/MultiStepExecutor.sol";
import {CurveAdapter} from "@periphery/adapters/CurveAdapter.sol";
import {MakerPsmAdapter} from "@periphery/adapters/MakerPsmAdapter.sol";
import {UniswapV3Adapter} from "@periphery/adapters/UniswapV3Adapter.sol";
import {WethAdapter} from "@periphery/adapters/WethAdapter.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";
import {MultiStepExecutorHelpers} from "@test/periphery/MultiStepExecutorTestBase.sol";

contract MultiStepExecutorRoutesForkTest is MainnetForkFixture, MultiStepExecutorHelpers {
  address internal constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  address internal constant LITE_PSM_USDC = 0xf6e72Db5454dd049d0788e411b06CfAF16853042;
  uint24 internal constant POOL_FEE_500 = 500;

  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 5e18;
  uint256 internal constant SWAPPED = AMOUNT - TIP;
  uint256 internal constant GAS_DAI = 50e18;

  uint256 internal constant USDC_MIN_OUT = SWAPPED / 1e12;
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

  uint256 internal constant PLAIN_GAS_CEILING = 386_000;
  uint256 internal constant USDC_GAS_CEILING = 498_000;
  uint256 internal constant USDT_GAS_CEILING = 608_000;
  uint256 internal constant ETH_GAS_CEILING = 698_000;
  uint256 internal constant GAS_TOP_UP_GAS_CEILING = 841_000;

  OxidePortal internal daiPortal;
  MultiStepExecutor internal executor;
  CurveAdapter internal curveAdapter;
  MakerPsmAdapter internal psmAdapter;
  UniswapV3Adapter internal uniswapV3Adapter;
  WethAdapter internal wethAdapter;

  address internal relayer = makeAddr("relayer");
  address internal recipient = makeAddr("recipient");

  function setUp() public override(OxidePortalBase) {
    _selectMainnetFork();
    super.setUp();
    _registerSigner();

    daiPortal = _buildPortal(address(DAI));
    executor = new MultiStepExecutor(address(daiPortal), 0, address(0));
    curveAdapter = new CurveAdapter();
    psmAdapter = new MakerPsmAdapter();
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

  function _unwrapStep(uint256 _amount, address _recipient) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({
      target: address(wethAdapter), data: abi.encodeCall(WethAdapter.unwrapWeth, (_amount, _recipient))
    });
  }

  function _v3Path(address _tokenIn, uint24 _fee, address _tokenOut) internal pure returns (bytes memory) {
    return abi.encodePacked(_tokenIn, _fee, _tokenOut);
  }

  function _logPayloadBytes(string memory _route, MultiStepExecutor.UserPayload memory _userPayload) internal pure {
    console2.log(string.concat("fork: ", _route, " route, user payload bytes:"), abi.encode(_userPayload).length);
  }

  function _assertTipPaidAndNothingSticks() internal view {
    assertEq(DAI.balanceOf(relayer), TIP);
    assertEq(DAI.balanceOf(address(daiPortal)), 0);
    assertEq(DAI.balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(USDC.balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(IERC20(WETH).balanceOf(UNIVERSAL_ROUTER), 0);
    assertEq(UNIVERSAL_ROUTER.balance, 0);
    address[5] memory holders =
      [address(executor), address(curveAdapter), address(psmAdapter), address(uniswapV3Adapter), address(wethAdapter)];
    for (uint256 i = 0; i < holders.length; i++) {
      if (holders[i] == address(psmAdapter)) {
        assertLt(DAI.balanceOf(holders[i]), 1e12, "only DAI dust below one USDC unit sticks");
      } else {
        assertEq(DAI.balanceOf(holders[i]), 0, "no DAI sticks");
      }
      assertEq(USDC.balanceOf(holders[i]), 0, "no USDC sticks");
      assertEq(USDT.balanceOf(holders[i]), 0, "no USDT sticks");
      assertEq(IERC20(WETH).balanceOf(holders[i]), 0, "no WETH sticks");
      assertEq(holders[i].balance, 0, "no ETH sticks");
    }
  }

  function _relayArgs(MultiStepExecutor.UserPayload memory _userPayload)
    internal
    returns (IOxidePortal.WithdrawArgs memory args)
  {
    args = _withdrawArgsFor(
      daiPortal, address(executor), AMOUNT, 0, abi.encode(_userPayload), abi.encodePacked(relayer)
    );
    deal(address(DAI), address(daiPortal), AMOUNT);
  }

  function _relay(MultiStepExecutor.UserPayload memory _userPayload) internal returns (uint256 gasUsed) {
    IOxidePortal.WithdrawArgs memory args = _relayArgs(_userPayload);
    vm.prank(relayer);
    uint256 before = gasleft();
    daiPortal.withdraw(args);
    gasUsed = before - gasleft();
    assertTrue(daiPortal.$isWithdrawalSpent(args.withdrawalId));
  }

  function _assertRelayReverts(MultiStepExecutor.UserPayload memory _userPayload, bytes memory _revertData) internal {
    IOxidePortal.WithdrawArgs memory args = _relayArgs(_userPayload);

    vm.prank(relayer);
    vm.expectRevert(_revertData);
    daiPortal.withdraw(args);

    assertFalse(daiPortal.$isWithdrawalSpent(args.withdrawalId), "the withdrawal stays pending");
    assertEq(DAI.balanceOf(address(daiPortal)), AMOUNT, "the portal keeps the funds");
    assertEq(DAI.balanceOf(relayer), 0);
  }
}
