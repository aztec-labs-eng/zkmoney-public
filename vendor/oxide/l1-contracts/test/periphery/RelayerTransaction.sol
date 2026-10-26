// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";

library RelayerTransaction {
  Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  uint256 internal constant TX_INTRINSIC_GAS = 21_000;

  function send(address _from, DepositSubsidy _subsidy, bytes memory _inner)
    internal
    returns (uint256 subsidy, uint256 txGas)
  {
    return sendWithGas(_from, _subsidy, _inner, gasleft());
  }

  function sendWithGas(address _from, DepositSubsidy _subsidy, bytes memory _inner, uint256 _gas)
    internal
    returns (uint256 subsidy, uint256 txGas)
  {
    IERC20 token = IERC20(address(_subsidy.TOKEN()));
    address executor = address(_subsidy.EXECUTOR());
    uint256 potBefore = token.balanceOf(address(_subsidy));
    bytes memory outer = abi.encodeCall(OperationExecutor.execute, (address(_subsidy), _inner, token, 0, 0, 0));
    VM.prank(_from, _from);
    (bool ok, bytes memory ret) = executor.call{gas: _gas}(outer);
    if (!ok) {
      assembly ("memory-safe") {
        revert(add(ret, 32), mload(ret))
      }
    }
    txGas = lastTxGas(outer);
    subsidy = potBefore - token.balanceOf(address(_subsidy));
  }

  function lastTxGas(bytes memory _calldata) internal returns (uint256) {
    Vm.Gas memory g = VM.lastCallGas();
    uint256 total = TX_INTRINSIC_GAS + calldataGas(_calldata) + uint256(g.gasTotalUsed);
    uint256 refund = uint256(int256(g.gasRefunded));
    return total - (refund < total / 5 ? refund : total / 5);
  }

  function calldataGas(bytes memory _data) internal pure returns (uint256 total) {
    for (uint256 i = 0; i < _data.length; i++) {
      total += _data[i] == 0 ? 4 : 16;
    }
  }
}
