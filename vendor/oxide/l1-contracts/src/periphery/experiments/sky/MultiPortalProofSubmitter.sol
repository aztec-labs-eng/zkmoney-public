// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;
import {IRollup, SubmitEpochRootProofArgs} from "@aztec/core/interfaces/IRollup.sol";
import {IValidatorSelection} from "@aztec/core/interfaces/IValidatorSelection.sol";
import {ChainTips} from "@aztec/core/libraries/compressed-data/Tips.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";

contract MultiPortalProofSubmitter is Ownable {
  IRollup public immutable ROLLUP;

  IOxidePortal[] internal $portals;

  mapping(IOxidePortal portal => bool registered) public $isPortal;

  error MultiPortalProofSubmitter__PortalWithoutCode(address portal);
  error MultiPortalProofSubmitter__PortalRollupMismatch(address portal, address rollup);
  error MultiPortalProofSubmitter__PortalAlreadyRegistered(address portal);
  error MultiPortalProofSubmitter__PortalNotRegistered(address portal);

  constructor(IRollup _rollup, address _owner) Ownable(_owner) {
    ROLLUP = _rollup;
  }

  function addPortal(IOxidePortal _portal) external onlyOwner {
    require(address(_portal).code.length > 0, MultiPortalProofSubmitter__PortalWithoutCode(address(_portal)));
    require(!$isPortal[_portal], MultiPortalProofSubmitter__PortalAlreadyRegistered(address(_portal)));
    require(
      address(_portal.ROLLUP()) == address(ROLLUP),
      MultiPortalProofSubmitter__PortalRollupMismatch(address(_portal), address(_portal.ROLLUP()))
    );

    $isPortal[_portal] = true;
    $portals.push(_portal);
  }

  function removePortal(IOxidePortal _portal) external onlyOwner {
    require($isPortal[_portal], MultiPortalProofSubmitter__PortalNotRegistered(address(_portal)));

    $isPortal[_portal] = false;

    uint256 length = $portals.length;
    for (uint256 i = 0; i < length; i++) {
      if (address($portals[i]) == address(_portal)) {
        $portals[i] = $portals[length - 1];
        $portals.pop();
        break;
      }
    }
  }

  function portals() external view returns (IOxidePortal[] memory) {
    return $portals;
  }

  function portalCount() external view returns (uint256) {
    return $portals.length;
  }

  function submitEpochRootProof(SubmitEpochRootProofArgs calldata _args) external {
    address prover = _args.args.proverId;
    uint256 checkpointNumber = _args.end;
    uint256 proofLength = _args.end - _args.start + 1;

    bool strict = !isProofComplete(checkpointNumber);

    uint256 length = $portals.length;
    bool[] memory prepared = new bool[](length);
    for (uint256 i = 0; i < length; i++) {
      prepared[i] = _prepareCapture($portals[i], checkpointNumber, prover, strict);
    }

    ROLLUP.submitEpochRootProof(_args);

    for (uint256 i = 0; i < length; i++) {
      if (prepared[i]) {
        _recordCapture($portals[i], checkpointNumber, proofLength, prover, strict);
      }
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

  function _prepareCapture(IOxidePortal _portal, uint256 _checkpointNumber, address _prover, bool _strict)
    internal
    returns (bool)
  {
    if (_strict) {
      _portal.prepareFirstProver(_checkpointNumber, _prover);
      return true;
    }
    try _portal.prepareFirstProver(_checkpointNumber, _prover) {
      return true;
    } catch {
      return false;
    }
  }

  function _recordCapture(
    IOxidePortal _portal,
    uint256 _checkpointNumber,
    uint256 _proofLength,
    address _prover,
    bool _strict
  ) internal {
    if (_strict) {
      _portal.recordFirstProver(_checkpointNumber, _proofLength, _prover);
    } else {
      try _portal.recordFirstProver(_checkpointNumber, _proofLength, _prover) {} catch {}
    }
  }
}
