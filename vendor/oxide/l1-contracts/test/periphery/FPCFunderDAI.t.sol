// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {FPCFunderDAI} from "@periphery/fpc_funder/FPCFunderDAI.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Errors} from "@periphery/Errors.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {MockRegistry} from "@test/fixtures/MockRegistry.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

interface IMintable {
  function mint(address _to, uint256 _amount) external;
}

contract MockUniversalRouter {
  address public immutable TOKEN_IN;
  address public immutable TOKEN_OUT;
  bytes public lastCommands;
  uint256 public lastValue;
  bytes[] internal $inputs;

  constructor(address _tokenIn, address _tokenOut) {
    TOKEN_IN = _tokenIn;
    TOKEN_OUT = _tokenOut;
  }

  function inputAt(uint256 _i) external view returns (bytes memory) {
    return $inputs[_i];
  }

  function inputCount() external view returns (uint256) {
    return $inputs.length;
  }

  function execute(bytes calldata _commands, bytes[] calldata _inputs, uint256) external payable {
    lastCommands = _commands;
    lastValue = msg.value;
    delete $inputs;
    for (uint256 i = 0; i < _inputs.length; i++) {
      $inputs.push(_inputs[i]);
    }
    uint256 amountIn = TOKEN_IN == address(0) ? 0 : IERC20(TOKEN_IN).balanceOf(address(this));
    IMintable(TOKEN_OUT).mint(msg.sender, amountIn + msg.value);
  }
}

contract MockPullFeeJuicePortal {
  IERC20 public immutable UNDERLYING;
  bytes32 public lastTo;
  uint256 public lastAmount;
  bytes32 public lastSecretHash;

  constructor(IERC20 _underlying) {
    UNDERLYING = _underlying;
  }

  function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash) external returns (bytes32, uint256) {
    UNDERLYING.transferFrom(msg.sender, address(this), _amount);
    lastTo = _to;
    lastAmount = _amount;
    lastSecretHash = _secretHash;
    return (bytes32(uint256(0xAB)), 7);
  }
}

abstract contract FPCFunderBase is Test {
  bytes32 internal constant BENEFICIARY = bytes32(uint256(0xFBC));
  uint256 internal constant ROLLUP_VERSION = 7;

  address internal constant FEE_ASSET = address(0x2222);

  uint256 internal constant CONTRACT_BALANCE = 1 << 255;

  uint256 internal constant MIN_FUNDABLE_BALANCE = 5e18;
  uint256 internal constant MIN_BOUNTY_BPS = 1;
  uint256 internal constant MAX_BOUNTY_BPS = 1000;
  uint256 internal constant BOUNTY_RAMP_DURATION = 24 hours;

  int256 internal constant ETH_USD_ANSWER = 2500e8;

  MintableToken internal feeAsset;
  MockPullFeeJuicePortal internal feeJuicePortal;
  MockRollup internal rollup;
  MockRegistry internal registry;
  MockV3Aggregator internal ethUsdFeed;

  event Funded(uint256 feeAssetAmount, uint256 bounty, bytes32 key, uint256 index);

  function setUp() public virtual {
    vm.etch(FEE_ASSET, address(new MintableToken()).code);
    feeAsset = MintableToken(FEE_ASSET);
    feeJuicePortal = new MockPullFeeJuicePortal(IERC20(FEE_ASSET));

    rollup = new MockRollup();
    rollup.setFeeAsset(IERC20(FEE_ASSET));
    rollup.setFeeAssetPortal(IFeeJuicePortal(address(feeJuicePortal)));
    registry = new MockRegistry();
    registry.setRollup(ROLLUP_VERSION, IHaveVersion(address(rollup)));
    ethUsdFeed = new MockV3Aggregator(8, ETH_USD_ANSWER);
  }

  function _assertV4Input(bytes memory _input, address _currencyIn, uint24 _fee, int24 _tickSpacing, address _hooks)
    internal
    pure
  {
    (bytes memory actions, bytes[] memory params) = abi.decode(_input, (bytes, bytes[]));
    assertEq(actions, abi.encodePacked(uint8(0x0b), uint8(0x06), uint8(0x0f)));

    (address settleCurrency, uint256 settleAmount, bool payerIsUser) = abi.decode(params[0], (address, uint256, bool));
    assertEq(settleCurrency, _currencyIn);
    assertEq(settleAmount, CONTRACT_BALANCE);
    assertFalse(payerIsUser);

    bool zeroForOne = _currencyIn < FEE_ASSET;
    IV4Router.ExactInputSingleParams memory swapParams = abi.decode(params[1], (IV4Router.ExactInputSingleParams));
    assertEq(Currency.unwrap(swapParams.poolKey.currency0), zeroForOne ? _currencyIn : FEE_ASSET);
    assertEq(Currency.unwrap(swapParams.poolKey.currency1), zeroForOne ? FEE_ASSET : _currencyIn);
    assertEq(swapParams.poolKey.fee, _fee);
    assertEq(swapParams.poolKey.tickSpacing, _tickSpacing);
    assertEq(address(swapParams.poolKey.hooks), _hooks);
    assertEq(swapParams.zeroForOne, zeroForOne);
    assertEq(swapParams.amountIn, 0);

    (address takeCurrency, uint256 takeMin) = abi.decode(params[2], (address, uint256));
    assertEq(takeCurrency, FEE_ASSET);
    assertEq(takeMin, 0);
  }
}

