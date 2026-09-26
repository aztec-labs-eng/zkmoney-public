// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {CborElement, LibCborElement} from "@nitro-validator/CborDecode.sol";
import {Errors} from "@core/lib/Errors.sol";

using LibCborElement for CborElement;

interface INitroValidator {
  struct Ptrs {
    CborElement moduleID;
    uint64 timestamp;
    CborElement digest;
    CborElement[] pcrs;
    CborElement cert;
    CborElement[] cabundle;
    CborElement publicKey;
    CborElement userData;
    CborElement nonce;
  }

  function certManager() external view returns (ICertManager);

  function validateAttestation(bytes memory attestationTbs, bytes memory signature) external returns (Ptrs memory);

  function verifyAttestationHash(bytes calldata attestationTbs) external returns (bytes32 attestationTbsKeccak);

  function verifyAttestationSignature(bytes32 attestationTbsKeccak, bytes calldata signature, bytes32 leafCertHash)
    external;
}

library TEERegistrationLib {
  bytes12 internal constant ATTESTATION_USER_DATA_DOMAIN = bytes12("oxide-tee/v1");

  bytes32 internal constant DEBUG_MODE_PCR0_HASH = 0xc980e59163ce244bb4bb6211f48c7b46f88a4f40943e84eb99bdc41e129bd293;

  struct TEEKeys {
    bytes32 pubKeyX;
    bytes32 pubKeyY;
    bytes32 encPubKeyX;
    bytes32 encPubKeyY;
  }

  struct TEEBinding {
    bytes32 pcr0Hash;
    TEEKeys keys;
  }

  struct RegistrationContext {
    INitroValidator validator;
    IInbox inbox;
    bytes32 l2Recipient;
    uint256 rollupVersion;
    bytes32 constantSecretHash;
    uint256 maxAttestationAge;
  }

  struct UserDataBinding {
    bytes32 pubKeyX;
    bytes32 pubKeyY;
    bytes32 encPubKeyX;
    bytes32 encPubKeyY;
  }

  event TEEAdded(
    address indexed tee,
    bytes32 pubKeyX,
    bytes32 pubKeyY,
    bytes32 encPubKeyX,
    bytes32 encPubKeyY,
    bytes32 messageKey,
    uint256 index
  );
  event TEEPcr0Approved(bytes32 indexed pcr0Hash);
  event TEECACertVerified(bytes32 indexed certHash, bytes32 indexed parentCertHash);
  event TEEClientCertVerified(bytes32 indexed certHash, bytes32 indexed parentCertHash);
  event TEEAttestationHashStaged(bytes32 indexed attestationTbsKeccak);
  event TEEAttestationSigVerified(bytes32 indexed attestationTbsKeccak, bytes32 indexed leafCertHash);

  function validatePcr0Hash(bytes32 _pcr0Hash) internal pure {
    require(_pcr0Hash != bytes32(0), Errors.TEERegistration__ZeroTEEPcr0Hash());
    require(_pcr0Hash != DEBUG_MODE_PCR0_HASH, Errors.TEERegistration__DebugModeTEEPcr0Hash());
  }

  function approvePcr0(mapping(bytes32 pcr0Hash => bool approved) storage _approvedPcr0, bytes32 _pcr0Hash) internal {
    validatePcr0Hash(_pcr0Hash);
    _approvedPcr0[_pcr0Hash] = true;
    emit TEEPcr0Approved(_pcr0Hash);
  }

  function verifyCACert(ICertManager _certManager, bytes calldata _cert, bytes32 _parentCertHash)
    internal
    returns (bytes32 certHash)
  {
    certHash = _certManager.verifyCACert(_cert, _parentCertHash);
    emit TEECACertVerified(certHash, _parentCertHash);
  }

  function verifyClientCert(ICertManager _certManager, bytes calldata _cert, bytes32 _parentCertHash)
    internal
    returns (bytes32 certHash)
  {
    _certManager.verifyClientCert(_cert, _parentCertHash);
    certHash = keccak256(_cert);
    emit TEEClientCertVerified(certHash, _parentCertHash);
  }

  function verifyAttestationHash(INitroValidator _validator, bytes calldata _attestationTbs)
    internal
    returns (bytes32 attestationTbsKeccak)
  {
    attestationTbsKeccak = _validator.verifyAttestationHash(_attestationTbs);
    emit TEEAttestationHashStaged(attestationTbsKeccak);
  }

  function verifyAttestationSig(
    INitroValidator _validator,
    bytes32 _attestationTbsKeccak,
    bytes calldata _signature,
    bytes32 _leafCertHash
  ) internal {
    _validator.verifyAttestationSignature(_attestationTbsKeccak, _signature, _leafCertHash);
    emit TEEAttestationSigVerified(_attestationTbsKeccak, _leafCertHash);
  }

  function registerTee(
    bytes calldata _attestationTbs,
    bytes calldata _signature,
    mapping(bytes32 pcr0Hash => bool approved) storage _approvedPcr0,
    mapping(address tee => TEEBinding binding) storage _bindings,
    RegistrationContext memory _ctx,
    TEEKeys memory _keys
  ) internal returns (address tee, bytes32 key, uint256 index) {
    tee = teeAddress(_keys);
    bytes32 pcr0Hash = validateAttestation(_ctx.validator, _ctx.maxAttestationAge, _attestationTbs, _signature, _keys);
    require(_approvedPcr0[pcr0Hash], Errors.TEERegistration__UnapprovedTEEPcr0(pcr0Hash));
    (key, index) = _recordBinding(_bindings, _ctx, tee, _keys, pcr0Hash);
  }

  function validateAttestation(
    INitroValidator _validator,
    uint256 _maxAttestationAge,
    bytes calldata _attestationTbs,
    bytes calldata _signature,
    TEEKeys memory _keys
  ) internal returns (bytes32 pcr0Hash) {
    require(isOnCurveSecp256k1(_keys.pubKeyX, _keys.pubKeyY), Errors.TEERegistration__OffCurveTEEPubKey());
    INitroValidator.Ptrs memory ptrs = _validator.validateAttestation(_attestationTbs, _signature);
    pcr0Hash = _getPcr0HashFromAttestation(_attestationTbs, ptrs);
    _validateFreshness(ptrs, _maxAttestationAge);
    _validateUserData(
      _attestationTbs,
      ptrs,
      UserDataBinding({
        pubKeyX: _keys.pubKeyX, pubKeyY: _keys.pubKeyY, encPubKeyX: _keys.encPubKeyX, encPubKeyY: _keys.encPubKeyY
      })
    );
  }

  function _recordBinding(
    mapping(address tee => TEEBinding binding) storage _bindings,
    RegistrationContext memory _ctx,
    address _tee,
    TEEKeys memory _keys,
    bytes32 _pcr0Hash
  ) private returns (bytes32 key, uint256 index) {
    require(_bindings[_tee].pcr0Hash == bytes32(0), Errors.TEERegistration__AlreadyRegistered());
    _bindings[_tee] = TEEBinding({pcr0Hash: _pcr0Hash, keys: _keys});

    bytes32 contentHash =
      Hash.sha256ToField(abi.encodeWithSignature("register_signer(bytes32,bytes32)", _keys.pubKeyX, _keys.pubKeyY));

    (key, index) = _ctx.inbox
      .sendL2Message(
        DataStructures.L2Actor({actor: _ctx.l2Recipient, version: _ctx.rollupVersion}),
        contentHash,
        _ctx.constantSecretHash
      );

    emit TEEAdded(_tee, _keys.pubKeyX, _keys.pubKeyY, _keys.encPubKeyX, _keys.encPubKeyY, key, index);
  }

  function teeAddress(TEEKeys memory _keys) internal pure returns (address tee) {
    tee = address(uint160(uint256(keccak256(abi.encodePacked(_keys.pubKeyX, _keys.pubKeyY)))));
    require(tee != address(0), Errors.TEERegistration__ZeroTEE());
  }

  uint256 internal constant SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f;

  function isOnCurveSecp256k1(bytes32 _x, bytes32 _y) internal pure returns (bool) {
    uint256 x = uint256(_x);
    uint256 y = uint256(_y);
    if (x >= SECP256K1_P || y >= SECP256K1_P) {
      return false;
    }

    if (x == 0 && y == 0) {
      return false;
    }
    uint256 lhs = mulmod(y, y, SECP256K1_P);
    uint256 rhs = addmod(mulmod(x, mulmod(x, x, SECP256K1_P), SECP256K1_P), 7, SECP256K1_P);
    return lhs == rhs;
  }

  function _getPcr0HashFromAttestation(bytes calldata _attestationTbs, INitroValidator.Ptrs memory _ptrs)
    private
    pure
    returns (bytes32 pcr0Hash)
  {
    if (_ptrs.pcrs.length == 0 || _ptrs.pcrs[0].length() == 0) {
      revert Errors.TEERegistration__MissingTEEPcr0();
    }

    pcr0Hash = keccak256(sliceCalldata(_attestationTbs, _ptrs.pcrs[0].start(), _ptrs.pcrs[0].length()));
  }

  function _validateFreshness(INitroValidator.Ptrs memory _ptrs, uint256 _maxAge) private view {
    require(_ptrs.timestamp + _maxAge * 1000 >= block.timestamp * 1000, Errors.TEERegistration__StaleTEEAttestation());
  }

  function _validateUserData(
    bytes calldata _attestationTbs,
    INitroValidator.Ptrs memory _ptrs,
    UserDataBinding memory _binding
  ) private pure {
    if (_ptrs.userData.isNull() || _ptrs.userData.length() != 32) {
      revert Errors.TEERegistration__InvalidTEERegistrationUserData();
    }

    bytes32 expectedUserData = _userDataDigest(_binding);
    bytes memory actualUserDataBytes = sliceCalldata(_attestationTbs, _ptrs.userData.start(), 32);
    bytes32 actualUserData = bytes32(actualUserDataBytes);
    require(actualUserData == expectedUserData, Errors.TEERegistration__InvalidTEERegistrationUserData());
  }

  function _userDataDigest(UserDataBinding memory _binding) private pure returns (bytes32) {
    return sha256(
      abi.encodePacked(
        ATTESTATION_USER_DATA_DOMAIN, _binding.pubKeyX, _binding.pubKeyY, _binding.encPubKeyX, _binding.encPubKeyY
      )
    );
  }

  function sliceCalldata(bytes calldata _data, uint256 _start, uint256 _length) internal pure returns (bytes memory) {
    return _data[_start:_start + _length];
  }
}
