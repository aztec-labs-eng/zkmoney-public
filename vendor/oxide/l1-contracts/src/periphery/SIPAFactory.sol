// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IForwardingTable} from "./interfaces/IForwardingTable.sol";
import {SIPABase} from "./SIPABase.sol";
import {RecoveryCommitmentLib} from "./RecoveryCommitmentLib.sol";
import {Errors} from "@periphery/Errors.sol";

contract SIPAFactory is Ownable {
  uint256 private constant CLONE_IMPLEMENTATION_OFFSET = 10;
  uint256 private constant CLONE_RUNTIME_PREFIX = 45;
  uint256 private constant ARGS_LENGTH = 5 * 32;

  mapping(address implementation => SIPABase.Intent intent) public intentOf;

  mapping(SIPABase.Intent intent => address implementation) public implementationFor;

  mapping(address table => bool approved) public approvedTable;

  event ImplementationBlessed(address indexed implementation, SIPABase.Intent indexed intent);

  event TableBlessed(address indexed table);

  constructor(address owner) Ownable(owner) {}

  function blessImplementation(address implementation) external onlyOwner {
    require(implementation != address(0), Errors.SIPAFactory__ZeroImplementation());
    SIPABase.Intent intent = SIPABase(implementation).INTENT();
    require(intent != SIPABase.Intent.None, Errors.SIPAFactory__ZeroImplementation());

    intentOf[implementation] = intent;
    implementationFor[intent] = implementation;
    emit ImplementationBlessed(implementation, intent);
  }

  function blessTable(IForwardingTable table) external onlyOwner {
    require(address(table) != address(0), Errors.SIPAFactory__ZeroTable());

    approvedTable[address(table)] = true;
    emit TableBlessed(address(table));
  }

  function sipaIntentOf(address caller) public view returns (SIPABase.Intent) {
    uint256 codeLength = caller.code.length;
    if (codeLength < CLONE_RUNTIME_PREFIX || codeLength > 24_576) return SIPABase.Intent.None;

    address implementation = cloneImplementation(caller);
    SIPABase.Intent intent = intentOf[implementation];
    if (intent == SIPABase.Intent.None) return SIPABase.Intent.None;

    bytes memory args = Clones.fetchCloneArgs(caller);
    if (args.length != ARGS_LENGTH) return SIPABase.Intent.None;

    bool derives =
      caller == Clones.predictDeterministicAddressWithImmutableArgs(implementation, args, bytes32(0), address(this));
    if (!derives) return SIPABase.Intent.None;

    if (!approvedTable[address(abi.decode(args, (SIPABase.Args)).table)]) return SIPABase.Intent.None;
    return intent;
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
    bool resweepable,
    IForwardingTable table
  ) external view returns (address) {
    return Clones.predictDeterministicAddressWithImmutableArgs(
      implementation, _args(intentHash, recoveryCommitment, rollupVersion, resweepable, table), bytes32(0)
    );
  }

  function deploySIPA(
    address implementation,
    bytes32 intentHash,
    bytes32 recoveryCommitment,
    uint256 rollupVersion,
    bool resweepable,
    IForwardingTable table
  ) external returns (address) {
    return Clones.cloneDeterministicWithImmutableArgs(
      implementation, _args(intentHash, recoveryCommitment, rollupVersion, resweepable, table), bytes32(0)
    );
  }

  function _args(
    bytes32 intentHash,
    bytes32 recoveryCommitment,
    uint256 rollupVersion,
    bool resweepable,
    IForwardingTable table
  ) private pure returns (bytes memory) {
    require(
      RecoveryCommitmentLib.fitsL2Field(recoveryCommitment),
      Errors.SIPAFactory__RecoveryCommitmentTooLarge(recoveryCommitment)
    );
    return abi.encode(
      SIPABase.Args({
        intentHash: intentHash,
        recoveryCommitment: recoveryCommitment,
        rollupVersion: rollupVersion,
        resweepable: resweepable,
        table: table
      })
    );
  }
}
