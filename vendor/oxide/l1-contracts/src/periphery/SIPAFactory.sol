// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {SIPABase} from "./SIPABase.sol";
import {RecoveryCommitmentLib} from "./RecoveryCommitmentLib.sol";
import {Errors} from "@periphery/Errors.sol";

contract SIPAFactory is Ownable {
  uint256 private constant CLONE_IMPLEMENTATION_OFFSET = 10;
  uint256 private constant CLONE_RUNTIME_PREFIX = 45;

  mapping(address implementation => SIPABase.Intent intent) public intentOf;

  mapping(address portal => mapping(SIPABase.Intent intent => address implementation)) public implementationFor;

  event ImplementationBlessed(
    address indexed portal, address indexed implementation, uint256 rollupVersion, SIPABase.Intent intent
  );

  constructor(address owner) Ownable(owner) {}

  function bless(address implementation) external onlyOwner {
    require(implementation != address(0), Errors.SIPAFactory__ZeroImplementation());

    SIPABase.Intent intent = SIPABase(implementation).INTENT();
    require(intent != SIPABase.Intent.None, Errors.SIPAFactory__ZeroImplementation());

    IOxidePortal portal = SIPABase(implementation).PORTAL();
    address portalAddress = address(portal);
    require(
      implementationFor[portalAddress][intent] == address(0),
      Errors.SIPAFactory__PortalIntentAlreadyPointed(
        portalAddress, uint8(intent), implementationFor[portalAddress][intent]
      )
    );

    intentOf[implementation] = intent;
    implementationFor[portalAddress][intent] = implementation;
    emit ImplementationBlessed(portalAddress, implementation, portal.ROLLUP_VERSION(), intent);
  }

  function sipaIntentOf(address caller) public view returns (SIPABase.Intent) {
    uint256 codeLength = caller.code.length;
    if (codeLength < CLONE_RUNTIME_PREFIX || codeLength > 24_576) return SIPABase.Intent.None;

    address implementation = cloneImplementation(caller);
    SIPABase.Intent intent = intentOf[implementation];
    if (intent == SIPABase.Intent.None) return SIPABase.Intent.None;

    bool derives =
      caller
      == Clones.predictDeterministicAddressWithImmutableArgs(
        implementation, Clones.fetchCloneArgs(caller), bytes32(0), address(this)
      );
    return derives ? intent : SIPABase.Intent.None;
  }

  function isBlessed(address caller) external view returns (bool) {
    return sipaIntentOf(caller) != SIPABase.Intent.None;
  }

  function cloneImplementation(address clone) public view returns (address implementation) {
    bytes memory word = new bytes(20);
    assembly ("memory-safe") {
      extcodecopy(clone, add(word, 0x20), CLONE_IMPLEMENTATION_OFFSET, 20)
    }
    return address(bytes20(word));
  }

  function predictSIPA(
    address implementation,
    bytes32 intentHash,
    bytes32 recoveryCommitment,
    uint256 rollupVersion,
    bool resweepable
  ) external view returns (address) {
    return Clones.predictDeterministicAddressWithImmutableArgs(
      implementation, _args(intentHash, recoveryCommitment, rollupVersion, resweepable), bytes32(0)
    );
  }

  function deploySIPA(
    address implementation,
    bytes32 intentHash,
    bytes32 recoveryCommitment,
    uint256 rollupVersion,
    bool resweepable
  ) external returns (address) {
    return Clones.cloneDeterministicWithImmutableArgs(
      implementation, _args(intentHash, recoveryCommitment, rollupVersion, resweepable), bytes32(0)
    );
  }

  function _args(bytes32 intentHash, bytes32 recoveryCommitment, uint256 rollupVersion, bool resweepable)
    private
    pure
    returns (bytes memory)
  {
    require(
      RecoveryCommitmentLib.fitsL2Field(recoveryCommitment),
      Errors.SIPAFactory__RecoveryCommitmentTooLarge(recoveryCommitment)
    );
    return abi.encode(
      SIPABase.Args({
        intentHash: intentHash,
        recoveryCommitment: recoveryCommitment,
        rollupVersion: rollupVersion,
        resweepable: resweepable
      })
    );
  }
}
