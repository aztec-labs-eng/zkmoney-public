// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IMakerPsm} from "@periphery/interfaces/IMakerPsm.sol";

contract MockMakerPsm is IMakerPsm {
  using SafeERC20 for IERC20;

  uint256 internal constant WAD = 1e18;

  IERC20 internal immutable DAI;
  IERC20 internal immutable GEM;
  uint256 internal immutable TO_18_CONVERSION_FACTOR;

  uint256 public tout;

  constructor(address _dai, address _gem, uint8 _gemDecimals) {
    DAI = IERC20(_dai);
    GEM = IERC20(_gem);
    TO_18_CONVERSION_FACTOR = 10 ** (18 - _gemDecimals);
  }

  function setTout(uint256 _tout) external {
    tout = _tout;
  }

  function dai() external view returns (address) {
    return address(DAI);
  }

  function to18ConversionFactor() external view returns (uint256) {
    return TO_18_CONVERSION_FACTOR;
  }

  function buyGem(address _usr, uint256 _gemAmt) external returns (uint256 daiInWad) {
    daiInWad = _gemAmt * TO_18_CONVERSION_FACTOR;
    daiInWad += (daiInWad * tout) / WAD;
    DAI.safeTransferFrom(msg.sender, address(this), daiInWad);
    GEM.safeTransfer(_usr, _gemAmt);
  }
}