contract FPCFunderDAITest is FPCFunderBase {
  address internal constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
  address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  address internal constant UNIVERSAL_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;
  address internal constant THREE_POOL = 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7;

  uint24 internal constant AZTEC_ETH_POOL_FEE = 500;
  int24 internal constant AZTEC_ETH_POOL_TICK_SPACING = 10;
  address internal constant AZTEC_ETH_POOL_HOOKS = 0xd53006d1e3110fD319a79AEEc4c527a0d265E080;

  MockCurve3Pool internal threePool;
  MockUniversalRouter internal universalRouter;
  FPCFunderDAI internal funder;

  function setUp() public override {
    super.setUp();

    vm.etch(DAI, address(new MintableToken()).code);
    vm.etch(USDC, address(new MintableToken()).code);
    vm.etch(THREE_POOL, address(new MockCurve3Pool()).code);
    threePool = MockCurve3Pool(THREE_POOL);
    threePool.setCoins(DAI, USDC, USDT);
    threePool.setRate(USDC, 1e18);
    MintableToken(USDC).mint(THREE_POOL, 1_000_000e18);
    vm.etch(UNIVERSAL_ROUTER, address(new MockUniversalRouter(USDC, FEE_ASSET)).code);
    universalRouter = MockUniversalRouter(UNIVERSAL_ROUTER);

    funder = _newFunder(BENEFICIARY);
    vm.roll(block.number + 1);
  }

  function _newFunder(bytes32 _beneficiary) internal returns (FPCFunderDAI) {
    return new FPCFunderDAI(
      IRegistry(address(registry)), ROLLUP_VERSION, _beneficiary, AggregatorV3Interface(address(ethUsdFeed))
    );
  }

  function _ethMinOut(uint256 _amountIn) internal pure returns (uint256) {
    return (_amountIn * 1e8 * 9800) / (uint256(ETH_USD_ANSWER) * 10_000);
  }

  function test_GivenDaiBalance_WhenSwapAndDepositIsCalled() external {
    uint256 amount = 200e18;
    uint256 bounty = (amount * MIN_BOUNTY_BPS) / 10_000;
    uint256 swapped = amount - bounty;
    MintableToken(DAI).mint(address(funder), amount);

    vm.expectEmit(true, true, true, true, address(funder));
    emit Funded(swapped, bounty, bytes32(uint256(0xAB)), 7);

    funder.swapAndDepositAsFeeJuice();

    assertEq(feeAsset.balanceOf(address(feeJuicePortal)), swapped);
    assertEq(feeJuicePortal.lastTo(), BENEFICIARY);
    assertEq(feeJuicePortal.lastSecretHash(), OxideConstants.PORTAL_CONSTANT_SECRET_HASH);
    assertEq(MintableToken(DAI).balanceOf(address(funder)), 0);
    assertEq(MintableToken(DAI).balanceOf(address(this)), bounty);
    assertEq(threePool.callCount(), 1);
    assertEq(threePool.lastI(), 0);
    assertEq(threePool.lastJ(), 1);
    assertEq(threePool.lastDx(), swapped);
    assertEq(threePool.lastMinDy(), 0);
    assertEq(MintableToken(DAI).balanceOf(THREE_POOL), swapped);
    assertEq(MintableToken(USDC).balanceOf(address(universalRouter)), swapped);
    assertEq(universalRouter.lastValue(), 0);
    assertEq(universalRouter.lastCommands(), abi.encodePacked(uint8(0x00), uint8(0x0c), uint8(0x10)));

    (address v3Recipient, uint256 amountIn, uint256 minOut, bytes memory path, bool payerIsUser) =
      abi.decode(universalRouter.inputAt(0), (address, uint256, uint256, bytes, bool));
    assertEq(v3Recipient, address(2));
    assertEq(amountIn, swapped);
    assertEq(minOut, _ethMinOut(swapped));
    assertEq(minOut, 78_392_160_000_000_000);
    assertEq(path, abi.encodePacked(USDC, uint24(500), WETH));
    assertFalse(payerIsUser);

    (address unwrapRecipient, uint256 unwrapMin) = abi.decode(universalRouter.inputAt(1), (address, uint256));
    assertEq(unwrapRecipient, address(2));
    assertEq(unwrapMin, _ethMinOut(swapped));

    _assertV4Input(
      universalRouter.inputAt(2), address(0), AZTEC_ETH_POOL_FEE, AZTEC_ETH_POOL_TICK_SPACING, AZTEC_ETH_POOL_HOOKS
    );
  }

  function test_GivenZeroBalances_WhenSwapAndDepositIsCalled() external {
    vm.expectRevert(abi.encodeWithSelector(Errors.FPCFunder__BalanceBelowMinimum.selector, 0, MIN_FUNDABLE_BALANCE));
    funder.swapAndDepositAsFeeJuice();
  }

  function test_GivenZeroBeneficiary_WhenConstructed() external {
    vm.expectRevert(Errors.FPCFunder__ZeroBeneficiary.selector);
    _newFunder(bytes32(0));
  }

  function test_GivenFeedWithoutCode_WhenConstructed() external {
    vm.expectRevert(Errors.FPCFunder__FeedWithoutCode.selector);
    new FPCFunderDAI(
      IRegistry(address(registry)), ROLLUP_VERSION, BENEFICIARY, AggregatorV3Interface(makeAddr("no-code"))
    );
  }

  function test_ConstructorResolvesFeeAssetFromRollup() external view {
    assertEq(address(funder.FEE_ASSET()), FEE_ASSET);
    assertEq(address(funder.FEE_JUICE_PORTAL()), address(feeJuicePortal));
    assertEq(funder.L2_BENEFICIARY(), BENEFICIARY);
    assertEq(address(funder.ETH_USD_FEED()), address(ethUsdFeed));
  }

  function test_GivenStaleFeed_WhenSwapAndDepositIsCalled() external {
    MintableToken(DAI).mint(address(funder), 200e18);
    vm.warp(10 days);
    uint256 updatedAt = block.timestamp - EthUsdMinOutLib.MAX_PRICE_AGE - 1;
    ethUsdFeed.setUpdatedAt(updatedAt);

    vm.expectRevert(abi.encodeWithSelector(Errors.EthUsdMinOut__StalePrice.selector, updatedAt));
    funder.swapAndDepositAsFeeJuice();
  }

  function test_GivenNonPositiveAnswer_WhenSwapAndDepositIsCalled() external {
    MintableToken(DAI).mint(address(funder), 200e18);
    ethUsdFeed.setAnswer(0);

    vm.expectRevert(abi.encodeWithSelector(Errors.EthUsdMinOut__InvalidPrice.selector, int256(0)));
    funder.swapAndDepositAsFeeJuice();
  }

  function test_MinOutTracksFeedAnswer() external {
    uint256 amount = 200e18;
    uint256 swapped = amount - (amount * MIN_BOUNTY_BPS) / 10_000;
    MintableToken(DAI).mint(address(funder), amount);
    ethUsdFeed.setAnswer(ETH_USD_ANSWER * 2);

    funder.swapAndDepositAsFeeJuice();

    (,, uint256 minOut,,) = abi.decode(universalRouter.inputAt(0), (address, uint256, uint256, bytes, bool));
    assertEq(minOut, _ethMinOut(swapped) / 2);
  }

  function test_GivenBalanceBelowMinimum_WhenSwapAndDepositIsCalled() external {
    MintableToken(DAI).mint(address(funder), MIN_FUNDABLE_BALANCE - 1);
    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.FPCFunder__BalanceBelowMinimum.selector, MIN_FUNDABLE_BALANCE - 1, MIN_FUNDABLE_BALANCE
      )
    );
    funder.swapAndDepositAsFeeJuice();
  }

  function test_GivenElapsedRamp_WhenSwapAndDepositIsCalled() external {
    uint256 amount = 200e18;
    MintableToken(DAI).mint(address(funder), amount);
    vm.warp(block.timestamp + 2 * BOUNTY_RAMP_DURATION);

    funder.swapAndDepositAsFeeJuice();

    assertEq(MintableToken(DAI).balanceOf(address(this)), (amount * MAX_BOUNTY_BPS) / 10_000);
  }

  function test_GivenHalfRamp_WhenSwapAndDepositIsCalled() external {
    uint256 amount = 200e18;
    MintableToken(DAI).mint(address(funder), amount);
    vm.warp(block.timestamp + BOUNTY_RAMP_DURATION / 2);

    funder.swapAndDepositAsFeeJuice();

    uint256 halfRampBps = MIN_BOUNTY_BPS + (MAX_BOUNTY_BPS - MIN_BOUNTY_BPS) / 2;
    assertEq(MintableToken(DAI).balanceOf(address(this)), (amount * halfRampBps) / 10_000);
  }

  function test_GivenPreviousSwapAndDeposit_WhenSwapAndDepositIsCalledAgain() external {
    uint256 amount = 200e18;
    MintableToken(DAI).mint(address(funder), amount);
    vm.warp(block.timestamp + BOUNTY_RAMP_DURATION);
    funder.swapAndDepositAsFeeJuice();
    uint256 paidAtMax = MintableToken(DAI).balanceOf(address(this));

    vm.roll(block.number + 1);
    MintableToken(DAI).mint(address(funder), amount);
    funder.swapAndDepositAsFeeJuice();

    assertEq(MintableToken(DAI).balanceOf(address(this)) - paidAtMax, (amount * MIN_BOUNTY_BPS) / 10_000);
  }

  function test_QuoteBalanceAndBountyMatchesThePaidBounty() external {
    assertEq(address(funder.inputToken()), DAI);

    MintableToken(DAI).mint(address(funder), MIN_FUNDABLE_BALANCE - 1);
    (uint256 balance, uint256 bounty) = funder.quoteBalanceAndBounty();
    assertEq(balance, MIN_FUNDABLE_BALANCE - 1);
    assertEq(bounty, 0);

    MintableToken(DAI).mint(address(funder), 1 + 100e18);
    vm.warp(block.timestamp + BOUNTY_RAMP_DURATION / 2);
    (balance, bounty) = funder.quoteBalanceAndBounty();
    assertEq(balance, MIN_FUNDABLE_BALANCE + 100e18);

    funder.swapAndDepositAsFeeJuice();
    assertEq(MintableToken(DAI).balanceOf(address(this)), bounty);
  }
}
