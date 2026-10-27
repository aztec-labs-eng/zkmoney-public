// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SIPABase} from "./SIPABase.sol";
import {ThreePoolLib} from "./ThreePoolLib.sol";
import {Errors} from "./Errors.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

// solhint-disable oxide/no-comments
// A view call and the expected hash of its result. A zero hash skips the condition.
struct UserOpCondition {
  address target;
  bytes data;
  bytes32 resultHash;
}

struct UserOpIntent {
  uint256 rollupVersion;
  // Checked before and after the user operation.
  UserOpCondition precondition;
  UserOpCondition postcondition;
  // The L2 note recipient of the deposit.
  bytes32 recipientCommitment;
  // Fields of the userOp.
  address owner;
  uint64 nonce;
  bytes callData;
  bytes32 accountGasLimits;
}
// solhint-enable oxide/no-comments

contract UserOpSIPA is SIPABase {
  IEntryPoint public constant ENTRY_POINT = ERC4337Utils.ENTRYPOINT_V08;

  function INTENT() public pure override returns (Intent) {
    return Intent.UserOp;
  }

  function _execute(address token, bytes calldata intentData, bytes calldata proofs)
    internal
    override
    returns (Routing memory)
  {
    Args memory args = _args();
    require(!args.resweepable, Errors.UserOpSIPA__Resweepable());
    address settledToken = ThreePoolLib.swapToDai(token);
    UserOpIntent memory intent = abi.decode(intentData, (UserOpIntent));
    require(intent.rollupVersion == args.rollupVersion, Errors.SIPA__RollupVersionMismatch());

    uint256 nonce = ENTRY_POINT.getNonce(intent.owner, 0);
    require(nonce >= intent.nonce, Errors.UserOpSIPA__NonceNotReached());
    // solhint-disable-next-line oxide/no-comments
    // Skip, don't revert, when the operation already ran: anyone can submit it first, and the postcondition covers it.
    if (nonce == intent.nonce) {
      require(_conditionHolds(intent.precondition), Errors.UserOpSIPA__PreconditionFailed());
      _handleOp(intent, abi.decode(proofs, (bytes)));
    }
    require(_conditionHolds(intent.postcondition), Errors.UserOpSIPA__PostconditionFailed());

    return Routing(settledToken, address(0), 0, intent.recipientCommitment);
  }

  function _handleOp(UserOpIntent memory intent, bytes memory signature) internal {
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0].sender = intent.owner;
    ops[0].nonce = intent.nonce;
    ops[0].callData = intent.callData;
    ops[0].accountGasLimits = intent.accountGasLimits;
    ops[0].signature = signature;
    ENTRY_POINT.handleOps(ops, payable(intent.owner));
  }

  function _conditionHolds(UserOpCondition memory condition) internal view returns (bool) {
    if (condition.resultHash == bytes32(0)) {
      return true;
    }
    (bool success, bytes memory result) = condition.target.staticcall(condition.data);
    require(success, Errors.UserOpSIPA__ConditionReverted());
    require(condition.target.code.length > 0, Errors.UserOpSIPA__ConditionTargetHasNoCode());
    return keccak256(result) == condition.resultHash;
  }
}
