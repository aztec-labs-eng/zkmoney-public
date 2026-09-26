// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {ITeeRegistry} from "@core/interfaces/ITeeRegistry.sol";
import {INitroValidator, TEERegistrationLib} from "@core/lib/TEERegistrationLib.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Errors} from "@core/lib/Errors.sol";

contract TeeRegistry is ITeeRegistry {
  struct RegistrationMessage {
    bytes32 key;
    uint256 index;
  }

  uint256 public constant TEE_ATTESTATION_MAX_AGE = 1 hours;

  ICertManager public immutable TEE_CERT_MANAGER;

  INitroValidator public immutable TEE_NITRO_VALIDATOR;

  IInbox public immutable INBOX;

  uint256 public immutable ROLLUP_VERSION;

  bytes32 public immutable L2_RECIPIENT;

  bytes32 public immutable override(ITeeRegistry) PCR0_HASH;

  event TEEAdded(
    address indexed tee,
    bytes32 pubKeyX,
    bytes32 pubKeyY,
    bytes32 encPubKeyX,
    bytes32 encPubKeyY,
    bytes32 messageKey,
    uint256 index
  );

  mapping(address tee => TEERegistrationLib.TEEKeys keys) public $teeKeys;

  // solhint-disable-next-line oxide/no-comments
  /**
   * @notice The L1→L2 message sent when the tee was registered. Never consumed on L2: verifiers recompute its hash
   * from this registry, the tee's public key and `index`, and prove membership in the L1→L2 message tree.
   */
  mapping(address tee => RegistrationMessage message) public $registrationMessages;

  constructor(
    bytes32 _pcr0Hash,
    ICertManager _certManager,
    INitroValidator _nitroValidator,
    IRegistry _registry,
    uint256 _rollupVersion,
    bytes32 _l2Recipient
  ) {
    TEERegistrationLib.validatePcr0Hash(_pcr0Hash);
    require(address(_certManager) != address(0), Errors.TeeRegistry__ZeroCertManager());
    require(address(_nitroValidator) != address(0), Errors.TeeRegistry__ZeroNitroValidator());
    require(address(_nitroValidator.certManager()) == address(_certManager), Errors.TeeRegistry__CertManagerMismatch());
    require(_l2Recipient != bytes32(0), Errors.TeeRegistry__ZeroL2Recipient());
    TEE_CERT_MANAGER = _certManager;
    TEE_NITRO_VALIDATOR = _nitroValidator;
    ROLLUP_VERSION = _rollupVersion;
    INBOX = IRollup(address(_registry.getRollup(_rollupVersion))).getInbox();
    require(address(INBOX) != address(0), Errors.TeeRegistry__ZeroInbox());
    L2_RECIPIENT = _l2Recipient;
    PCR0_HASH = _pcr0Hash;
  }

  function verifyTeeCACert(bytes calldata _cert, bytes32 _parentCertHash)
    external
    override(ITeeRegistry)
    returns (bytes32 certHash)
  {
    return TEERegistrationLib.verifyCACert(TEE_CERT_MANAGER, _cert, _parentCertHash);
  }

  function verifyTeeClientCert(bytes calldata _cert, bytes32 _parentCertHash)
    external
    override(ITeeRegistry)
    returns (bytes32 certHash)
  {
    return TEERegistrationLib.verifyClientCert(TEE_CERT_MANAGER, _cert, _parentCertHash);
  }

  function verifyTeeAttestationHash(bytes calldata _attestationTbs)
    external
    override(ITeeRegistry)
    returns (bytes32 attestationTbsKeccak)
  {
    return TEERegistrationLib.verifyAttestationHash(TEE_NITRO_VALIDATOR, _attestationTbs);
  }

  function verifyTeeAttestationSig(bytes32 _attestationTbsKeccak, bytes calldata _signature, bytes32 _leafCertHash)
    external
    override(ITeeRegistry)
  {
    TEERegistrationLib.verifyAttestationSig(TEE_NITRO_VALIDATOR, _attestationTbsKeccak, _signature, _leafCertHash);
  }

  function registerTee(
    bytes calldata _attestationTbs,
    bytes calldata _signature,
    bytes32 _teePubKeyX,
    bytes32 _teePubKeyY,
    bytes32 _encPubKeyX,
    bytes32 _encPubKeyY
  ) external override(ITeeRegistry) returns (bytes32 key, uint256 index) {
    TEERegistrationLib.TEEKeys memory keys = TEERegistrationLib.TEEKeys({
      pubKeyX: _teePubKeyX, pubKeyY: _teePubKeyY, encPubKeyX: _encPubKeyX, encPubKeyY: _encPubKeyY
    });
    bytes32 pcr0Hash = TEERegistrationLib.validateAttestation(
      TEE_NITRO_VALIDATOR, TEE_ATTESTATION_MAX_AGE, _attestationTbs, _signature, keys
    );
    require(pcr0Hash == PCR0_HASH, Errors.TEERegistration__UnapprovedTEEPcr0(pcr0Hash));
    (key, index) = _recordTee(keys);
  }

  function isTeeRegistered(address _tee) public view override(ITeeRegistry) returns (bool) {
    TEERegistrationLib.TEEKeys storage keys = $teeKeys[_tee];
    return keys.pubKeyX != bytes32(0) || keys.pubKeyY != bytes32(0);
  }

  function _recordTee(TEERegistrationLib.TEEKeys memory _keys) private returns (bytes32 key, uint256 index) {
    address tee = TEERegistrationLib.teeAddress(_keys);
    require(!isTeeRegistered(tee), Errors.TEERegistration__AlreadyRegistered());
    $teeKeys[tee] = _keys;

    bytes32 contentHash =
      Hash.sha256ToField(abi.encodeWithSignature("register_signer(bytes32,bytes32)", _keys.pubKeyX, _keys.pubKeyY));

    (key, index) = INBOX.sendL2Message(
      DataStructures.L2Actor({actor: L2_RECIPIENT, version: ROLLUP_VERSION}),
      contentHash,
      OxideConstants.PORTAL_CONSTANT_SECRET_HASH
    );
    $registrationMessages[tee] = RegistrationMessage({key: key, index: index});

    emit TEEAdded(tee, _keys.pubKeyX, _keys.pubKeyY, _keys.encPubKeyX, _keys.encPubKeyY, key, index);
  }
}
