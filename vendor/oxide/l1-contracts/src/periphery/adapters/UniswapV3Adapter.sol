// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {Constants} from "@uniswap/universal-router/contracts/libraries/Constants.sol";
import {BytesLib} from "@uniswap/universal-router/contracts/modules/uniswap/v3/BytesLib.sol";
import {V3Path} from "@uniswap/universal-router/contracts/modules/uniswap/v3/V3Path.sol";
import {UniversalRouterLib} from "@periphery/fpc_funder/UniversalRouterLib.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract UniswapV3Adapter is CoreAdapter {
  using SafeERC20 for IERC20;

  IUniversalRouter public immutable UNIVERSAL_ROUTER;

  constructor(IUniversalRouter _router) {
    UNIVERSAL_ROUTER = _router;
  }

  function uniswapV3ExactIn(bytes calldata _path, uint256 _amountIn, uint256 _minOut, address _recipient) external {
    _requireRecipient(_recipient);
    IERC20 tokenIn = IERC20(V3Path.decodeFirstToken(_path));
    uint256 amountIn = _resolveERC20Amount(tokenIn, _amountIn);

    tokenIn.safeTransfer(address(UNIVERSAL_ROUTER), amountIn);
    bytes memory commands = abi.encodePacked(uint8(Commands.V3_SWAP_EXACT_IN));
    bytes[] memory inputs = new bytes[](1);
    inputs[0] = UniversalRouterLib.v3SwapExactInInput(_recipient, amountIn, _minOut, _path);
    UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp);
  }

  function uniswapV3ExactOut(
    bytes calldata _path,
    uint256 _amountOut,
    uint256 _maxIn,
    address _recipient,
    // solhint-disable-next-line oxide/no-comments
    // Receives the tokenIn that the swap does not spend.
    address _leftoverRecipient
  ) external {
    _requireRecipient(_recipient);
    _requireRecipient(_leftoverRecipient);
    IERC20 tokenIn = IERC20(BytesLib.toAddress(_path[_path.length - Constants.ADDR_SIZE:]));
    uint256 maxIn = _resolveERC20Amount(tokenIn, _maxIn);

    tokenIn.safeTransfer(address(UNIVERSAL_ROUTER), maxIn);
    bytes memory commands = abi.encodePacked(uint8(Commands.V3_SWAP_EXACT_OUT), uint8(Commands.SWEEP));
    bytes[] memory inputs = new bytes[](2);
    inputs[0] = UniversalRouterLib.v3SwapExactOutInput(_recipient, _amountOut, maxIn, _path);
    inputs[1] = UniversalRouterLib.sweepInput(address(tokenIn), _leftoverRecipient, 0);
    UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp);
  }
}
