// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract UserOpAdapter is CoreAdapter {
  // solhint-disable-next-line oxide/no-comments
  // Fields of the user operation. The nonce carries its own key, so the ops of the wallet do not consume it.
  struct HandleUserOp {
    address sender;
    uint256 nonce;
    bytes callData;
    bytes32 accountGasLimits;
    bytes signature;
  }

  IEntryPoint public constant ENTRY_POINT = ERC4337Utils.ENTRYPOINT_V08;

  // solhint-disable oxide/no-comments
  /// @notice A user op can fail without a revert. If necessary, add a postcondition check after this call.
  /// @dev An op whose nonce the EntryPoint already used is skipped.
  // solhint-enable oxide/no-comments
  function handleUserOp(HandleUserOp calldata _op) external {
    if (ENTRY_POINT.getNonce(_op.sender, uint192(_op.nonce >> 64)) > _op.nonce) {
      return;
    }
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0].sender = _op.sender;
    ops[0].nonce = _op.nonce;
    ops[0].callData = _op.callData;
    ops[0].accountGasLimits = _op.accountGasLimits;
    ops[0].signature = _op.signature;
    ENTRY_POINT.handleOps(ops, payable(address(this)));
  }
}
