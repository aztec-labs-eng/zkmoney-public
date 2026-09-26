// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IOutbox, MAX_CHECKPOINTS_PER_EPOCH} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";

contract MockOutbox is IOutbox {
  struct Call {
    bytes32 senderActor;
    uint256 senderVersion;
    address recipientActor;
    uint256 recipientChainId;
    bytes32 content;
    uint256 epoch;
    uint256 numCheckpointsInEpoch;
    uint256 leafIndex;
    uint256 pathLength;
  }

  Call[] public calls;
  bool public shouldRevert;
  bytes public revertData;
  mapping(uint256 epoch => mapping(uint256 numCheckpointsInEpoch => bytes32 root)) internal roots;
  uint256 public VERSION = 7;

  function primeRevert(bytes calldata _data) external {
    shouldRevert = true;
    revertData = _data;
  }

  function setRoot(uint256 _epoch, uint256 _numCheckpointsInEpoch, bytes32 _root) external {
    roots[_epoch][_numCheckpointsInEpoch] = _root;
  }

  function consume(
    DataStructures.L2ToL1Msg calldata _message,
    Epoch _epoch,
    uint256 _numCheckpointsInEpoch,
    uint256 _leafIndex,
    bytes32[] calldata _path
  ) external override {
    if (shouldRevert) {
      bytes memory data = revertData;
      assembly {
        revert(add(data, 0x20), mload(data))
      }
    }
    calls.push(
      Call({
        senderActor: _message.sender.actor,
        senderVersion: _message.sender.version,
        recipientActor: _message.recipient.actor,
        recipientChainId: _message.recipient.chainId,
        content: _message.content,
        epoch: Epoch.unwrap(_epoch),
        numCheckpointsInEpoch: _numCheckpointsInEpoch,
        leafIndex: _leafIndex,
        pathLength: _path.length
      })
    );
  }

  function callCount() external view returns (uint256) {
    return calls.length;
  }

  function insert(Epoch, uint256, bytes32) external pure {}

  function hasMessageBeenConsumedAtEpoch(Epoch, uint256) external pure returns (bool) {
    return false;
  }

  function getRootData(Epoch _epoch, uint256 _numCheckpointsInEpoch) external view returns (bytes32) {
    return roots[Epoch.unwrap(_epoch)][_numCheckpointsInEpoch];
  }

  function getRoots(Epoch _epoch) external view returns (bytes32[MAX_CHECKPOINTS_PER_EPOCH] memory out) {
    for (uint256 i = 0; i < MAX_CHECKPOINTS_PER_EPOCH; i++) {
      out[i] = roots[Epoch.unwrap(_epoch)][i + 1];
    }
  }
}
