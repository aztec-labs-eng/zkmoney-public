// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";

contract MockUniversalRouter {
  uint8 internal constant V3_SWAP_EXACT_OUT_COMMAND = uint8(Commands.V3_SWAP_EXACT_OUT);
  uint8 internal constant SWEEP_COMMAND = uint8(Commands.SWEEP);
  uint8 internal constant UNWRAP_WETH_COMMAND = uint8(Commands.UNWRAP_WETH);

  mapping(address tokenOut => uint256 outPerInputWad) public rate;

  uint256 public callCount;
  uint256 public lastDeadline;
  bytes public lastCommands;
  bytes[] internal $lastInputs;

  receive() external payable {}

  function setRate(address _tokenOut, uint256 _outPerInputWad) external {
    rate[_tokenOut] = _outPerInputWad;
  }

  function inputAt(uint256 _i) external view returns (bytes memory) {
    return $lastInputs[_i];
  }

  function inputCount() external view returns (uint256) {
    return $lastInputs.length;
  }

  function execute(bytes calldata _commands, bytes[] calldata _inputs, uint256 _deadline) external payable {
    callCount++;
    lastDeadline = _deadline;
    lastCommands = _commands;
    delete $lastInputs;
    for (uint256 i = 0; i < _inputs.length; i++) {
      $lastInputs.push(_inputs[i]);
    }

    if (uint8(_commands[0]) == V3_SWAP_EXACT_OUT_COMMAND) {
      _exactOut(_inputs[0]);
      if (_commands.length > 1 && uint8(_commands[1]) == SWEEP_COMMAND) {
        (address token, address sweepRecipient, uint256 amountMinimum) =
          abi.decode(_inputs[1], (address, address, uint256));
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance >= amountMinimum, "MockUniversalRouter: insufficient token");
        IERC20(token).transfer(sweepRecipient, balance);
      }
      return;
    }

    (address recipient, uint256 amountIn, uint256 amountOutMinimum, bytes memory path,) =
      abi.decode(_inputs[0], (address, uint256, uint256, bytes, bool));
    uint256 amountOut = (amountIn * rate[_lastPathToken(path)]) / 1e18;
    require(amountOut >= amountOutMinimum, "MockUniversalRouter: too little received");

    if (_hasUnwrapWeth(_commands)) {
      (address ethRecipient, uint256 amountMinimum) = abi.decode(_inputs[1], (address, uint256));
      require(amountOut >= amountMinimum, "MockUniversalRouter: insufficient ETH");
      (bool success,) = ethRecipient.call{value: amountOut}("");
      require(success, "MockUniversalRouter: ETH send failed");
    } else {
      IERC20(_lastPathToken(path)).transfer(recipient, amountOut);
    }
  }

  function _firstPathToken(bytes memory _path) private pure returns (address token) {
    require(_path.length >= 20, "MockUniversalRouter: path too short");
    assembly ("memory-safe") {
      token := shr(96, mload(add(_path, 0x20)))
    }
  }

  function _hasUnwrapWeth(bytes calldata _commands) private pure returns (bool) {
    for (uint256 i = 0; i < _commands.length; i++) {
      if (uint8(_commands[i]) == UNWRAP_WETH_COMMAND) {
        return true;
      }
    }
    return false;
  }

  function _lastPathToken(bytes memory _path) private pure returns (address token) {
    uint256 length = _path.length;
    require(length >= 20, "MockUniversalRouter: path too short");
    assembly ("memory-safe") {
      token := shr(96, mload(add(add(_path, 0x20), sub(length, 20))))
    }
  }

  function _exactOut(bytes calldata _input) private {
    (address recipient, uint256 amountOut, uint256 amountInMaximum, bytes memory path,) =
      abi.decode(_input, (address, uint256, uint256, bytes, bool));
    address tokenOut = _firstPathToken(path);
    uint256 amountIn = Math.mulDiv(amountOut, 1e18, rate[tokenOut], Math.Rounding.Ceil);
    require(amountIn <= amountInMaximum, "MockUniversalRouter: too much requested");
    IERC20(_lastPathToken(path)).transfer(address(0xdead), amountIn);
    IERC20(tokenOut).transfer(recipient, amountOut);
  }
}
