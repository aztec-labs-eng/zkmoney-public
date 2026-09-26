// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {SignedTerms, R1Install} from "@periphery/interfaces/IRegistrationController.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {IOxideAccountFactory} from "@periphery/interfaces/IOxideAccountFactory.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";

abstract contract RegistrationTestBase is OxidePortalBase {
  uint256 internal constant G_X = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
  uint256 internal constant G_Y = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;

  bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
  bytes32 internal constant NAME_CLAIM_TYPEHASH =
    keccak256("NameClaim(bytes32 nameHash,address userAddress,uint256 nonce,uint256 deadline)");
  bytes32 internal constant SIGNED_TERMS_TYPEHASH = keccak256(
    "SignedTerms(bytes32 nameHash,address owner,uint256 fee,uint256 minDeposit,uint256 nonce,uint256 deadline)"
  );

  uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

  bytes32 internal constant NAME_HASH = keccak256("namehash(alice.oxide.eth)");
  bytes32 internal constant L2_ADDRESS = bytes32(uint256(0xA11CE12));
  bytes32 internal constant RECIPIENT_COMMITMENT =
    bytes32(uint256(keccak256("recipientCommitment")) % Constants.MAX_FIELD_VALUE);
  bytes32 internal constant NAME_PORTAL_RECIPIENT =
    bytes32(uint256(keccak256("namePortalRecipient")) % Constants.MAX_FIELD_VALUE);

  address internal relayer = makeAddr("relayer");
  address internal resolverOperatorAddr = makeAddr("resolverOperator");
  bytes32 internal regRecovery = _recoveryCommitment("recovery");

  address internal regDomainOwner;
  uint256 internal regDomainOwnerKey;

  address internal bootstrap;
  uint256 internal bootstrapKey;
  address internal defaultOwner;

  EntryPoint internal entryPoint;
  uint256 internal r1PrivateKey;
  OxideAccount.R1Key internal r1Key;
  R1Install internal defaultR1Install;

  uint256 internal nextNonce = 1;

  function setUp() public virtual override {
    super.setUp();
    _initialize();

    (regDomainOwner, regDomainOwnerKey) = makeAddrAndKey("regDomainOwner");
    vm.prank(OWNER);
    nameRegistry.updateDomainOwner(regDomainOwner);

    (bootstrap, bootstrapKey) = makeAddrAndKey("bootstrap");
    defaultOwner = accountFactory.predictAccountAddress(bootstrap);

    entryPoint = EntryPoint(payable(address(ERC4337Utils.ENTRYPOINT_V08)));
    vm.etch(address(entryPoint), address(new EntryPoint()).code);
    r1PrivateKey = uint256(keccak256("r1")) % P256_N;
    r1Key = _r1KeyOf(r1PrivateKey);
    defaultR1Install = _r1Install(bootstrapKey, defaultOwner);
  }

  function _r1KeyOf(uint256 _privateKey) internal pure returns (OxideAccount.R1Key memory key) {
    (uint256 x, uint256 y) = vm.publicKeyP256(_privateKey);
    key.qx = bytes32(x);
    key.qy = bytes32(y);
  }

  function _r1Install(uint256 _bootstrapKey, address owner) internal view returns (R1Install memory) {
    return _r1InstallWith(_bootstrapKey, owner, r1Key, "");
  }

  function _r1InstallWith(uint256 _bootstrapKey, address owner, OxideAccount.R1Key memory key, bytes memory metadata)
    internal
    view
    returns (R1Install memory r1)
  {
    r1.qx = key.qx;
    r1.qy = key.qy;
    r1.metadata = metadata;
    uint256 callGas = _r1InstallCallGas(metadata.length);
    PackedUserOperation memory op;
    op.sender = owner;
    op.nonce = entryPoint.getNonce(owner, 0);
    op.callData = abi.encodeCall(OxideAccount.addAuthKey, (key, metadata));
    op.accountGasLimits = bytes32((registrationController.R1_INSTALL_VERIFICATION_GAS() << 128) | callGas);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(_bootstrapKey, entryPoint.getUserOpHash(op));
    r1.signature = abi.encodePacked(r, s, v);
  }

  function _r1InstallCallGas(uint256 metadataLength) internal view returns (uint256) {
    uint256 words = (metadataLength + 31) / 32;
    if (metadataLength >= 32) {
      words += 1;
    }
    return
      registrationController.R1_INSTALL_CALL_GAS_BASE() + registrationController.R1_INSTALL_CALL_GAS_PER_WORD() * words;
  }

  function _deployAccountFactory() internal virtual override returns (IOxideAccountFactory) {
    return new OxideAccountFactory();
  }

  function _ownerOf(uint256 _bootstrapKey) internal view returns (address) {
    return accountFactory.predictAccountAddress(vm.addr(_bootstrapKey));
  }

  function _record(
    AccountMetadataRegistry.K1Point memory publicKey,
    bytes32 l2Address,
    address resolverOperator,
    uint256 rollupVersion
  ) internal pure returns (AccountMetadataRegistry.UserRecord memory) {
    return AccountMetadataRegistry.UserRecord({
      l2Address: l2Address, rollupVersion: rollupVersion, publicKey: publicKey, resolverOperator: resolverOperator
    });
  }

  function _recordData(bytes32 nameHash, address owner) internal view returns (bytes memory) {
    return abi.encode(
      owner,
      nameHash,
      _record(AccountMetadataRegistry.K1Point(G_X, G_Y), L2_ADDRESS, resolverOperatorAddr, ROLLUP_VERSION)
    );
  }

  function _registrationData(bytes32 nameHash, address owner) internal view returns (bytes memory) {
    return _registrationDataFor(REGISTRATION_FEE, FEE_BENEFICIARY, nameHash, owner);
  }

  function _registrationDataFor(uint256 fee, address beneficiary, bytes32 nameHash, address owner)
    internal
    view
    returns (bytes memory)
  {
    return abi.encode(_recordData(nameHash, owner), fee, beneficiary, RECIPIENT_COMMITMENT, NAME_PORTAL_RECIPIENT);
  }

  function _registrationDataRouted(
    bytes32 nameHash,
    address owner,
    uint256 fee,
    address beneficiary,
    bytes32 recipientCommitment,
    bytes32 namePortalRecipient
  ) internal view returns (bytes memory) {
    return abi.encode(_recordData(nameHash, owner), fee, beneficiary, recipientCommitment, namePortalRecipient);
  }

  function _registrationDataFull(
    bytes32 nameHash,
    address owner,
    AccountMetadataRegistry.K1Point memory publicKey,
    bytes32 l2Address,
    address resolverOperator,
    uint256 rollupVersion,
    uint256 fee,
    address beneficiary,
    bytes32 namePortalRecipient
  ) internal pure returns (bytes memory) {
    bytes memory recordData = abi.encode(
      owner, nameHash, _record(publicKey, l2Address, resolverOperator, rollupVersion)
    );
    return abi.encode(recordData, fee, beneficiary, RECIPIENT_COMMITMENT, namePortalRecipient);
  }

  function _consentSig(uint256 _bootstrapKey, bytes memory registrationData) internal view returns (bytes memory) {
    return _consentSigAt(_bootstrapKey, registrationData, _predictRegistrationSIPA(registrationData));
  }

  function _consentSigAt(uint256 _bootstrapKey, bytes memory registrationData, address sipa)
    internal
    view
    returns (bytes memory)
  {
    return _consentSigFor(_bootstrapKey, registrationData, nameRegistry.accountMetadataRegistry(), sipa);
  }

  function _consentSigFor(uint256 _bootstrapKey, bytes memory registrationData, address boundRegistry, address sipa)
    internal
    view
    returns (bytes memory)
  {
    (address owner, bytes32 digest) = _consentDigest(registrationData, boundRegistry, sipa);
    return AccountSignatures.k1(_bootstrapKey, AccountSignatures.personalSignDigest(owner, digest));
  }

  function _r1ConsentSig(uint256 keyIndex, uint256 _r1PrivateKey, bytes memory registrationData)
    internal
    view
    returns (bytes memory)
  {
    (address owner, bytes32 digest) = _consentDigest(
      registrationData, nameRegistry.accountMetadataRegistry(), _predictRegistrationSIPA(registrationData)
    );
    return AccountSignatures.r1(keyIndex, _r1PrivateKey, AccountSignatures.personalSignDigest(owner, digest));
  }

  function _bareConsentSig(uint256 _bootstrapKey, bytes memory registrationData) internal view returns (bytes memory) {
    (, bytes32 digest) = _consentDigest(
      registrationData, nameRegistry.accountMetadataRegistry(), _predictRegistrationSIPA(registrationData)
    );
    return AccountSignatures.k1(_bootstrapKey, digest);
  }

  function _consentDigest(bytes memory registrationData, address boundRegistry, address sipa)
    internal
    view
    returns (address owner, bytes32 digest)
  {
    bytes memory recordData = abi.decode(registrationData, (bytes));
    owner = abi.decode(recordData, (address));
    digest = keccak256(abi.encode(recordData, block.chainid, boundRegistry, sipa));
  }

  function _domainSeparator() internal view returns (bytes32) {
    return keccak256(
      abi.encode(
        EIP712_DOMAIN_TYPEHASH,
        keccak256(bytes("Oxide NameRegistry")),
        keccak256(bytes("1")),
        block.chainid,
        address(nameRegistry)
      )
    );
  }

  function _termsDomainSeparator() internal view returns (bytes32) {
    return keccak256(
      abi.encode(
        EIP712_DOMAIN_TYPEHASH,
        keccak256(bytes("Oxide RegistrationController")),
        keccak256(bytes("1")),
        block.chainid,
        address(registrationController)
      )
    );
  }

  function _domainAuth(bytes32 nameHash, address owner, uint256 nonce, uint256 deadline)
    internal
    view
    returns (DomainAuth memory)
  {
    return _domainAuthSignedBy(regDomainOwnerKey, nameHash, owner, nonce, deadline);
  }

  function _domainAuthSignedBy(uint256 signerKey, bytes32 nameHash, address owner, uint256 nonce, uint256 deadline)
    internal
    view
    returns (DomainAuth memory)
  {
    bytes32 structHash = keccak256(abi.encode(NAME_CLAIM_TYPEHASH, nameHash, owner, nonce, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
    return DomainAuth({nonce: nonce, deadline: deadline, signature: abi.encodePacked(r, s, v)});
  }

  function _signedTerms(
    bytes32 nameHash,
    address owner,
    uint256 fee,
    uint256 minDeposit,
    uint256 nonce,
    uint256 deadline
  ) internal view returns (SignedTerms memory) {
    return _signedTermsSignedBy(regDomainOwnerKey, nameHash, owner, fee, minDeposit, nonce, deadline);
  }

  function _signedTermsSignedBy(
    uint256 signerKey,
    bytes32 nameHash,
    address owner,
    uint256 fee,
    uint256 minDeposit,
    uint256 nonce,
    uint256 deadline
  ) internal view returns (SignedTerms memory) {
    bytes32 structHash = keccak256(abi.encode(SIGNED_TERMS_TYPEHASH, nameHash, owner, fee, minDeposit, nonce, deadline));
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _termsDomainSeparator(), structHash));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
    return SignedTerms({
      fee: fee, minDeposit: minDeposit, nonce: nonce, deadline: deadline, signature: abi.encodePacked(r, s, v)
    });
  }

  function _noTerms() internal pure returns (SignedTerms memory t) {
    t.signature = "";
  }

  function _deployController(uint256 registrationMin, uint256 registrationFee, address initialBeneficiary)
    internal
    returns (RegistrationController)
  {
    return new RegistrationController(
      INameRegistry(address(nameRegistry)),
      sipaFactory,
      accountFactory,
      namePortal,
      IERC20(address(underlying)),
      registrationMin,
      registrationFee,
      initialBeneficiary
    );
  }

  function _setController(address controller) internal {
    vm.prank(OWNER);
    nameRegistry.updateRegistrationController(controller);
  }

  function _deployRegistrationSIPA(bytes memory registrationData) internal returns (SIPABase) {
    return SIPABase(
      sipaFactory.deploySIPA(
        address(registrationSIPAImplementation), keccak256(registrationData), regRecovery, ROLLUP_VERSION, true
      )
    );
  }

  function _predictRegistrationSIPA(bytes memory registrationData) internal view returns (address) {
    return sipaFactory.predictSIPA(
      address(registrationSIPAImplementation), keccak256(registrationData), regRecovery, ROLLUP_VERSION, true
    );
  }

  function _deployAndFund(bytes memory registrationData, uint256 amount) internal returns (SIPABase sipa) {
    sipa = _deployRegistrationSIPA(registrationData);
    underlying.mint(address(sipa), amount);
  }

  function _regProofs(bytes memory consentSig, DomainAuth memory domainAuth, SignedTerms memory signedTerms)
    internal
    view
    returns (bytes memory)
  {
    return _regProofs(bootstrap, consentSig, domainAuth, signedTerms, defaultR1Install);
  }

  function _regProofs(
    bytes memory consentSig,
    DomainAuth memory domainAuth,
    SignedTerms memory signedTerms,
    R1Install memory r1Install
  ) internal view returns (bytes memory) {
    return _regProofs(bootstrap, consentSig, domainAuth, signedTerms, r1Install);
  }

  function _regProofs(
    address _bootstrap,
    bytes memory consentSig,
    DomainAuth memory domainAuth,
    SignedTerms memory signedTerms,
    R1Install memory r1Install
  ) internal pure returns (bytes memory) {
    return abi.encode(consentSig, _bootstrap, domainAuth, signedTerms, r1Install);
  }

  function _sweepRegistration(
    SIPABase sipa,
    bytes memory registrationData,
    bytes memory consentSig,
    DomainAuth memory domainAuth,
    SignedTerms memory signedTerms
  ) internal {
    _sweepRegistration(sipa, registrationData, consentSig, domainAuth, signedTerms, defaultR1Install);
  }

  function _sweepRegistration(
    SIPABase sipa,
    bytes memory registrationData,
    bytes memory consentSig,
    DomainAuth memory domainAuth,
    SignedTerms memory signedTerms,
    R1Install memory r1Install
  ) internal {
    sipa.sweep(
      address(underlying), relayer, registrationData, _regProofs(consentSig, domainAuth, signedTerms, r1Install)
    );
  }
}
