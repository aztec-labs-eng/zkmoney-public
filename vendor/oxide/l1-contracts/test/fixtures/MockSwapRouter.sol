// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IFPCFunder} from "@periphery/interfaces/IFPCFunder.sol";

contract MockSwapRouter {
  function execute(bytes calldata, bytes[] calldata, uint256) external payable {
    IERC20 feeAsset = IFPCFunder(msg.sender).FEE_ASSET();
    feeAsset.transfer(msg.sender, feeAsset.balanceOf(address(this)));
  }
}
