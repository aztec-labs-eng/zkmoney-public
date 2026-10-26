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

  function primeNext(bytes32 _key, uint256 _index) external {
    nextKey = _key;
    nextIndex = _index;
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

  function markProvenConsumed(uint64) external pure {}

  function getFeeAssetPortal() external pure returns (address) {
    return address(0);
  }

  function getState() external pure returns (InboxState memory state) {
    return state;
  }

  function getTotalMessagesInserted() external pure returns (uint64) {
    return 0;
  }

  function getCurrentBucketSeq() external pure returns (uint64) {
    return 0;
  }

  function getBucket(uint256) external pure returns (InboxBucket memory bucket) {
    return bucket;
  }

  function getBucketAtOrBeforeTotal(uint64) external pure returns (uint64, InboxBucket memory bucket) {
    return (0, bucket);
  }

  function getProvenConsumedBucketSeq() external pure returns (uint64) {
    return 0;
  }

  function getRingHeadroom() external pure returns (uint256) {
    return type(uint256).max;
  }
}
