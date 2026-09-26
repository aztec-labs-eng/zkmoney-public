// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";

contract MockInbox is IInbox {
  struct Call {
    bytes32 recipientActor;
    uint256 recipientVersion;
    bytes32 contentHash;
    bytes32 secretHash;
  }

  Call[] public calls;
  bytes32 public nextKey;
  uint256 public nextIndex;
  uint64 internal inProgressCheckpoint;
  mapping(uint256 checkpointNumber => bytes32 root) internal roots;

  function primeNext(bytes32 _key, uint256 _index) external {
    nextKey = _key;
    nextIndex = _index;
  }

  function setInProgress(uint64 _inProgress) external {
    inProgressCheckpoint = _inProgress;
  }

  function setRoot(uint256 _checkpointNumber, bytes32 _root) external {
    roots[_checkpointNumber] = _root;
  }

  function sendL2Message(DataStructures.L2Actor memory _recipient, bytes32 _content, bytes32 _secretHash)
    external
    returns (bytes32, uint256)
  {
    calls.push(
      Call({
        recipientActor: _recipient.actor,
        recipientVersion: _recipient.version,
        contentHash: _content,
        secretHash: _secretHash
      })
    );
    return (nextKey, nextIndex);
  }

  function callCount() external view returns (uint256) {
    return calls.length;
  }

  function consume(uint256) external pure returns (bytes32) {
    return bytes32(0);
  }

  function catchUp(uint256) external pure {}

  function getFeeAssetPortal() external pure returns (address) {
    return address(0);
  }

  function getRoot(uint256 _checkpointNumber) external view returns (bytes32) {
    return roots[_checkpointNumber];
  }

  function getState() external pure returns (InboxState memory state) {
    return state;
  }

  function getTotalMessagesInserted() external pure returns (uint64) {
    return 0;
  }

  function getInProgress() external view returns (uint64) {
    return inProgressCheckpoint;
  }
}
