// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IForwardingTable} from "./interfaces/IForwardingTable.sol";
import {SIPABase} from "./SIPABase.sol";
import {RecoveryCommitmentLib} from "./RecoveryCommitmentLib.sol";
import {Errors} from "@periphery/Errors.sol";
import {Intent, Intents} from "@periphery/Intent.sol";

contract SIPAFactory is Ownable {
  uint256 private constant CLONE_IMPLEMENTATION_OFFSET = 10;
  uint256 private constant CLONE_RUNTIME_PREFIX = 45;
  uint256 private constant ARGS_LENGTH = 5 * 32;

  mapping(address implementation => Intent intent) public intentOf;

  mapping(Intent intent => address implementation) public implementationFor;

  mapping(address table => bool approved) public approvedTable;

  event ImplementationBlessed(address indexed implementation, Intent indexed intent);

  event TableBlessed(address indexed table);

  constructor(address owner) Ownable(owner) {}

  function blessImplementation(address implementation) external onlyOwner {
    require(implementation != address(0), Errors.SIPAFactory__ZeroImplementation());
    Intent intent = SIPABase(implementation).INTENT();
    require(intent != Intents.NONE, Errors.SIPAFactory__ZeroImplementation());

    intentOf[implementation] = intent;
    implementationFor[intent] = implementation;
    emit ImplementationBlessed(implementation, intent);
  }

  function blessTable(IForwardingTable table) external onlyOwner {
    require(address(table) != address(0), Errors.SIPAFactory__ZeroTable());

    approvedTable[address(table)] = true;
    emit TableBlessed(address(table));
  }

  function sipaIntentOf(address caller) public view returns (Intent) {
    uint256 codeLength = caller.code.length;
    if (codeLength < CLONE_RUNTIME_PREFIX || codeLength > 24_576) return Intents.NONE;

    address implementation = cloneImplementation(caller);
    Intent intent = intentOf[implementation];
    if (intent == Intents.NONE) return Intents.NONE;

    bytes memory args = Clones.fetchCloneArgs(caller);
    if (args.length != ARGS_LENGTH) return Intents.NONE;

    bool derives =
      caller == Clones.predictDeterministicAddressWithImmutableArgs(implementation, args, bytes32(0), address(this));
    if (!derives) return Intents.NONE;

    if (!approvedTable[address(abi.decode(args, (SIPABase.Args)).table)]) return Intents.NONE;
    return intent;
  }

  function isBlessed(address caller) external view returns (bool) {
    return sipaIntentOf(caller) != Intents.NONE;
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
