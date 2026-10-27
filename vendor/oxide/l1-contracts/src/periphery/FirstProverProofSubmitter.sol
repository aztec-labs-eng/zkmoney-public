// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;
import {IRollup, SubmitEpochRootProofArgs} from "@aztec/core/interfaces/IRollup.sol";
import {IValidatorSelection} from "@aztec/core/interfaces/IValidatorSelection.sol";
import {ChainTips} from "@aztec/core/libraries/compressed-data/Tips.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {Errors} from "@periphery/Errors.sol";

contract FirstProverProofSubmitter {
  IRollup public immutable ROLLUP;

  constructor(IRollup _rollup) {
    ROLLUP = _rollup;
  }

  function submitEpochRootProof(SubmitEpochRootProofArgs calldata _args) external {
    if (!isProofComplete(_args.end)) {
      uint256 proven = ROLLUP.getProvenCheckpointNumber();
      // solhint-disable oxide/no-comments
      // A late partial proof cannot make its sender the first prover, so it earns no Oxide prover tips. Revert it
      // before the expensive verification.
      // solhint-enable oxide/no-comments
      require(proven < _args.end, Errors.FirstProverProofSubmitter__CheckpointAlreadyProven(_args.end, proven));
    }
    ROLLUP.submitEpochRootProof(_args);
  }

  function isProofComplete(uint256 _end) internal view returns (bool) {
    Epoch endEpoch = ROLLUP.getEpochForCheckpoint(_end);
    ChainTips memory tips = ROLLUP.getTips();

    if (_end < tips.pending) {
      return ROLLUP.getEpochForCheckpoint(_end + 1) > endEpoch;
    }

    return IValidatorSelection(address(ROLLUP)).getCurrentEpoch() > endEpoch;
  }
}
