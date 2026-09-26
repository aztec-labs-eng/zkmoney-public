// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox, MAX_CHECKPOINTS_PER_EPOCH} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {MerkleLib} from "@aztec/core/libraries/crypto/MerkleLib.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@oz/utils/cryptography/ECDSA.sol";
import {Caps} from "./Caps.sol";
import {IOxidePortal} from "./interfaces/IOxidePortal.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {ProverClaimLib} from "./lib/ProverClaimLib.sol";
import {IProverSubsidy} from "@core/interfaces/IProverSubsidy.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {INitroValidator, TEERegistrationLib} from "./lib/TEERegistrationLib.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortal is Caps, Ownable, ReentrancyGuardTransient, IOxidePortal {
  using SafeERC20 for IERC20;

  uint256 public constant TEE_ATTESTATION_MAX_AGE = 1 hours;

  IERC20 public immutable UNDERLYING;

  IInbox public immutable INBOX;
  IOutbox public immutable OUTBOX;
  IRollup public immutable ROLLUP;
  IRegistry public immutable REGISTRY;

  IVerifier public immutable FROZEN_NOTES_REFUND_VERIFIER;
  IVerifier public immutable FROZEN_DEPOSIT_REFUND_VERIFIER;
  IVerifier public immutable UNPROCESSED_DEPOSIT_REFUND_VERIFIER;

  ICertManager public immutable TEE_CERT_MANAGER;
  INitroValidator public immutable TEE_NITRO_VALIDATOR;
  uint256 public immutable ROLLUP_VERSION;

  address public immutable FPC_FUNDER;

  uint256 public immutable FPC_FUNDING_CUT;

  mapping(address tee => TEERegistrationLib.TEEBinding binding) public $teeBindings;

  mapping(bytes32 pcr0Hash => bool approved) public $approvedTeePcr0;

  bytes32 public $l2Portal;

  bool public $initialized;

  mapping(bytes32 withdrawalId => bool spent) public $isWithdrawalSpent;

  mapping(bytes32 withdrawalId => bool spent) public $isWithdrawalProverClaimSpent;

  mapping(uint256 epoch => mapping(uint256 leafId => bool claimed)) public $claimed;
  mapping(uint256 checkpointNumber => address prover) public $firstProver;

  mapping(bytes32 nullifier => bool spent) public $isRefundNullifierSpent;

  bool public override $frozen;
  uint256 public $freezeCheckpointNumber;
  uint256 public $freezeEpochNumber;
  bytes32 public $freezeArchive;

  uint256 public $freezeCheckpointCount;

  event Initialized(bytes32 l2Portal);

  event Frozen(
    uint256 indexed checkpointNumber, uint256 indexed epochNumber, bytes32 archive, uint256 freezeCheckpointCount
  );

  event Deposit(bytes32 indexed recipientCommitment, uint256 amount, bytes32 key, uint256 index);

  event WithdrawalOrRefund(
    IExecutor.Flow indexed flow, bytes32 indexed nullifier, address indexed executor, uint256 executionAmount
  );

  event TipReleased(address indexed to, uint256 amount);
  event FirstProverRecorded(uint256 indexed checkpointNumber, address indexed prover);

  struct RefundVerifiers {
    IVerifier frozenNotes;
    IVerifier frozenDeposit;
    IVerifier unprocessedDeposit;
  }

  struct FpcFunding {
    address funder;
    uint256 cut;
  }

  constructor(
    address _owner,
    FpcFunding memory _fpcFunding,
    ICertManager _certManager,
    INitroValidator _nitroValidator,
    IERC20 _underlying,
    IRegistry _registry,
    uint256 _rollupVersion,
    RefundVerifiers memory _verifiers,
    uint256 _rate,
    uint256 _globalLimit
  ) Caps(_rate, _globalLimit) Ownable(_owner) {
    FPC_FUNDER = _fpcFunding.funder;
    FPC_FUNDING_CUT = _fpcFunding.cut;
    TEE_CERT_MANAGER = _certManager;
    TEE_NITRO_VALIDATOR = _nitroValidator;
    UNDERLYING = _underlying;
    REGISTRY = _registry;
    ROLLUP_VERSION = _rollupVersion;
    IRollup rollup = IRollup(address(_registry.getRollup(_rollupVersion)));
    ROLLUP = rollup;
    INBOX = rollup.getInbox();
    OUTBOX = rollup.getOutbox();
    FROZEN_NOTES_REFUND_VERIFIER = _verifiers.frozenNotes;
    FROZEN_DEPOSIT_REFUND_VERIFIER = _verifiers.frozenDeposit;
    UNPROCESSED_DEPOSIT_REFUND_VERIFIER = _verifiers.unprocessedDeposit;
  }

  function approveTeePcr0(bytes32 _pcr0Hash) external override(IOxidePortal) onlyOwner {
    TEERegistrationLib.approvePcr0($approvedTeePcr0, _pcr0Hash);
  }

  function verifyTeeCACert(bytes calldata _cert, bytes32 _parentCertHash)
    external
    override(IOxidePortal)
    returns (bytes32 certHash)
  {
    return TEERegistrationLib.verifyCACert(TEE_CERT_MANAGER, _cert, _parentCertHash);
  }

  function verifyTeeClientCert(bytes calldata _cert, bytes32 _parentCertHash)
    external
    override(IOxidePortal)
    returns (bytes32 certHash)
  {
    return TEERegistrationLib.verifyClientCert(TEE_CERT_MANAGER, _cert, _parentCertHash);
  }

  function verifyTeeAttestationHash(bytes calldata _attestationTbs)
    external
    override(IOxidePortal)
    returns (bytes32 attestationTbsKeccak)
  {
    return TEERegistrationLib.verifyAttestationHash(TEE_NITRO_VALIDATOR, _attestationTbs);
  }

  function verifyTeeAttestationSig(bytes32 _attestationTbsKeccak, bytes calldata _signature, bytes32 _leafCertHash)
    external
    override(IOxidePortal)
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
  ) external override(IOxidePortal) returns (bytes32 key, uint256 index) {
    require($initialized, Errors.OxidePortal__Uninitialized());
    TEERegistrationLib.TEEKeys memory keys = TEERegistrationLib.TEEKeys({
      pubKeyX: _teePubKeyX, pubKeyY: _teePubKeyY, encPubKeyX: _encPubKeyX, encPubKeyY: _encPubKeyY
    });
    (, key, index) = TEERegistrationLib.registerTee(
      _attestationTbs, _signature, $approvedTeePcr0, $teeBindings, _portalContext(), keys
    );
  }

  function _portalContext() internal view returns (TEERegistrationLib.RegistrationContext memory) {
    return TEERegistrationLib.RegistrationContext({
      validator: TEE_NITRO_VALIDATOR,
      inbox: INBOX,
      l2Recipient: $l2Portal,
      rollupVersion: ROLLUP_VERSION,
      constantSecretHash: OxideConstants.PORTAL_CONSTANT_SECRET_HASH,
      maxAttestationAge: TEE_ATTESTATION_MAX_AGE
    });
  }

  function initialize(bytes32 _l2Portal) external override(IOxidePortal) onlyOwner {
    require(!$initialized, Errors.OxidePortal__AlreadyInitialized());
    require(_l2Portal != bytes32(0), Errors.OxidePortal__ZeroL2Portal());
    $l2Portal = _l2Portal;
    $initialized = true;
    emit Initialized(_l2Portal);
  }

  function L2_PORTAL() external view returns (bytes32) {
    return $l2Portal;
  }

  function deposit(bytes32 _recipientCommitment, uint256 _amount)
    external
    override(IOxidePortal)
    returns (bytes32 key, uint256 index, uint256 creditedAmount)
  {
    require($initialized, Errors.OxidePortal__Uninitialized());
    require(!$frozen, Errors.OxidePortal__FrozenPortal());
    require(_recipientCommitment != bytes32(0), Errors.OxidePortal__ZeroRecipientCommitment());
    require(_amount > FPC_FUNDING_CUT, Errors.OxidePortal__AmountNotAboveFpcFundingCut());
    require(_amount <= type(uint128).max, Errors.OxidePortal__AmountTooLarge());
    creditedAmount = _amount - FPC_FUNDING_CUT;
    _markUsage(creditedAmount);

    bytes32 contentHash = Hash.sha256ToField(abi.encodeWithSignature("deposit(uint256)", creditedAmount));

    UNDERLYING.safeTransferFrom(msg.sender, address(this), _amount);
    if (FPC_FUNDING_CUT > 0) {
      UNDERLYING.safeTransfer(FPC_FUNDER, FPC_FUNDING_CUT);
    }

    (key, index) = INBOX.sendL2Message(
      DataStructures.L2Actor({actor: $l2Portal, version: ROLLUP_VERSION}), contentHash, _recipientCommitment
    );

    emit Deposit(_recipientCommitment, creditedAmount, key, index);
  }

  function withdraw(IOxidePortal.WithdrawArgs calldata _args) external override(IOxidePortal) nonReentrant {
    require($initialized, Errors.OxidePortal__Uninitialized());
    require(_args.content.executor.code.length > 0, Errors.OxidePortal__InvalidWithdrawalExecutor());
    // solhint-disable-next-line oxide/no-comments
    // Assert that the userPayload provided via calldata corresponds to the one committed in the withdrawal message.
    require(
      Hash.sha256ToField(_args.userPayload) == _args.content.userPayloadHash, Errors.OxidePortal__InvalidUserPayload()
    );
    require(_args.content.proverTip <= _args.content.amount, Errors.OxidePortal__ProverTipExceedsAmount());
    _enforceFreezeGate(_args.checkpointNumber, _args.epochNumber, _args.numCheckpointsInEpoch);
    require(!$isWithdrawalSpent[_args.withdrawalId], Errors.OxidePortal__WithdrawalAlreadyClaimed());
    $isWithdrawalSpent[_args.withdrawalId] = true;
    _enforceTxCap(_args.content.amount);

    DataStructures.L2ToL1Msg memory message = _buildWithdrawalMessage(_args.content);

    bytes32 archiveRoot = ROLLUP.archiveAt(_args.checkpointNumber);
    require(archiveRoot != bytes32(0), Errors.OxidePortal__UnknownCheckpoint());

    require(_args.checkpointNumber <= ROLLUP.getProvenCheckpointNumber(), Errors.OxidePortal__UnprovenCheckpoint());

    bytes32 messageHash = Hash.sha256ToField(message);
    _validateWithdrawalTeeSignature(archiveRoot, _args.withdrawalId, messageHash, _args.teeSignature);

    OUTBOX.consume(message, Epoch.wrap(_args.epochNumber), _args.numCheckpointsInEpoch, _args.leafIndex, _args.path);

    uint256 netAfterProverTip = _args.content.amount - _args.content.proverTip;
    uint256 fpcCut = _fpcFundingCutOn(netAfterProverTip);
    uint256 executionAmount = netAfterProverTip - fpcCut;
    if (fpcCut > 0) {
      UNDERLYING.safeTransfer(FPC_FUNDER, fpcCut);
    }
    UNDERLYING.safeTransfer(_args.content.executor, executionAmount);
    IExecutor(_args.content.executor)
      .execute(IExecutor.Flow.Withdrawal, executionAmount, _args.userPayload, _args.relayerPayload);

    emit WithdrawalOrRefund(IExecutor.Flow.Withdrawal, _args.withdrawalId, _args.content.executor, executionAmount);
  }

  function _fpcFundingCutOn(uint256 _netAfterTips) internal view returns (uint256) {
    if ($frozen) {
      return 0;
    }
    return FPC_FUNDING_CUT < _netAfterTips ? FPC_FUNDING_CUT : _netAfterTips;
  }

  function _enforceFreezeGate(uint256 _anchorCheckpoint, uint256 _epochNumber, uint256 _numCheckpointsInEpoch)
    internal
    view
  {
    if ($frozen) {
      require(_anchorCheckpoint <= $freezeCheckpointNumber, Errors.OxidePortal__CheckpointPastFreeze());
      require(_epochNumber <= $freezeEpochNumber, Errors.OxidePortal__EpochPastFreeze());
      if (_epochNumber == $freezeEpochNumber) {
        require(_numCheckpointsInEpoch <= $freezeCheckpointCount, Errors.OxidePortal__ProofDepthPastFreeze());
      }
    }
  }

  function freeze() external override(IOxidePortal) nonReentrant {
    require($initialized, Errors.OxidePortal__Uninitialized());
    require(!$frozen, Errors.OxidePortal__AlreadyFrozen());

    if (msg.sender != owner()) {
      IHaveVersion canonicalRollup = REGISTRY.getCanonicalRollup();
      require(address(canonicalRollup) != address(ROLLUP), Errors.OxidePortal__RollupStillCanonical());
    }

    uint256 checkpointNumber = ROLLUP.getProvenCheckpointNumber();
    bytes32 archiveRoot = ROLLUP.archiveAt(checkpointNumber);
    require(archiveRoot != bytes32(0), Errors.OxidePortal__UnknownCheckpoint());

    uint256 epochNumber = Epoch.unwrap(ROLLUP.getEpochForCheckpoint(checkpointNumber));

    bytes32[MAX_CHECKPOINTS_PER_EPOCH] memory roots = OUTBOX.getRoots(Epoch.wrap(epochNumber));
    uint256 freezeCheckpointCount = 0;
    for (uint256 i = MAX_CHECKPOINTS_PER_EPOCH; i > 0; i--) {
      if (roots[i - 1] != bytes32(0)) {
        freezeCheckpointCount = i;
        break;
      }
    }

    $frozen = true;
    $freezeCheckpointNumber = checkpointNumber;
    $freezeEpochNumber = epochNumber;
    $freezeArchive = archiveRoot;
    $freezeCheckpointCount = freezeCheckpointCount;

    emit Frozen(checkpointNumber, epochNumber, archiveRoot, freezeCheckpointCount);
  }

  function refundFrozenNotes(IOxidePortal.RefundFrozenNotesArgs calldata _args)
    external
    override(IOxidePortal)
    nonReentrant
  {
    require($initialized, Errors.OxidePortal__Uninitialized());
    require($frozen, Errors.OxidePortal__NotFrozen());
    require(_args.executor.code.length > 0, Errors.OxidePortal__InvalidWithdrawalExecutor());
    require(_args.nullifiers.length > 0, Errors.OxidePortal__EmptyFrozenNotesRefundNullifiers());
    require(
      _args.nullifiers.length <= OxideConstants.MAX_FROZEN_NOTES_PER_REFUND,
      Errors.OxidePortal__TooManyFrozenNotesRefundNullifiers(_args.nullifiers.length)
    );
    _enforceTxCap(_args.amount);

    bytes32[] memory publicInputs = new bytes32[](OxideConstants.FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(ROLLUP_VERSION);
    publicInputs[2] = bytes32(uint256(uint160(address(this))));
    publicInputs[3] = $l2Portal;
    publicInputs[4] = $freezeArchive;
    publicInputs[5] = bytes32(_args.amount);
    publicInputs[6] = bytes32(uint256(uint160(_args.executor)));
    // solhint-disable oxide/no-comments
    // In a standard withdrawal, the withdrawal message commits to the user payload. Here the payload is
    // part of the public inputs of the refund circuit instead.
    // solhint-enable oxide/no-comments
    publicInputs[7] = Hash.sha256ToField(_args.userPayload);

    for (uint256 i = 0; i < _args.nullifiers.length; i++) {
      bytes32 nullifier = _args.nullifiers[i];
      require(nullifier != bytes32(0), Errors.OxidePortal__ZeroRefundNullifier());
      publicInputs[i + 8] = nullifier;
      require(!$isRefundNullifierSpent[nullifier], Errors.OxidePortal__RefundNullifierAlreadySpent(nullifier));
      $isRefundNullifierSpent[nullifier] = true;
    }

    bytes32 finalDigest = sha256(abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND, publicInputs));
    address signer = ECDSA.recover(finalDigest, _args.teeSignature);
    _assertTeeActive(signer);

    require(
      FROZEN_NOTES_REFUND_VERIFIER.verify(_args.proof, publicInputs),
      Errors.OxidePortal__InvalidFrozenNotesRefundProof()
    );

    UNDERLYING.safeTransfer(_args.executor, _args.amount);
    IExecutor(_args.executor)
      .execute(IExecutor.Flow.FrozenNotesRefund, _args.amount, _args.userPayload, _args.relayerPayload);

    emit WithdrawalOrRefund(IExecutor.Flow.FrozenNotesRefund, _args.nullifiers[0], _args.executor, _args.amount);
  }

  function refundFrozenDeposit(IOxidePortal.RefundFrozenDepositArgs calldata _args)
    external
    override(IOxidePortal)
    nonReentrant
  {
    require($initialized, Errors.OxidePortal__Uninitialized());
    require($frozen, Errors.OxidePortal__NotFrozen());
    require(_args.executor.code.length > 0, Errors.OxidePortal__InvalidWithdrawalExecutor());
    require(_args.siloedNullifier != bytes32(0), Errors.OxidePortal__ZeroRefundNullifier());
    require(
      !$isRefundNullifierSpent[_args.siloedNullifier],
      Errors.OxidePortal__RefundNullifierAlreadySpent(_args.siloedNullifier)
    );
    $isRefundNullifierSpent[_args.siloedNullifier] = true;
    _enforceTxCap(_args.amount);

    bytes32[] memory publicInputs = new bytes32[](OxideConstants.FROZEN_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(ROLLUP_VERSION);
    publicInputs[2] = bytes32(uint256(uint160(address(this))));
    publicInputs[3] = $freezeArchive;
    publicInputs[4] = bytes32(_args.amount);
    publicInputs[5] = bytes32(uint256(uint160(_args.executor)));
    // solhint-disable oxide/no-comments
    // In a standard withdrawal, the withdrawal message commits to the user payload. Here the payload is
    // part of the public inputs of the refund circuit instead.
    // solhint-enable oxide/no-comments
    publicInputs[6] = Hash.sha256ToField(_args.userPayload);
    publicInputs[7] = _args.siloedNullifier;

    bytes32 finalDigest = sha256(abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_FROZEN_DEPOSIT_REFUND, publicInputs));
    address signer = ECDSA.recover(finalDigest, _args.teeSignature);
    _assertTeeActive(signer);

    require(
      FROZEN_DEPOSIT_REFUND_VERIFIER.verify(_args.proof, publicInputs),
      Errors.OxidePortal__InvalidFrozenDepositRefundProof()
    );

    UNDERLYING.safeTransfer(_args.executor, _args.amount);
    IExecutor(_args.executor)
      .execute(IExecutor.Flow.FrozenDepositRefund, _args.amount, _args.userPayload, _args.relayerPayload);

    emit WithdrawalOrRefund(IExecutor.Flow.FrozenDepositRefund, _args.siloedNullifier, _args.executor, _args.amount);
  }

  function refundUnprocessedDeposit(IOxidePortal.RefundUnprocessedDepositArgs calldata _args)
    external
    override(IOxidePortal)
    nonReentrant
  {
    require($initialized, Errors.OxidePortal__Uninitialized());
    require($frozen, Errors.OxidePortal__NotFrozen());
    require(_args.executor.code.length > 0, Errors.OxidePortal__InvalidWithdrawalExecutor());
    require(_args.siloedNullifier != bytes32(0), Errors.OxidePortal__ZeroRefundNullifier());
    require(
      !$isRefundNullifierSpent[_args.siloedNullifier],
      Errors.OxidePortal__RefundNullifierAlreadySpent(_args.siloedNullifier)
    );
    _enforceTxCap(_args.amount);

    _verifyInboxMembership(_args.messageHash, _args.messageLeafIndex, _args.inboxSiblingPath);

    bytes32[] memory publicInputs = new bytes32[](OxideConstants.UNPROCESSED_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(ROLLUP_VERSION);
    publicInputs[2] = bytes32(uint256(uint160(address(this))));
    publicInputs[3] = $freezeArchive;
    publicInputs[4] = bytes32(_args.amount);
    publicInputs[5] = bytes32(uint256(uint160(_args.executor)));
    // solhint-disable oxide/no-comments
    // In a standard withdrawal, the withdrawal message commits to the user payload. Here the payload is
    // part of the public inputs of the refund circuit instead.
    // solhint-enable oxide/no-comments
    publicInputs[6] = Hash.sha256ToField(_args.userPayload);
    publicInputs[7] = _args.messageHash;
    publicInputs[8] = bytes32(_args.messageLeafIndex);
    publicInputs[9] = _args.siloedNullifier;
    require(
      UNPROCESSED_DEPOSIT_REFUND_VERIFIER.verify(_args.proof, publicInputs),
      Errors.OxidePortal__InvalidUnprocessedDepositRefundProof()
    );

    _validateUnprocessedDepositRefundTeeSignature(publicInputs, _args.teeSignature);

    $isRefundNullifierSpent[_args.siloedNullifier] = true;

    UNDERLYING.safeTransfer(_args.executor, _args.amount);
    IExecutor(_args.executor)
      .execute(IExecutor.Flow.UnprocessedDepositRefund, _args.amount, _args.userPayload, _args.relayerPayload);

    emit WithdrawalOrRefund(
      IExecutor.Flow.UnprocessedDepositRefund, _args.siloedNullifier, _args.executor, _args.amount
    );
  }

  function _verifyInboxMembership(
    bytes32 _messageHash,
    uint256 _messageLeafIndex,
    bytes32[] calldata _inboxSiblingPath
  ) internal view {
    uint256 subtreeSize = 1 << Constants.L1_TO_L2_MSG_SUBTREE_HEIGHT;
    uint256 checkpointNumber = (_messageLeafIndex / subtreeSize) + Constants.INITIAL_CHECKPOINT_NUMBER;
    MerkleLib.verifyMembership(
      _inboxSiblingPath, _messageHash, _messageLeafIndex % subtreeSize, INBOX.getRoot(checkpointNumber)
    );
  }

  function _validateUnprocessedDepositRefundTeeSignature(bytes32[] memory _publicInputs, bytes calldata _teeSignature)
    internal
    view
  {
    bytes32 finalDigest =
      sha256(abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND, _publicInputs));
    address signer = ECDSA.recover(finalDigest, _teeSignature);
    _assertTeeActive(signer);
  }

  function claimProverTips(IProverSubsidy _proverSubsidy, IOxidePortal.ProverTipClaim[] calldata _claims)
    external
    nonReentrant
    returns (uint256 totalSubsidy)
  {
    require(address(_proverSubsidy) != address(0), Errors.OxidePortal__InvalidProver());
    uint256 totalTip;
    ProverClaimLib.ChainEnv memory chainEnv = _chainEnv();
    for (uint256 i = 0; i < _claims.length; i++) {
      IOxidePortal.ProverClaimArgs calldata claimArgs = _claims[i].args;
      ProverClaimLib.ProverClaim calldata proof = _claims[i].proof;
      bytes32 messageContent = _consumeWithdrawProverClaim(claimArgs, proof);
      ProverClaimLib.verify(msg.sender, proof, messageContent, chainEnv, $claimed, $firstProver);
      totalTip += claimArgs.content.proverTip;
    }
    if (totalTip > 0) {
      UNDERLYING.safeTransfer(msg.sender, totalTip);
      emit TipReleased(msg.sender, totalTip);
    }
    totalSubsidy = _proverSubsidy.paySubsidy(_claims.length, msg.sender);
  }

  function _consumeWithdrawProverClaim(
    IOxidePortal.ProverClaimArgs calldata _args,
    ProverClaimLib.ProverClaim calldata _proof
  ) internal returns (bytes32 messageContent) {
    require(_args.content.proverTip <= _args.content.amount, Errors.OxidePortal__ProverTipExceedsAmount());
    bytes32 messageHash = Hash.sha256ToField(_buildWithdrawalMessage(_args.content));

    _enforceFreezeGate(_args.checkpointNumber, _proof.epochNumber, _proof.proofLength);

    require(
      !$isWithdrawalProverClaimSpent[_args.withdrawalId],
      Errors.OxidePortal__WithdrawalProverClaimAlreadyMade(_args.withdrawalId)
    );
    $isWithdrawalProverClaimSpent[_args.withdrawalId] = true;

    bytes32 archiveRoot = ROLLUP.archiveAt(_args.checkpointNumber);
    require(archiveRoot != bytes32(0), Errors.OxidePortal__UnknownCheckpoint());

    require(_args.checkpointNumber <= ROLLUP.getProvenCheckpointNumber(), Errors.OxidePortal__UnprovenCheckpoint());
    _validateWithdrawalTeeSignature(archiveRoot, _args.withdrawalId, messageHash, _args.teeSignature);

    messageContent = _withdrawalContentHash(_args.content);
  }

  function prepareFirstProver(uint256 _checkpointNumber, address _prover) external {
    require(_prover != address(0), Errors.OxidePortal__InvalidProver());
    uint256 proven = ROLLUP.getProvenCheckpointNumber();
    require(proven < _checkpointNumber, Errors.OxidePortal__CheckpointAlreadyProven(_checkpointNumber, proven));
    bytes32 slot = _computeFirstProverSlot(_checkpointNumber, _prover);
    assembly {
      tstore(slot, 1)
    }
  }

  function recordFirstProver(uint256 _checkpointNumber, uint256 _proofLength, address _prover) external {
    bytes32 slot = _computeFirstProverSlot(_checkpointNumber, _prover);
    uint256 prepared;
    assembly {
      prepared := tload(slot)
    }
    require(prepared == 1, Errors.OxidePortal__FirstProverNotPrepared(_checkpointNumber, _prover));
    uint256 proven = ROLLUP.getProvenCheckpointNumber();
    require(proven == _checkpointNumber, Errors.OxidePortal__CheckpointNotJustProven(_checkpointNumber, proven));
    address existing = $firstProver[_checkpointNumber];
    require(existing == address(0), Errors.OxidePortal__FirstProverAlreadyRecorded(_checkpointNumber, existing));
    require(
      _proofLength > 0 && _proofLength <= _checkpointNumber,
      Errors.OxidePortal__InvalidProofLengthForCheckpoint(_checkpointNumber, _proofLength)
    );
    uint256 epochNumber = Epoch.unwrap(ROLLUP.getEpochForCheckpoint(_checkpointNumber));
    uint256 firstCheckpointInEpoch = _checkpointNumber - _proofLength + 1;
    ProverClaimLib.assertFirstCheckpointInEpoch(ROLLUP, _checkpointNumber, epochNumber, firstCheckpointInEpoch);
    require(
      ROLLUP.getHasSubmitted(Epoch.wrap(epochNumber), _proofLength, _prover),
      Errors.OxidePortal__ProverDidNotSubmit(_prover, epochNumber, _proofLength)
    );
    $firstProver[_checkpointNumber] = _prover;
    emit FirstProverRecorded(_checkpointNumber, _prover);
  }

  function _chainEnv() internal view returns (ProverClaimLib.ChainEnv memory) {
    return ProverClaimLib.ChainEnv({
      rollup: ROLLUP, outbox: OUTBOX, rollupVersion: ROLLUP_VERSION, l2Portal: $l2Portal, portal: address(this)
    });
  }

  function _computeFirstProverSlot(uint256 _checkpointNumber, address _prover) internal pure returns (bytes32) {
    return keccak256(abi.encode("OxidePortal.firstProverSlot", _checkpointNumber, _prover));
  }

  function _enforceTxCap(uint256 _amount) internal pure {
    require(_amount <= OxideConstants.TX_AMOUNT_CAP, Errors.Caps__TxLimitSurpassed());
  }

  function isTeeActive(address _tee) external view override(IOxidePortal) returns (bool) {
    return $teeBindings[_tee].pcr0Hash != bytes32(0);
  }

  function _assertTeeActive(address _tee) internal view {
    require($teeBindings[_tee].pcr0Hash != bytes32(0), Errors.OxidePortal__UnregisteredTEE());
  }

  function _buildWithdrawalMessage(WithdrawContent memory _content)
    internal
    view
    returns (DataStructures.L2ToL1Msg memory)
  {
    return DataStructures.L2ToL1Msg({
      sender: DataStructures.L2Actor({actor: $l2Portal, version: ROLLUP_VERSION}),
      recipient: DataStructures.L1Actor({actor: address(this), chainId: block.chainid}),
      content: _withdrawalContentHash(_content)
    });
  }

  function _withdrawalContentHash(WithdrawContent memory _content) internal pure returns (bytes32) {
    return Hash.sha256ToField(
      abi.encodeWithSignature(
        "withdraw(address,bytes32,uint256,uint256,uint256)",
        _content.executor,
        _content.userPayloadHash,
        _content.amount,
        _content.proverTip,
        _content.randomness
      )
    );
  }

  function _validateWithdrawalTeeSignature(
    bytes32 _archiveRoot,
    bytes32 _withdrawalId,
    bytes32 _messageHash,
    bytes calldata _teeSignature
  ) internal view {
    bytes32 finalDigest = sha256(
      abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED, _archiveRoot, _withdrawalId, _messageHash)
    );
    address signer = ECDSA.recover(finalDigest, _teeSignature);
    _assertTeeActive(signer);
  }
}
