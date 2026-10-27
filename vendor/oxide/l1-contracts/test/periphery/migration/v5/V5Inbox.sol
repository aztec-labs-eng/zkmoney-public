// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IV5Inbox} from "./IV5Inbox.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {V5FrontierLib} from "./V5FrontierLib.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Errors} from "@aztec/core/libraries/Errors.sol";
import {SafeCast} from "@oz/utils/math/SafeCast.sol";

contract V5Inbox is IV5Inbox {
  error V5Inbox__MustBuildBeforeConsume();

  using Hash for DataStructures.L1ToL2Msg;
  using V5FrontierLib for V5FrontierLib.Forest;
  using V5FrontierLib for V5FrontierLib.Tree;

  address public immutable ROLLUP;
  uint256 public immutable VERSION;
  address public immutable FEE_ASSET_PORTAL;

  uint256 public immutable LAG;

  uint256 internal immutable HEIGHT;
  uint256 internal immutable SIZE;
  bytes32 internal immutable EMPTY_ROOT;

  V5FrontierLib.Forest internal forest;

  mapping(uint256 checkpointNumber => V5FrontierLib.Tree tree) public trees;

  InboxState internal state;

  constructor(address _rollup, uint256 _version, uint256 _height, uint256 _lag) {
    ROLLUP = _rollup;
    VERSION = _version;

    HEIGHT = _height;
    SIZE = 2 ** _height;

    require(_lag > 0, "LAG TOO SMALL");
    LAG = _lag;

    state = InboxState({
      rollingHash: 0, totalMessagesInserted: 0, inProgress: SafeCast.toUint64(Constants.INITIAL_CHECKPOINT_NUMBER + LAG)
    });

    forest.initialize(_height);
    EMPTY_ROOT = trees[type(uint256).max].root(forest, HEIGHT, SIZE);
  }

  function sendL2Message(DataStructures.L2Actor memory _recipient, bytes32 _content, bytes32 _secretHash)
    external
    override(IV5Inbox)
    returns (bytes32, uint256)
  {
    require(uint256(_recipient.actor) <= Constants.MAX_FIELD_VALUE, Errors.Inbox__ActorTooLarge(_recipient.actor));
    require(_recipient.version == VERSION, Errors.Inbox__VersionMismatch(_recipient.version, VERSION));
    require(uint256(_content) <= Constants.MAX_FIELD_VALUE, Errors.Inbox__ContentTooLarge(_content));
    require(uint256(_secretHash) <= Constants.MAX_FIELD_VALUE, Errors.Inbox__SecretHashTooLarge(_secretHash));

    InboxState memory _state = state;
    bytes16 rollingHash = _state.rollingHash;
    uint64 totalMessagesInserted = _state.totalMessagesInserted;
    uint64 inProgress = _state.inProgress;

    V5FrontierLib.Tree storage currentTree = trees[inProgress];

    if (currentTree.isFull(SIZE)) {
      inProgress += 1;
      currentTree = trees[inProgress];
    }

    uint256 index = (inProgress - Constants.INITIAL_CHECKPOINT_NUMBER) * SIZE + currentTree.nextIndex;

    address senderAddress = msg.sender == FEE_ASSET_PORTAL ? address(uint160(Constants.FEE_JUICE_ADDRESS)) : msg.sender;

    DataStructures.L1ToL2Msg memory message = DataStructures.L1ToL2Msg({
      sender: DataStructures.L1Actor(senderAddress, block.chainid),
      recipient: _recipient,
      content: _content,
      secretHash: _secretHash,
      index: index
    });

    bytes32 leaf = message.sha256ToField();
    currentTree.insertLeaf(leaf);

    bytes16 updatedRollingHash = bytes16(keccak256(abi.encodePacked(rollingHash, leaf)));
    state = InboxState({
      rollingHash: updatedRollingHash, totalMessagesInserted: totalMessagesInserted + 1, inProgress: inProgress
    });

    emit MessageSent(inProgress, index, leaf, updatedRollingHash);

    return (leaf, index);
  }

  function consume(uint256 _toConsume) external override(IV5Inbox) returns (bytes32) {
    require(msg.sender == ROLLUP, Errors.Inbox__Unauthorized());

    uint64 inProgress = state.inProgress;
    require(_toConsume < inProgress, V5Inbox__MustBuildBeforeConsume());

    bytes32 root = EMPTY_ROOT;
    if (_toConsume > Constants.INITIAL_CHECKPOINT_NUMBER) {
      root = trees[_toConsume].root(forest, HEIGHT, SIZE);
    }

    if (_toConsume + LAG == inProgress) {
      state.inProgress = inProgress + 1;
    }

    return root;
  }

  function getFeeAssetPortal() external view override(IV5Inbox) returns (address) {
    return FEE_ASSET_PORTAL;
  }

  function getRoot(uint256 _checkpointNumber) external view override(IV5Inbox) returns (bytes32) {
    return trees[_checkpointNumber].root(forest, HEIGHT, SIZE);
  }

  function getState() external view override(IV5Inbox) returns (InboxState memory) {
    return state;
  }

  function getTotalMessagesInserted() external view override(IV5Inbox) returns (uint64) {
    return state.totalMessagesInserted;
  }

  function getInProgress() external view override(IV5Inbox) returns (uint64) {
    return state.inProgress;
  }
}
