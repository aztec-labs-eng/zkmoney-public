// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {TeeRegistry} from "@core/TeeRegistry.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {INitroValidator, TEERegistrationLib} from "@core/lib/TEERegistrationLib.sol";
import {TestCertManager} from "@test/fixtures/TestCertManager.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Test, stdJson} from "forge-std/Test.sol";
import {MockInbox} from "@test/fixtures/MockInbox.sol";
import {MockRegistry} from "@test/fixtures/MockRegistry.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";
import {NitroValidator as OxideNitroValidator} from "@core/lib/NitroValidator.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Errors} from "@core/lib/Errors.sol";

interface ITestNitroValidator is INitroValidator {
  function decodeAttestationTbs(bytes memory attestation)
    external
    pure
    returns (bytes memory attestationTbs, bytes memory signature);

  function verifiedAttestationLeaf(bytes32 attestationTbsKeccak) external view returns (bytes32 leafCertHash);
}

contract TeeRegistryTest is Test {
  using stdJson for string;

  string internal constant LEAF_CERT_PATH = "test/fixtures/test_attestation/leaf.der";
  bytes32 internal constant L2_RECIPIENT = bytes32(uint256(0x4a12));
  uint256 internal constant ROLLUP_VERSION = 7;
  address internal constant USER = address(0xA11CE);
  bytes32 internal constant MSG_KEY = bytes32(uint256(0xAB));
  uint256 internal constant MSG_INDEX = 42;

  TeeRegistry internal registry;
  MockInbox internal inbox;
  MockRegistry internal rollupRegistry;
  ICertManager internal testCertManager;
  ITestNitroValidator internal nitroValidator;

  bytes32 internal teePubKeyX;
  bytes32 internal teePubKeyY;
  address internal teeEthAddress;
  bytes32 internal encPubKeyX;
  bytes32 internal encPubKeyY;
  bytes internal pcr0;
  bytes32 internal pcr0Hash;
  uint256 internal attestationTimestamp;
  uint256 internal cabundleCount;
  bytes32 internal rootCertHash;

  function setUp() public {
    string memory summary = vm.readFile("test/fixtures/test_attestation/summary.json");
    teePubKeyX = summary.readBytes32(".teePubKeyX");
    teePubKeyY = summary.readBytes32(".teePubKeyY");
    teeEthAddress = summary.readAddress(".teeEthAddress");
    encPubKeyX = summary.readBytes32(".encPubKeyX");
    encPubKeyY = summary.readBytes32(".encPubKeyY");
    pcr0 = summary.readBytes(".pcr0");
    pcr0Hash = keccak256(pcr0);
    attestationTimestamp = vm.parseUint(summary.readString(".timestampMillis")) / 1000;
    cabundleCount = summary.readUint(".cabundleCount");
    rootCertHash = summary.readBytes32(".rootCertHash");

    vm.warp(attestationTimestamp);

    string memory rootArgs = vm.readFile("test/fixtures/test_attestation/root_args.json");
    testCertManager = new TestCertManager(_readRootArgs(rootArgs));
    nitroValidator = ITestNitroValidator(address(new OxideNitroValidator(testCertManager)));

    inbox = new MockInbox();
    MockRollup rollup = new MockRollup();
    rollup.setInbox(IInbox(address(inbox)));
    rollupRegistry = new MockRegistry();
    rollupRegistry.setRollup(ROLLUP_VERSION, IHaveVersion(address(rollup)));

    registry = _newRegistry(testCertManager, nitroValidator, L2_RECIPIENT);
  }

  function test_GivenZeroCertManager_WhenDeployed_ThenReverts() external {
    vm.expectRevert(Errors.TeeRegistry__ZeroCertManager.selector);
    _newRegistry(ICertManager(address(0)), nitroValidator, L2_RECIPIENT);
  }

  function test_GivenZeroNitroValidator_WhenDeployed_ThenReverts() external {
    vm.expectRevert(Errors.TeeRegistry__ZeroNitroValidator.selector);
    _newRegistry(testCertManager, INitroValidator(address(0)), L2_RECIPIENT);
  }

  function test_GivenValidatorBuiltOnAnotherCertManager_WhenDeployed_ThenReverts() external {
    ICertManager otherCertManager =
      new TestCertManager(_readRootArgs(vm.readFile("test/fixtures/test_attestation/root_args.json")));

    vm.expectRevert(Errors.TeeRegistry__CertManagerMismatch.selector);
    _newRegistry(otherCertManager, nitroValidator, L2_RECIPIENT);
  }

  function test_GivenRollupWithoutInbox_WhenDeployed_ThenReverts() external {
    MockRegistry emptyRegistry = new MockRegistry();
    emptyRegistry.setRollup(ROLLUP_VERSION, IHaveVersion(address(new MockRollup())));
    rollupRegistry = emptyRegistry;

    vm.expectRevert(Errors.TeeRegistry__ZeroInbox.selector);
    _newRegistry(testCertManager, nitroValidator, L2_RECIPIENT);
  }

  function test_GivenZeroL2Recipient_WhenDeployed_ThenReverts() external {
    vm.expectRevert(Errors.TeeRegistry__ZeroL2Recipient.selector);
    _newRegistry(testCertManager, nitroValidator, bytes32(0));
  }

  function test_GivenPcr0Hash_WhenDeployed_ThenPcr0HashIsSet() external view {
    assertEq(registry.PCR0_HASH(), pcr0Hash);
  }

  function test_GivenZeroPcr0Hash_WhenDeployed_ThenReverts() external {
    vm.expectRevert(Errors.TEERegistration__ZeroTEEPcr0Hash.selector);
    _newRegistry(bytes32(0), testCertManager, nitroValidator, L2_RECIPIENT);
  }

  function test_GivenDebugModePcr0Hash_WhenDeployed_ThenReverts() external {
    vm.expectRevert(Errors.TEERegistration__DebugModeTEEPcr0Hash.selector);
    _newRegistry(keccak256(new bytes(48)), testCertManager, nitroValidator, L2_RECIPIENT);
  }

  function test_GivenCertSignedByTheRoot_WhenVerifyTeeCACertIsCalled_ThenCertIsVerified() external {
    bytes memory cert = vm.readFileBinary(_cabundlePath(0));

    vm.expectEmit(true, true, false, false, address(registry));
    emit TEERegistrationLib.TEECACertVerified(keccak256(cert), rootCertHash);

    assertEq(registry.verifyTeeCACert(cert, rootCertHash), keccak256(cert));
  }

  function test_GivenAllCabundleStaged_WhenVerifyTeeClientCertIsCalled_ThenCertIsVerified() external {
    bytes32 parentHash = _stageCabundle();
    bytes memory leaf = vm.readFileBinary(LEAF_CERT_PATH);

    vm.expectEmit(true, true, false, false, address(registry));
    emit TEERegistrationLib.TEEClientCertVerified(keccak256(leaf), parentHash);

    assertEq(registry.verifyTeeClientCert(leaf, parentHash), keccak256(leaf));
  }

  function test_GivenParentIsNotStaged_WhenVerifyTeeClientCertIsCalled_ThenReverts() external {
    bytes memory leaf = vm.readFileBinary(LEAF_CERT_PATH);
    bytes memory lastIntermediate = vm.readFileBinary(_cabundlePath(cabundleCount - 1));

    vm.expectRevert("parent cert unverified");
    registry.verifyTeeClientCert(leaf, keccak256(lastIntermediate));
  }

  function test_GivenLegitimateStaging_WhenVerifyTeeAttestationSigIsCalled_ThenTbsHashBindsToTheLeafCert() external {
    bytes32 leafCertHash = _stageLeaf(_stageCabundle());
    (bytes memory tbs, bytes memory signature) = _readAttestation();

    bytes32 tbsKeccak = registry.verifyTeeAttestationHash(tbs);
    registry.verifyTeeAttestationSig(tbsKeccak, signature, leafCertHash);

    assertEq(
      nitroValidator.verifiedAttestationLeaf(tbsKeccak), leafCertHash, "staging must bind tbs hash -> leaf cert hash"
    );
  }

  function test_GivenWrongSignature_WhenVerifyTeeAttestationSigIsCalled_ThenReverts() external {
    bytes32 leafCertHash = _stageLeaf(_stageCabundle());
    (bytes memory tbs, bytes memory signature) = _readAttestation();
    bytes32 tbsKeccak = registry.verifyTeeAttestationHash(tbs);

    vm.expectRevert("invalid sig");
    registry.verifyTeeAttestationSig(tbsKeccak, _corruptSignature(signature), leafCertHash);
  }

  function test_GivenCACertHash_WhenVerifyTeeAttestationSigIsCalled_ThenReverts() external {
    _stageCabundle();
    bytes32 caCertHash = keccak256(vm.readFileBinary(_cabundlePath(cabundleCount - 1)));
    (bytes memory tbs, bytes memory signature) = _readAttestation();
    bytes32 tbsKeccak = registry.verifyTeeAttestationHash(tbs);

    vm.expectRevert("expected client cert, not CA");
    registry.verifyTeeAttestationSig(tbsKeccak, signature, caCertHash);
  }

  function test_GivenTbsHashIsNotStaged_WhenVerifyTeeAttestationSigIsCalled_ThenReverts() external {
    bytes32 leafCertHash = _stageLeaf(_stageCabundle());
    (bytes memory tbs, bytes memory signature) = _readAttestation();
    bytes32 tbsKeccak = keccak256(tbs);

    vm.expectRevert("tbs hash not staged");
    registry.verifyTeeAttestationSig(tbsKeccak, signature, leafCertHash);
  }

  function test_GivenTheRegistrysPcr0_WhenRegisterTeeIsCalled_ThenTeeIsBoundAndMessageIsSent() external {
    assertFalse(registry.isTeeRegistered(teeEthAddress));

    _stageCabundle();
    (bytes memory tbs, bytes memory signature) = _readAttestation();
    inbox.primeNext(MSG_KEY, MSG_INDEX);

    vm.expectEmit(true, true, true, true, address(registry));
    emit TeeRegistry.TEEAdded(teeEthAddress, teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY, MSG_KEY, MSG_INDEX);

    vm.prank(USER);
    (bytes32 key, uint256 index) = registry.registerTee(tbs, signature, teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY);

    assertEq(key, MSG_KEY);
    assertEq(index, MSG_INDEX);
    assertTrue(registry.isTeeRegistered(teeEthAddress));
    assertFalse(registry.isTeeRegistered(address(0xB12)));
    (bytes32 boundPubKeyX, bytes32 boundPubKeyY, bytes32 boundEncPubKeyX, bytes32 boundEncPubKeyY) =
      registry.$teeKeys(teeEthAddress);
    assertEq(boundPubKeyX, teePubKeyX);
    assertEq(boundPubKeyY, teePubKeyY);
    assertEq(boundEncPubKeyX, encPubKeyX);
    assertEq(boundEncPubKeyY, encPubKeyY);
    (bytes32 messageKey, uint256 messageIndex) = registry.$registrationMessages(teeEthAddress);
    assertEq(messageKey, MSG_KEY);
    assertEq(messageIndex, MSG_INDEX);
    (bytes32 unregisteredKey, uint256 unregisteredIndex) = registry.$registrationMessages(address(0xB12));
    assertEq(unregisteredKey, bytes32(0));
    assertEq(unregisteredIndex, 0);
    _assertLastMessage(
      Hash.sha256ToField(abi.encodeWithSignature("register_signer(bytes32,bytes32)", teePubKeyX, teePubKeyY))
    );
  }

  function test_GivenFullyStagedAttestation_WhenRegisterTeeIsCalled_ThenTeeIsRegistered() external {
    assertFalse(registry.isTeeRegistered(teeEthAddress));

    bytes32 leafParentHash = _stageCabundle();
    bytes32 leafCertHash = _stageLeaf(leafParentHash);
    _stageAttestation(leafCertHash);

    (bytes memory tbs, bytes memory signature) = _readAttestation();
    uint256 gasBefore = gasleft();
    registry.registerTee(tbs, signature, teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY);
    uint256 gasUsed = gasBefore - gasleft();

    if (!vm.envOr("FORGE_COVERAGE", false)) {
      assertLt(gasUsed, 10_000_000, "registerTee gas regressed past 10M with full staging");
    }

    assertTrue(registry.isTeeRegistered(teeEthAddress));
  }

  function test_GivenCabundleIsNotStaged_WhenRegisterTeeIsCalled_ThenTeeIsRegistered() external {
    assertFalse(registry.isTeeRegistered(teeEthAddress));

    (bytes memory tbs, bytes memory signature) = _readAttestation();
    registry.registerTee(tbs, signature, teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY);

    assertTrue(registry.isTeeRegistered(teeEthAddress));
    (bytes32 boundPubKeyX,,,) = registry.$teeKeys(teeEthAddress);
    assertEq(boundPubKeyX, teePubKeyX);
  }

  function test_GivenPcr0IsNotTheRegistrys_WhenRegisterTeeIsCalled_ThenReverts() external {
    registry = _newRegistry(keccak256("some-other-measurement"), testCertManager, nitroValidator, L2_RECIPIENT);
    _stageCabundle();
    (bytes memory tbs, bytes memory signature) = _readAttestation();

    vm.expectRevert(abi.encodeWithSelector(Errors.TEERegistration__UnapprovedTEEPcr0.selector, pcr0Hash));
    registry.registerTee(tbs, signature, teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY);
  }

  function test_GivenAttestationIsStale_WhenRegisterTeeIsCalled_ThenReverts() external {
    _stageCabundle();

    vm.warp(attestationTimestamp + registry.TEE_ATTESTATION_MAX_AGE() + 1);

    (bytes memory tbs, bytes memory signature) = _readAttestation();
    vm.expectRevert(Errors.TEERegistration__StaleTEEAttestation.selector);
    registry.registerTee(tbs, signature, teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY);
  }

  function test_GivenTeeIsAlreadyRegistered_WhenRegisterTeeIsCalled_ThenReverts() external {
    _stageCabundle();
    (bytes memory tbs, bytes memory signature) = _readAttestation();
    registry.registerTee(tbs, signature, teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY);

    vm.expectRevert(Errors.TEERegistration__AlreadyRegistered.selector);
    registry.registerTee(tbs, signature, teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY);
  }

  function test_GivenTamperedPubKey_WhenRegisterTeeIsCalled_ThenReverts() external {
    _stageCabundle();
    (bytes memory tbs, bytes memory signature) = _readAttestation();

    vm.expectRevert(Errors.TEERegistration__OffCurveTEEPubKey.selector);
    registry.registerTee(tbs, signature, bytes32(uint256(teePubKeyX) ^ 1), teePubKeyY, encPubKeyX, encPubKeyY);
  }

  function test_GivenWrongOnCurvePubKey_WhenRegisterTeeIsCalled_ThenReverts() external {
    bytes32 generatorX = bytes32(0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798);
    bytes32 generatorY = bytes32(0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8);

    _stageCabundle();
    (bytes memory tbs, bytes memory signature) = _readAttestation();

    vm.expectRevert(Errors.TEERegistration__InvalidTEERegistrationUserData.selector);
    registry.registerTee(tbs, signature, generatorX, generatorY, encPubKeyX, encPubKeyY);
  }

  function test_GivenCorruptedLeafBinding_WhenRegisterTeeIsCalled_ThenFallsBackToTheInlineCheck() external {
    bytes32 leafCertHash = _stageLeaf(_stageCabundle());
    _stageAttestation(leafCertHash);

    (bytes memory tbs, bytes memory signature) = _readAttestation();
    bytes32 tbsKeccak = keccak256(tbs);

    assertEq(nitroValidator.verifiedAttestationLeaf(tbsKeccak), leafCertHash);

    bytes32 wrongLeafHash = keccak256("not-the-embedded-leaf");
    vm.store(address(nitroValidator), keccak256(abi.encode(tbsKeccak, uint256(1))), wrongLeafHash);
    assertEq(nitroValidator.verifiedAttestationLeaf(tbsKeccak), wrongLeafHash);

    vm.expectRevert("invalid sig");
    registry.registerTee(tbs, _corruptSignature(signature), teePubKeyX, teePubKeyY, encPubKeyX, encPubKeyY);
  }

  function _newRegistry(ICertManager _certManager, INitroValidator _validator, bytes32 _l2Recipient)
    internal
    returns (TeeRegistry)
  {
    return _newRegistry(pcr0Hash, _certManager, _validator, _l2Recipient);
  }

  function _newRegistry(bytes32 _pcr0Hash, ICertManager _certManager, INitroValidator _validator, bytes32 _l2Recipient)
    internal
    returns (TeeRegistry)
  {
    return new TeeRegistry(
      _pcr0Hash, _certManager, _validator, IRegistry(address(rollupRegistry)), ROLLUP_VERSION, _l2Recipient
    );
  }

  function _stageCabundle() internal returns (bytes32 parentHash) {
    parentHash = rootCertHash;
    for (uint256 i = 0; i < cabundleCount; i++) {
      parentHash = registry.verifyTeeCACert(vm.readFileBinary(_cabundlePath(i)), parentHash);
    }
  }

  function _stageLeaf(bytes32 _parentHash) internal returns (bytes32 leafCertHash) {
    bytes memory leaf = vm.readFileBinary(LEAF_CERT_PATH);
    registry.verifyTeeClientCert(leaf, _parentHash);
    leafCertHash = keccak256(leaf);
  }

  function _stageAttestation(bytes32 _leafCertHash) internal {
    (bytes memory tbs, bytes memory signature) = _readAttestation();
    bytes32 tbsKeccak = registry.verifyTeeAttestationHash(tbs);
    registry.verifyTeeAttestationSig(tbsKeccak, signature, _leafCertHash);
  }

  function _corruptSignature(bytes memory _signature) internal pure returns (bytes memory corrupted) {
    corrupted = abi.encodePacked(_signature);
    corrupted[0] = bytes1(uint8(corrupted[0]) ^ 0x01);
  }

  function _cabundlePath(uint256 _i) internal view returns (string memory) {
    string memory padded = _i < 10 ? string.concat("0", vm.toString(_i)) : vm.toString(_i);
    return string.concat("test/fixtures/test_attestation/cabundle/", padded, ".der");
  }

  function _readAttestation() internal view returns (bytes memory tbs, bytes memory signature) {
    bytes memory attestation = vm.readFileBinary("test/fixtures/test_attestation/attestation.cose");
    return nitroValidator.decodeAttestationTbs(attestation);
  }

  function _readRootArgs(string memory _json) internal view returns (TestCertManager.RootCaConstants memory r) {
    r.certHash = _json.readBytes32(".certHash");
    r.notAfter = uint64(vm.parseUint(_json.readString(".notAfter")));
    int256 mpl = vm.parseInt(_json.readString(".maxPathLen"));
    r.maxPathLen = int64(mpl);
    r.subjectHash = _json.readBytes32(".subjectHash");
    r.pubKey = _json.readBytes(".pubKey");
  }

  function _assertLastMessage(bytes32 _contentHash) internal view {
    (bytes32 actor, uint256 version, bytes32 contentHash, bytes32 secretHash) = inbox.calls(inbox.callCount() - 1);
    assertEq(actor, L2_RECIPIENT);
    assertEq(version, ROLLUP_VERSION);
    assertEq(contentHash, _contentHash);
    assertEq(secretHash, OxideConstants.PORTAL_CONSTANT_SECRET_HASH);
  }
}
