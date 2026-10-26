// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMakerPsm} from "@periphery/interfaces/IMakerPsm.sol";

contract MockMakerPsm is IMakerPsm {
  using SafeERC20 for IERC20;

  IERC20 internal $dai;
  IERC20 internal $gem;
  uint256 internal $to18ConversionFactor;

  constructor(address _dai, address _gem, uint8 _gemDecimals) {
    $dai = IERC20(_dai);
    $gem = IERC20(_gem);
    $to18ConversionFactor = 10 ** (18 - _gemDecimals);
  }

  function dai() external view returns (address) {
    return address($dai);
  }

  function tout() external view returns (uint256) {
    return 0;
  }

  function to18ConversionFactor() external view returns (uint256) {
    return $to18ConversionFactor;
  }

  function buyGem(address _usr, uint256 _gemAmt) external returns (uint256 daiInWad) {
    daiInWad = _gemAmt * $to18ConversionFactor;
    $dai.safeTransferFrom(msg.sender, address(this), daiInWad);
    $gem.safeTransfer(_usr, _gemAmt);
  }
}
