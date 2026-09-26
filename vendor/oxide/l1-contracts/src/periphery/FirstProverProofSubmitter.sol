// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;
import {IRollup, SubmitEpochRootProofArgs} from "@aztec/core/interfaces/IRollup.sol";
import {IValidatorSelection} from "@aztec/core/interfaces/IValidatorSelection.sol";
import {ChainTips} from "@aztec/core/libraries/compressed-data/Tips.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";

contract FirstProverProofSubmitter {
  IRollup public immutable ROLLUP;
  IOxidePortal public immutable PORTAL;

  constructor(IRollup _rollup, IOxidePortal _portal) {
    require(address(_portal.ROLLUP()) == address(_rollup));
    ROLLUP = _rollup;
    PORTAL = _portal;
  }

  function submitEpochRootProof(SubmitEpochRootProofArgs calldata _args) external {
    address prover = _args.args.proverId;
    uint256 checkpointNumber = _args.end;
    uint256 proofLength = _args.end - _args.start + 1;

    bool strict = !isProofComplete(checkpointNumber);

    bool prepared = _prepareCapture(checkpointNumber, prover, strict);
    ROLLUP.submitEpochRootProof(_args);
    if (prepared) {
      _recordCapture(checkpointNumber, proofLength, prover, strict);
    }
  }

  function isProofComplete(uint256 _end) internal view returns (bool) {
    Epoch endEpoch = ROLLUP.getEpochForCheckpoint(_end);
    ChainTips memory tips = ROLLUP.getTips();

    if (_end < tips.pending) {
      return ROLLUP.getEpochForCheckpoint(_end + 1) > endEpoch;
    }

    return IValidatorSelection(address(ROLLUP)).getCurrentEpoch() > endEpoch;
  }

  function _prepareCapture(uint256 _checkpointNumber, address _prover, bool _strict) internal returns (bool) {
    if (_strict) {
      PORTAL.prepareFirstProver(_checkpointNumber, _prover);
      return true;
    }
    try PORTAL.prepareFirstProver(_checkpointNumber, _prover) {
      return true;
    } catch {
      return false;
    }
  }

  function _recordCapture(uint256 _checkpointNumber, uint256 _proofLength, address _prover, bool _strict) internal {
    if (_strict) {
      PORTAL.recordFirstProver(_checkpointNumber, _proofLength, _prover);
    } else {
      try PORTAL.recordFirstProver(_checkpointNumber, _proofLength, _prover) {} catch {}
    }
  }
}
