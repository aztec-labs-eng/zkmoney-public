// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

library RecoveryCommitmentLib {
  uint256 internal constant L2_FIELD_SAFE_BITS = 248;

  function deriveRecoveryCommitment(bytes32 sharedSecretSalt, address account) internal pure returns (bytes32) {
    // solhint-disable-next-line oxide/no-comments
    // The low byte of the hash is dropped so the commitment fits one L2 Field, which is how the broadcaster carries it.
    return bytes32(uint256(keccak256(abi.encode(sharedSecretSalt, account))) >> (256 - L2_FIELD_SAFE_BITS));
  }

  function fitsL2Field(bytes32 recoveryCommitment) internal pure returns (bool) {
    return uint256(recoveryCommitment) >> L2_FIELD_SAFE_BITS == 0;
  }
}
