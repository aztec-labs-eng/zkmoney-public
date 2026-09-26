// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {AccountMetadataRegistry} from "./AccountMetadataRegistry.sol";
import {SIPABase} from "./SIPABase.sol";
import {SIPAFactory} from "./SIPAFactory.sol";
import {IOxideAccountFactory} from "./interfaces/IOxideAccountFactory.sol";
import {INameRegistry, DomainAuth} from "./interfaces/INameRegistry.sol";
import {INamePortal} from "./interfaces/INamePortal.sol";
import {IRegistrationController, SignedTerms, R1Install} from "./interfaces/IRegistrationController.sol";
import {IAccountMetadataController, MetadataUpdateIntent} from "./interfaces/IAccountMetadataController.sol";
import {OxideAccount} from "./OxideAccount.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Errors} from "@periphery/Errors.sol";

contract RegistrationController is IRegistrationController, IAccountMetadataController, EIP712 {
  bytes32 public constant METADATA_UPDATE_DOMAIN = keccak256("Oxide Metadata Update v1");
  bytes32 private constant SIGNED_TERMS_TYPEHASH = keccak256(
    "SignedTerms(bytes32 nameHash,address owner,uint256 fee,uint256 minDeposit,uint256 nonce,uint256 deadline)"
  );

  IEntryPoint public constant ENTRY_POINT = ERC4337Utils.ENTRYPOINT_V08;
  uint256 public constant R1_INSTALL_VERIFICATION_GAS = 50_000;
  uint256 public constant R1_INSTALL_CALL_GAS_BASE = 85_000;
  uint256 public constant R1_INSTALL_CALL_GAS_PER_WORD = 30_000;

  INameRegistry public immutable NAME_REGISTRY;
  address public immutable override SIPA_FACTORY;
  IOxideAccountFactory public immutable ACCOUNT_FACTORY;
  INamePortal public immutable NAME_PORTAL;
  IERC20 public immutable FEE_TOKEN;
  uint256 public immutable REGISTRATION_MIN;
  uint256 public immutable REGISTRATION_FEE;

  mapping(uint256 => address) public beneficiaries;
  uint256 public nextBeneficiaryId;
  mapping(address => bool) public isBeneficiary;

  mapping(uint256 => bool) public usedTermsNonces;

  event BeneficiaryAdded(uint256 indexed beneficiaryId, address indexed beneficiary);
  event TermsApplied(
    address indexed owner, bytes32 indexed nameHash, uint256 fee, uint256 minDeposit, uint256 nonce, uint256 deadline
  );

  constructor(
    INameRegistry nameRegistry,
    SIPAFactory sipaFactory,
    IOxideAccountFactory accountFactory,
    INamePortal namePortal,
    IERC20 feeToken,
    uint256 registrationMin,
    uint256 registrationFee,
    address initialBeneficiary
  ) EIP712("Oxide RegistrationController", "1") {
    require(address(nameRegistry) != address(0), Errors.RegistrationController__ZeroNameRegistry());
    require(address(sipaFactory) != address(0), Errors.RegistrationController__ZeroSIPAFactory());
    require(address(accountFactory) != address(0), Errors.RegistrationController__ZeroAccountFactory());
    require(address(namePortal) != address(0), Errors.RegistrationController__ZeroNamePortal());
    require(address(feeToken) != address(0), Errors.RegistrationController__ZeroFeeToken());
    NAME_REGISTRY = nameRegistry;
    SIPA_FACTORY = address(sipaFactory);
    ACCOUNT_FACTORY = accountFactory;
    NAME_PORTAL = namePortal;
    FEE_TOKEN = feeToken;
    REGISTRATION_MIN = registrationMin;
    REGISTRATION_FEE = registrationFee;
    _addBeneficiary(initialBeneficiary);
  }

  function addBeneficiary(address beneficiary) external returns (uint256 beneficiaryId) {
    require(msg.sender == NAME_REGISTRY.domainOwner(), Errors.RegistrationController__NotDomainOwner());
    beneficiaryId = _addBeneficiary(beneficiary);
  }

  function metadataUpdateDigest(bytes calldata intentData, address sipa) public view override returns (bytes32) {
    return
      keccak256(abi.encode(METADATA_UPDATE_DOMAIN, block.chainid, address(NAME_REGISTRY), sipa, keccak256(intentData)));
  }

  function metadataStateHash(address owner) public view virtual override returns (bytes32) {
    AccountMetadataRegistry registry = AccountMetadataRegistry(NAME_REGISTRY.accountMetadataRegistry());
    return registry.hasUserRecord(owner) ? keccak256(abi.encode(registry.getUserRecord(owner))) : bytes32(0);
  }

  function updateUser(bytes calldata intentData, bytes calldata signature) external override {
    require(
      SIPAFactory(SIPA_FACTORY).sipaIntentOf(msg.sender) == SIPABase.Intent.UpdateMetadata,
      Errors.RegistrationController__CallerNotSIPA(msg.sender)
    );
    SIPABase.Args memory args = abi.decode(Clones.fetchCloneArgs(msg.sender), (SIPABase.Args));
    require(!args.resweepable, Errors.MetadataUpdate__Resweepable());
    require(args.intentHash == keccak256(intentData), Errors.SIPA__IntentDataMismatch());
    MetadataUpdateIntent memory intent = abi.decode(intentData, (MetadataUpdateIntent));
    require(intent.metadataRegistry == NAME_REGISTRY.accountMetadataRegistry(), Errors.MetadataUpdate__WrongRegistry());
    require(NAME_REGISTRY.nameOf(intent.owner) != bytes32(0), Errors.NamePortal__NameNotFound(intent.owner));
    require(args.rollupVersion == intent.rollupVersion, Errors.SIPA__RollupVersionMismatch());
    require(
      intent.namePortalRecipient == bytes32(0)
        ? intent.namePortal == address(0)
        : intent.namePortal == address(NAME_PORTAL),
      Errors.MetadataUpdate__WrongNamePortal()
    );
    require(metadataStateHash(intent.owner) == intent.expectedStateHash, Errors.MetadataUpdate__StaleRecord());
    require(
      SignatureChecker.isValidERC1271SignatureNow(
        intent.owner, metadataUpdateDigest(intentData, msg.sender), signature
      ),
      Errors.MetadataUpdate__InvalidConsent()
    );
    _writeMetadata(intent);
    if (intent.namePortalRecipient != bytes32(0)) {
      NAME_PORTAL.notify(intent.owner, intent.namePortalRecipient, intent.rollupVersion);
    }
  }

  function _writeMetadata(MetadataUpdateIntent memory intent) internal virtual {
    AccountMetadataRegistry.UserRecord memory record = abi.decode(intent.metadata, (AccountMetadataRegistry.UserRecord));
    require(record.rollupVersion == intent.rollupVersion, Errors.SIPA__RollupVersionMismatch());
    AccountMetadataRegistry(intent.metadataRegistry).setUserRecord(intent.owner, record);
  }

  function _addBeneficiary(address beneficiary) internal returns (uint256 beneficiaryId) {
    require(beneficiary != address(0), Errors.RegistrationController__ZeroBeneficiary());
    beneficiaryId = nextBeneficiaryId++;
    beneficiaries[beneficiaryId] = beneficiary;
    isBeneficiary[beneficiary] = true;
    emit BeneficiaryAdded(beneficiaryId, beneficiary);
  }

  function register(address token, uint256 balance, bytes calldata registrationData, bytes calldata proofs)
    external
    override
  {
    _requireRegistrationSIPA(msg.sender, registrationData);

    require(token == address(FEE_TOKEN), Errors.RegistrationController__FeeTokenMismatch(token, address(FEE_TOKEN)));

    (bytes memory recordData, uint256 fee, address beneficiary,, bytes32 namePortalRecipient) =
      abi.decode(registrationData, (bytes, uint256, address, bytes32, bytes32));

    _register(
      RegisterArgs({
        recordData: recordData,
        fee: fee,
        beneficiary: beneficiary,
        namePortalRecipient: namePortalRecipient,
        balance: balance,
        relayerFee: SIPABase(msg.sender).depositFee()
      }),
      proofs
    );
  }

  struct RegisterArgs {
    bytes recordData;
    uint256 fee;
    address beneficiary;
    bytes32 namePortalRecipient;
    uint256 balance;
    uint256 relayerFee;
  }

  function _register(RegisterArgs memory a, bytes calldata proofs) internal {
    (
      bytes memory consentSig,
      address bootstrap,
      DomainAuth memory domainAuth,
      SignedTerms memory terms,
      R1Install memory r1
    ) = abi.decode(proofs, (bytes, address, DomainAuth, SignedTerms, R1Install));
    (address owner, bytes32 nameHash, AccountMetadataRegistry.UserRecord memory record) =
      abi.decode(a.recordData, (address, bytes32, AccountMetadataRegistry.UserRecord));

    _verifyConsent(a.recordData, consentSig, bootstrap, owner, msg.sender);

    _checkPayment(nameHash, owner, a, terms);

    NAME_REGISTRY.claimName(nameHash, owner, domainAuth);
    AccountMetadataRegistry(NAME_REGISTRY.accountMetadataRegistry()).setUserRecord(owner, record);

    if (a.namePortalRecipient != bytes32(0)) {
      NAME_PORTAL.notify(owner, a.namePortalRecipient, record.rollupVersion);
    }

    _installR1Key(owner, r1);
  }

  function _installR1Key(address owner, R1Install memory r1) internal {
    OxideAccount account = OxideAccount(payable(owner));
    if (account.authKeyCount() != 0) {
      return;
    }
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0] = _r1InstallUserOp(owner, r1);
    ENTRY_POINT.handleOps(ops, payable(owner));
    require(account.authKeyCount() != 0, Errors.RegistrationController__R1KeyNotInstalled());
  }

  function _r1InstallUserOp(address owner, R1Install memory r1) internal view returns (PackedUserOperation memory op) {
    op.sender = owner;
    op.nonce = ENTRY_POINT.getNonce(owner, 0);
    op.callData = abi.encodeCall(OxideAccount.addAuthKey, (OxideAccount.R1Key({qx: r1.qx, qy: r1.qy}), r1.metadata));
    op.accountGasLimits = bytes32((R1_INSTALL_VERIFICATION_GAS << 128) | _r1InstallCallGas(r1.metadata.length));
    op.signature = r1.signature;
  }

  function _r1InstallCallGas(uint256 metadataLength) internal pure returns (uint256) {
    uint256 words = (metadataLength + 31) / 32;
    if (metadataLength >= 32) {
      words += 1;
    }
    return R1_INSTALL_CALL_GAS_BASE + R1_INSTALL_CALL_GAS_PER_WORD * words;
  }

  function _verifyConsent(
    bytes memory recordData,
    bytes memory consentSig,
    address bootstrap,
    address owner,
    address sipa
  ) internal {
    address account = ACCOUNT_FACTORY.deploy(bootstrap);
    require(account == owner, Errors.RegistrationController__AccountMismatch(account, owner));
    bytes4 result = IERC1271(owner).isValidSignature(_consentDigest(recordData, sipa), consentSig);
    require(result == IERC1271.isValidSignature.selector, Errors.RegistrationController__InvalidConsent(owner));
  }

  function _checkPayment(bytes32 nameHash, address owner, RegisterArgs memory a, SignedTerms memory terms) internal {
    uint256 expectedFee;
    uint256 minDeposit;
    if (_consumeSignedTermsIfPresent(nameHash, owner, terms)) {
      expectedFee = terms.fee;
      minDeposit = terms.minDeposit;
    } else {
      expectedFee = REGISTRATION_FEE;
      minDeposit = REGISTRATION_MIN;
    }
    require(expectedFee >= a.relayerFee, Errors.RegistrationController__FeeBelowRelayerFee(expectedFee, a.relayerFee));
    require(a.fee == expectedFee, Errors.RegistrationController__FeeMismatch(a.fee, expectedFee));
    uint256 floor = minDeposit + a.fee;
    require(a.balance >= floor, Errors.RegistrationController__BalanceBelowFloor(a.balance, floor));
    if (a.fee > 0) {
      require(isBeneficiary[a.beneficiary], Errors.RegistrationController__BeneficiaryNotAllowlisted(a.beneficiary));
    }
  }

  function _consentDigest(bytes memory recordData, address sipa) internal view returns (bytes32) {
    return keccak256(abi.encode(recordData, block.chainid, NAME_REGISTRY.accountMetadataRegistry(), sipa));
  }

  function _requireRegistrationSIPA(address caller, bytes calldata registrationData) internal view {
    require(
      SIPAFactory(SIPA_FACTORY).sipaIntentOf(caller) == SIPABase.Intent.Registration,
      Errors.RegistrationController__CallerNotSIPA(caller)
    );

    SIPABase.Args memory args = abi.decode(Clones.fetchCloneArgs(caller), (SIPABase.Args));
    require(args.intentHash == keccak256(registrationData), Errors.RegistrationController__RegistrationDataMismatch());
  }

  function _consumeSignedTermsIfPresent(bytes32 nameHash, address owner, SignedTerms memory terms)
    internal
    returns (bool)
  {
    if (terms.signature.length == 0) return false;
    if (block.timestamp > terms.deadline) revert Errors.RegistrationController__TermsExpired();
    if (usedTermsNonces[terms.nonce]) revert Errors.RegistrationController__TermsNonceAlreadyUsed();

    bytes32 structHash = keccak256(
      abi.encode(SIGNED_TERMS_TYPEHASH, nameHash, owner, terms.fee, terms.minDeposit, terms.nonce, terms.deadline)
    );
    if (ECDSA.recover(_hashTypedDataV4(structHash), terms.signature) != NAME_REGISTRY.domainOwner()) {
      revert Errors.RegistrationController__InvalidTermsSignature();
    }

    usedTermsNonces[terms.nonce] = true;
    emit TermsApplied(owner, nameHash, terms.fee, terms.minDeposit, terms.nonce, terms.deadline);
    return true;
  }
}
