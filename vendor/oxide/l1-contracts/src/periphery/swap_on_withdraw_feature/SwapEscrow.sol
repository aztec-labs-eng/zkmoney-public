// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {UniswapV2Library} from "@uniswap/universal-router/contracts/modules/uniswap/v2/UniswapV2Library.sol";
import {IUniswapV2Pair} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
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
    uint256 daiForGas;
    uint256 minEthForGas;
    bytes32 recoveryCommitment;
    uint256 relayerTip;
    bytes32 nonce;
  }

  error SwapEscrow__UnknownRoute(uint8 route);
  error SwapEscrow__FeedWithoutCode();
  error SwapEscrow__EthNotFromWeth();
  error SwapEscrow__DaiForGasOnEthRoute();
  error SwapEscrow__DaiForGasExceedsMax(uint256 daiForGas);
  error SwapEscrow__DaiForGasExceedsBalanceAfterTip(uint256 daiForGas, uint256 balanceAfterTip);
  error SwapEscrow__EthForGasBelowMin(uint256 ethOut, uint256 minEthForGas);

  uint8 public constant ROUTE_USDC = 0;
  uint8 public constant ROUTE_USDT = 1;
  uint8 public constant ROUTE_ETH = 2;
  uint8 public constant ROUTE_DAI = 3;

  uint24 internal constant USDC_WETH_POOL_FEE = 500;

  uint256 public constant BPS_DENOMINATOR = ThreePoolLib.BPS_DENOMINATOR;
  uint256 public constant STABLE_MAX_SLIPPAGE_BPS = 100;
  uint256 public constant ETH_MAX_SLIPPAGE_BPS = 200;
  uint256 public constant MAX_PRICE_AGE = EthUsdMinOutLib.MAX_PRICE_AGE;
  uint256 public constant MAX_DAI_FOR_GAS = 50e18;

  IERC20 public immutable DAI;
  address public immutable USDC;
  address public immutable USDT;
  address public immutable WETH;
  IUniversalRouter public immutable UNISWAP_UNIVERSAL_ROUTER;
  ICurve3Pool public immutable THREE_POOL;
  AggregatorV3Interface public immutable ETH_USD_FEED;
  IUniswapV2Pair public immutable DAI_WETH_PAIR;
  bool internal immutable DAI_IS_TOKEN0;

  constructor(
    IERC20 _dai,
    address _usdc,
    address _usdt,
    address _weth,
    IUniversalRouter _router,
    ICurve3Pool _threePool,
    AggregatorV3Interface _ethUsdFeed,
    IUniswapV2Pair _daiWethPair
  ) {
    require(address(_ethUsdFeed).code.length > 0, SwapEscrow__FeedWithoutCode());
    DAI = _dai;
    USDC = _usdc;
    USDT = _usdt;
    WETH = _weth;
    UNISWAP_UNIVERSAL_ROUTER = _router;
    THREE_POOL = _threePool;
    ETH_USD_FEED = _ethUsdFeed;
    DAI_WETH_PAIR = _daiWethPair;
    DAI_IS_TOKEN0 = address(_dai) < _weth;
  }

  receive() external payable {
    require(msg.sender == WETH, SwapEscrow__EthNotFromWeth());
  }

  function route() external view returns (uint8) {
    return _args().route;
  }

  function recipient() external view returns (address) {
    return _args().recipient;
  }

  function daiForGas() external view returns (uint256) {
    return _args().daiForGas;
  }

  function minEthForGas() external view returns (uint256) {
    return _args().minEthForGas;
  }

  function relayerTip() external view returns (uint256) {
    return _args().relayerTip;
  }

  function nonce() external view returns (bytes32) {
    return _args().nonce;
  }

  function execute(address _tipRecipient) external override onlyFactory {
    Args memory args = _args();
    // solhint-disable oxide/no-comments
    // The ETH route already pays ETH. On this route, a gas swap only adds a second swap and a second ETH transfer,
    // which cost gas for no benefit. Revert, so that a client that sets both by mistake fails clearly and we detect
    // the misconfiguration.
    // solhint-enable oxide/no-comments
    require(args.route != ROUTE_ETH || args.daiForGas == 0, SwapEscrow__DaiForGasOnEthRoute());
    require(args.daiForGas <= MAX_DAI_FOR_GAS, SwapEscrow__DaiForGasExceedsMax(args.daiForGas));

    uint256 amountIn = DAI.balanceOf(address(this)) - args.relayerTip;
    require(args.daiForGas <= amountIn, SwapEscrow__DaiForGasExceedsBalanceAfterTip(args.daiForGas, amountIn));
    uint256 ethOut = args.daiForGas > 0 ? _swapDaiToEth(args.daiForGas, args.minEthForGas) : 0;
    if (ethOut > 0) {
      amountIn -= args.daiForGas;
    }
    if (amountIn > 0) {
      _swap(args.route, args.recipient, amountIn);
    }
    DAI.safeTransfer(_tipRecipient, args.relayerTip);
    if (ethOut > 0) {
      _sendEth(args.recipient, ethOut);
    }
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
    } else if (_route == ROUTE_DAI) {
      DAI.safeTransfer(_recipient, _amountIn);
    } else {
      revert SwapEscrow__UnknownRoute(_route);
    }
  }

  function _swapDaiToEth(uint256 _amountIn, uint256 _minEthOut) private returns (uint256 ethOut) {
    // solhint-disable oxide/no-comments
    // We use the manual computation with the reserves below instead of using UniswapRouter to save the extra ~25k gas
    // on the transfer to the router.
    // solhint-enable oxide/no-comments
    (uint256 reserve0, uint256 reserve1,) = DAI_WETH_PAIR.getReserves();
    (uint256 daiReserve, uint256 wethReserve) = DAI_IS_TOKEN0 ? (reserve0, reserve1) : (reserve1, reserve0);
    ethOut = UniswapV2Library.getAmountOut(_amountIn, daiReserve, wethReserve);
    require(ethOut >= _minEthOut, SwapEscrow__EthForGasBelowMin(ethOut, _minEthOut));
    if (ethOut == 0) {
      return 0;
    }

    DAI.safeTransfer(address(DAI_WETH_PAIR), _amountIn);
    (uint256 amount0Out, uint256 amount1Out) = DAI_IS_TOKEN0 ? (uint256(0), ethOut) : (ethOut, uint256(0));
    DAI_WETH_PAIR.swap(amount0Out, amount1Out, address(this), "");
    IWETH9(WETH).withdraw(ethOut);
  }

  function _sendEth(address _recipient, uint256 _amount) private {
    (bool success,) = _recipient.call{value: _amount}("");
    require(success, EscrowBase__EthTransferFailed());
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
