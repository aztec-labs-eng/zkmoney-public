// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {Errors} from "@aztec/core/libraries/Errors.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

contract MockRollup {
  mapping(uint256 checkpointNumber => bytes32 archiveRoot) internal archives;
  mapping(uint256 checkpointNumber => uint256 epoch) internal epochs;
  uint256 internal provenCheckpointNumber;
  uint256 internal pendingCheckpointNumber;
  mapping(uint256 checkpointNumber => uint256 encodedProverId) internal firstProvenBy;
  IInbox internal inbox;
  IOutbox internal outbox;
  IERC20 internal feeAsset;
  IFeeJuicePortal internal feeAssetPortal;
  uint256 public constant ROUNDABOUT_SIZE = 65;

  function setArchive(uint256 _checkpointNumber, bytes32 _archiveRoot) external {
    archives[_checkpointNumber] = _archiveRoot;
  }

  function setCheckpoint(uint256 _checkpointNumber, bytes32 _archiveRoot, uint256 _epoch) external {
    archives[_checkpointNumber] = _archiveRoot;
    epochs[_checkpointNumber] = _epoch;
    if (_checkpointNumber > pendingCheckpointNumber) {
      pendingCheckpointNumber = _checkpointNumber;
    }
  }

  function setProvenCheckpointNumber(uint256 _checkpointNumber) external {
    provenCheckpointNumber = _checkpointNumber;
  }

  function getProvenCheckpointNumber() external view returns (uint256) {
    return provenCheckpointNumber;
  }

  function setPendingCheckpointNumber(uint256 _checkpointNumber) external {
    pendingCheckpointNumber = _checkpointNumber;
  }

  function getPendingCheckpointNumber() external view returns (uint256) {
    return pendingCheckpointNumber;
  }

  function proveRange(uint256 _start, uint256 _end, address _prover) external {
    _proveRange(_start, _end, _prover);
  }

  function getFirstProvenBy(uint256 _checkpointNumber) external view returns (address) {
    uint256 proven = provenCheckpointNumber;
    require(
      0 < _checkpointNumber && _checkpointNumber <= proven,
      Errors.Rollup__CheckpointNotProven(proven, _checkpointNumber)
    );
    for (uint256 i = _checkpointNumber; i <= proven; i++) {
      uint256 encodedProverId = firstProvenBy[i];
      if (encodedProverId != 0) {
        return address(uint160(encodedProverId));
      }
    }
    revert Errors.Rollup__CheckpointNotProven(proven, _checkpointNumber);
  }

  function _proveRange(uint256 _start, uint256 _end, address _prover) internal {
    require(_start <= _end && _start <= provenCheckpointNumber + 1, "MockRollup: proof leaves a gap");
    if (_end > provenCheckpointNumber) {
      provenCheckpointNumber = _end;
      firstProvenBy[_end] = uint256(uint160(_prover)) | (1 << 160);
    }
  }

  function setInbox(IInbox _inbox) external {
    inbox = _inbox;
  }

  function getInbox() external view returns (IInbox) {
    return inbox;
  }

  function setOutbox(IOutbox _outbox) external {
    outbox = _outbox;
  }

  function getOutbox() external view returns (IOutbox) {
    return outbox;
  }

  function setFeeAsset(IERC20 _feeAsset) external {
    feeAsset = _feeAsset;
  }

  function getFeeAsset() external view returns (IERC20) {
    return feeAsset;
  }

  function setFeeAssetPortal(IFeeJuicePortal _feeAssetPortal) external {
    feeAssetPortal = _feeAssetPortal;
  }

  function getFeeAssetPortal() external view returns (IFeeJuicePortal) {
    return feeAssetPortal;
  }

  function getVersion() external pure returns (uint256) {
    return 7;
  }

  function getManaTarget() external pure returns (uint256) {
    return 1;
  }

  function archiveAt(uint256 _checkpointNumber) external view returns (bytes32) {
    return archives[_checkpointNumber];
  }

  function getEpochForCheckpoint(uint256 _checkpointNumber) external view returns (Epoch) {
    uint256 upperLimit = _checkpointNumber + ROUNDABOUT_SIZE;
    require(
      _checkpointNumber <= pendingCheckpointNumber && pendingCheckpointNumber < upperLimit,
      Errors.Rollup__UnavailableTempCheckpointLog(_checkpointNumber, pendingCheckpointNumber, upperLimit)
    );
    return Epoch.wrap(epochs[_checkpointNumber]);
  }
}
