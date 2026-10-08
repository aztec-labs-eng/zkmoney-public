// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {UniversalRouterLib} from "@periphery/fpc_funder/UniversalRouterLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {ThreePoolLib, POOL3_USDC_IDX, POOL3_USDT_IDX} from "@periphery/ThreePoolLib.sol";

contract SwapEscrow is EscrowBase {
  using SafeERC20 for IERC20;

  struct Args {
    uint8 route;
    address recipient;
    bytes32 recoveryCommitment;
    uint256 relayerTip;
    bytes32 nonce;
  }

  error SwapEscrow__UnknownRoute(uint8 route);
  error SwapEscrow__FeedWithoutCode();

  uint8 public constant ROUTE_USDC = 0;
  uint8 public constant ROUTE_USDT = 1;
  uint8 public constant ROUTE_ETH = 2;

  uint24 internal constant USDC_WETH_POOL_FEE = 500;

  uint256 public constant BPS_DENOMINATOR = ThreePoolLib.BPS_DENOMINATOR;
  uint256 public constant STABLE_MAX_SLIPPAGE_BPS = 100;
  uint256 public constant ETH_MAX_SLIPPAGE_BPS = 200;
  uint256 public constant MAX_PRICE_AGE = EthUsdMinOutLib.MAX_PRICE_AGE;

  IERC20 public immutable DAI;
  address public immutable USDC;
  address public immutable USDT;
  address public immutable WETH;
  IUniversalRouter public immutable UNISWAP_UNIVERSAL_ROUTER;
  ICurve3Pool public immutable THREE_POOL;
  AggregatorV3Interface public immutable ETH_USD_FEED;

  constructor(
    IERC20 _dai,
    address _usdc,
    address _usdt,
    address _weth,
    IUniversalRouter _router,
    ICurve3Pool _threePool,
    AggregatorV3Interface _ethUsdFeed
  ) {
    require(address(_ethUsdFeed).code.length > 0, SwapEscrow__FeedWithoutCode());
    DAI = _dai;
    USDC = _usdc;
    USDT = _usdt;
    WETH = _weth;
    UNISWAP_UNIVERSAL_ROUTER = _router;
    THREE_POOL = _threePool;
    ETH_USD_FEED = _ethUsdFeed;
  }

  function route() external view returns (uint8) {
    return _args().route;
  }

  function recipient() external view returns (address) {
    return _args().recipient;
  }

  function relayerTip() external view returns (uint256) {
    return _args().relayerTip;
  }

  function nonce() external view returns (bytes32) {
    return _args().nonce;
  }

  function execute(address _tipRecipient) external override onlyFactory {
    Args memory args = _args();

    uint256 amountIn = DAI.balanceOf(address(this)) - args.relayerTip;
    if (amountIn > 0) {
      _swap(args.route, args.recipient, amountIn);
    }
    DAI.safeTransfer(_tipRecipient, args.relayerTip);
  }

  function _swap(uint8 _route, address _recipient, uint256 _amountIn) private {
    if (_route == ROUTE_USDC) {
      IERC20(USDC).safeTransfer(_recipient, _exchangeDai(POOL3_USDC_IDX, USDC, _amountIn));
    } else if (_route == ROUTE_USDT) {
      IERC20(USDT).safeTransfer(_recipient, _exchangeDai(POOL3_USDT_IDX, USDT, _amountIn));
    } else if (_route == ROUTE_ETH) {
      uint256 ethMinOut = _ethMinOut(_amountIn);
      uint256 usdcAmount = _exchangeDai(POOL3_USDC_IDX, USDC, _amountIn);
      IERC20(USDC).safeTransfer(address(UNISWAP_UNIVERSAL_ROUTER), usdcAmount);

      bytes memory commands = abi.encodePacked(uint8(Commands.V3_SWAP_EXACT_IN), uint8(Commands.UNWRAP_WETH));
      bytes[] memory inputs = new bytes[](2);
      inputs[0] = UniversalRouterLib.v3SwapExactInInput(
        ActionConstants.ADDRESS_THIS, usdcAmount, ethMinOut, abi.encodePacked(USDC, USDC_WETH_POOL_FEE, WETH)
      );
      inputs[1] = UniversalRouterLib.unwrapWethInput(_recipient, ethMinOut);
      UNISWAP_UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp);
    } else {
      revert SwapEscrow__UnknownRoute(_route);
    }
  }

  function _exchangeDai(int128 _idxOut, address _tokenOut, uint256 _amountIn) private returns (uint256) {
    return ThreePoolLib.swapDaiTo(THREE_POOL, address(DAI), _idxOut, _tokenOut, _amountIn, STABLE_MAX_SLIPPAGE_BPS);
  }

  function _ethMinOut(uint256 _amountIn) private view returns (uint256) {
    return EthUsdMinOutLib.ethMinOut(ETH_USD_FEED, _amountIn, ETH_MAX_SLIPPAGE_BPS);
  }

  function _recoveryCommitment() internal view override returns (bytes32) {
    return _args().recoveryCommitment;
  }

  function _args() private view returns (Args memory) {
    return abi.decode(_cloneArgs(), (Args));
  }
}
