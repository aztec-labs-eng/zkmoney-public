// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";

library RecoveryAuthLib {
  error RecoveryAuthLib__RecoveryExpired(uint256 deadline);
  error RecoveryAuthLib__RecoveryCommitmentMismatch();
  error RecoveryAuthLib__InvalidSignature();

  function authorize(
    bytes32 _recoveryCommitment,
    bytes32 _recoverySalt,
    address _account,
    bytes32 _digest,
    bytes calldata _signature,
    uint256 _deadline
  ) internal view {
    require(block.timestamp <= _deadline, RecoveryAuthLib__RecoveryExpired(_deadline));
    require(
      RecoveryCommitmentLib.deriveRecoveryCommitment(_recoverySalt, _account) == _recoveryCommitment,
      RecoveryAuthLib__RecoveryCommitmentMismatch()
    );
    require(isValidSignature(_account, _digest, _signature), RecoveryAuthLib__InvalidSignature());
  }

  function isValidSignature(address _account, bytes32 _digest, bytes calldata _signature) internal view returns (bool) {
    if (_account.code.length == 0) {
      (address recovered, ECDSA.RecoverError err,) =
        ECDSA.tryRecoverCalldata(MessageHashUtils.toEthSignedMessageHash(_digest), _signature);
      return err == ECDSA.RecoverError.NoError && recovered == _account;
    }
    return IERC1271(_account).isValidSignature(_digest, _signature) == IERC1271.isValidSignature.selector;
  }
}
