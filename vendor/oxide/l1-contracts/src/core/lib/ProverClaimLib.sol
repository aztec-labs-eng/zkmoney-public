// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {MerkleLib} from "@aztec/core/libraries/crypto/MerkleLib.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {Errors} from "./Errors.sol";

library ProverClaimLib {
  uint256 internal constant EPOCH_OUT_HASH_TREE_HEIGHT = 5;

  struct ProverClaim {
    uint256 epochNumber;
    uint256 messageLeafIndex;
    bytes32[] path;
    uint256 proofLength;
    uint256 checkpointNumber;
  }

  struct ChainEnv {
    IRollup rollup;
    IOutbox outbox;
    uint256 rollupVersion;
    bytes32 l2Portal;
    address portal;
  }

  function verify(
    address _prover,
    ProverClaim calldata _claim,
    bytes32 _messageContent,
    ChainEnv memory _env,
    mapping(uint256 => mapping(uint256 => bool)) storage _claimed,
    mapping(uint256 => address) storage _firstProver
  ) internal {
    uint256 checkpointIndexInEpoch = _checkpointIndexInEpoch(_claim);
    _assertCheckpointBinding(_claim, _env.rollup, checkpointIndexInEpoch);
    uint256 messagePosition = checkpointIndexInEpoch + 1;
    _assertProverEligibleInRange(_claim, messagePosition, _prover, _env.rollup, _firstProver);
    _verifyOutboxInclusion(_claim, _messageContent, _env);

    uint256 leafId = (1 << _claim.path.length) + _claim.messageLeafIndex;
    require(
      !_claimed[_claim.epochNumber][leafId],
      Errors.ProverClaim__ClaimAlreadyTracked(_env.portal, _claim.epochNumber, leafId)
    );
    _claimed[_claim.epochNumber][leafId] = true;
  }

  function _verifyOutboxInclusion(ProverClaim calldata _claim, bytes32 _messageContent, ChainEnv memory _env)
    private
    view
  {
    bytes32 epochRoot = _env.outbox.getRootData(Epoch.wrap(_claim.epochNumber), _claim.proofLength);
    require(epochRoot != bytes32(0), Errors.ProverClaim__UnprovenEpoch(_claim.epochNumber));
    DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
      sender: DataStructures.L2Actor({actor: _env.l2Portal, version: _env.rollupVersion}),
      recipient: DataStructures.L1Actor({actor: _env.portal, chainId: block.chainid}),
      content: _messageContent
    });
    MerkleLib.verifyMembership(_claim.path, Hash.sha256ToField(message), _claim.messageLeafIndex, epochRoot);
  }

  function _checkpointIndexInEpoch(ProverClaim calldata _claim) private pure returns (uint256) {
    uint256 pathLength = _claim.path.length;
    require(
      pathLength >= EPOCH_OUT_HASH_TREE_HEIGHT, Errors.ProverClaim__PathTooShort(pathLength, EPOCH_OUT_HASH_TREE_HEIGHT)
    );
    require(pathLength < 256, Errors.ProverClaim__PathTooLong(pathLength));
    require(
      _claim.messageLeafIndex < (1 << pathLength),
      Errors.ProverClaim__LeafIndexOutOfBounds(_claim.messageLeafIndex, pathLength)
    );
    return _claim.messageLeafIndex >> (pathLength - EPOCH_OUT_HASH_TREE_HEIGHT);
  }

  function _assertCheckpointBinding(ProverClaim calldata _claim, IRollup _rollup, uint256 _checkpointIndex)
    private
    view
  {
    uint256 firstCheckpointInEpoch = _claim.checkpointNumber - _checkpointIndex;
    assertFirstCheckpointInEpoch(_rollup, _claim.checkpointNumber, _claim.epochNumber, firstCheckpointInEpoch);
  }

  function assertFirstCheckpointInEpoch(
    IRollup _rollup,
    uint256 _referenceCheckpointNumber,
    uint256 _epochNumber,
    uint256 _firstCheckpointInEpoch
  ) internal view {
    require(
      Epoch.unwrap(_rollup.getEpochForCheckpoint(_firstCheckpointInEpoch)) == _epochNumber,
      Errors.ProverClaim__CheckpointEpochMismatch(_referenceCheckpointNumber, _epochNumber)
    );

    require(
      _firstCheckpointInEpoch == Constants.INITIAL_CHECKPOINT_NUMBER
        || Epoch.unwrap(_rollup.getEpochForCheckpoint(_firstCheckpointInEpoch - 1)) < _epochNumber,
      Errors.ProverClaim__CheckpointNotEpochBoundary(_referenceCheckpointNumber, _epochNumber)
    );
  }

  function _assertProverEligibleInRange(
    ProverClaim calldata _claim,
    uint256 _messagePosition,
    address _prover,
    IRollup _rollup,
    mapping(uint256 => address) storage _firstProver
  ) private view {
    require(
      _claim.proofLength >= _messagePosition,
      Errors.ProverClaim__ProofLengthBelowMessageCheckpoint(_claim.proofLength, _messagePosition)
    );

    uint256 proofCheckpointNumber = _claim.checkpointNumber + _claim.proofLength - _messagePosition;
    require(
      Epoch.unwrap(_rollup.getEpochForCheckpoint(proofCheckpointNumber)) == _claim.epochNumber,
      Errors.ProverClaim__ProofCheckpointNotInEpoch(proofCheckpointNumber, _claim.epochNumber)
    );

    for (uint256 i = _claim.checkpointNumber; i <= proofCheckpointNumber; i++) {
      address registered = _firstProver[i];
      if (registered != address(0)) {
        require(registered == _prover, Errors.ProverClaim__NotFirstProver(i, registered));

        return;
      }
    }

    revert Errors.ProverClaim__NoFirstProverInRange(_claim.checkpointNumber, proofCheckpointNumber);
  }
}
