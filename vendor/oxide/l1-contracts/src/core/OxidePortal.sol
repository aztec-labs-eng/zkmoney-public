// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox, MAX_CHECKPOINTS_PER_EPOCH} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@oz/utils/cryptography/ECDSA.sol";
import {Caps} from "./Caps.sol";
import {IOxidePortal} from "./interfaces/IOxidePortal.sol";
import {IPortalFactory} from "./interfaces/IPortalFactory.sol";
import {ProverClaimLib} from "./lib/ProverClaimLib.sol";
import {IProverSubsidy} from "@core/interfaces/IProverSubsidy.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {ITeeRegistry} from "@core/interfaces/ITeeRegistry.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortal is Caps, ReentrancyGuardTransient, IOxidePortal {
  using SafeERC20 for IERC20;

  IERC20 public immutable UNDERLYING;

  IInbox public immutable INBOX;
  IOutbox public immutable OUTBOX;
  IRollup public immutable ROLLUP;
  IRegistry public immutable REGISTRY;

  IVerifier public immutable FROZEN_NOTES_REFUND_VERIFIER;
  IVerifier public immutable FROZEN_DEPOSITS_REFUND_VERIFIER;
  IVerifier public immutable UNPROCESSED_DEPOSIT_REFUND_VERIFIER;

  ITeeRegistry public immutable TEE_REGISTRY;
  uint256 public immutable ROLLUP_VERSION;

  bytes32 public immutable L2_TOKEN;

  mapping(bytes32 withdrawalId => bool spent) public $isWithdrawalSpent;

  mapping(bytes32 withdrawalId => bool spent) public $isWithdrawalProverClaimSpent;

  mapping(uint256 epoch => mapping(uint256 leafId => bool claimed)) public $claimed;

  mapping(bytes32 nullifier => bool spent) public $isRefundNullifierSpent;

  mapping(bytes32 messageHash => uint256 indexPlusOne) public $depositMessageIndex;

  bool public override $frozen;
  uint256 public $freezeCheckpointNumber;
  uint256 public $freezeEpochNumber;
  bytes32 public $freezeArchive;

  uint256 public $freezeCheckpointCount;

  event Frozen(
    uint256 indexed checkpointNumber, uint256 indexed epochNumber, bytes32 archive, uint256 freezeCheckpointCount
  );

  event Deposit(bytes32 indexed recipientCommitment, uint256 amount, bytes32 key, uint256 index);

  event WithdrawalOrRefund(
    IExecutor.Flow indexed flow, bytes32 indexed nullifier, address indexed executor, uint256 executionAmount
  );

  event TipReleased(address indexed to, uint256 amount);

  struct RefundVerifiers {
    IVerifier frozenNotes;
    IVerifier frozenDeposits;
    IVerifier unprocessedDeposit;
  }

  constructor(
    ITeeRegistry _teeRegistry,
    IERC20 _underlying,
    IRegistry _registry,
    uint256 _rollupVersion,
    RefundVerifiers memory _verifiers,
    uint128 _txAmountCap,
    uint256 _rate,
    uint256 _globalLimit
  ) Caps(_txAmountCap, _rate, _globalLimit) {
    TEE_REGISTRY = _teeRegistry;
    UNDERLYING = _underlying;
    REGISTRY = _registry;
    ROLLUP_VERSION = _rollupVersion;
    IRollup rollup = IRollup(address(_registry.getRollup(_rollupVersion)));
    ROLLUP = rollup;
    INBOX = rollup.getInbox();
    OUTBOX = rollup.getOutbox();
    FROZEN_NOTES_REFUND_VERIFIER = _verifiers.frozenNotes;
    FROZEN_DEPOSITS_REFUND_VERIFIER = _verifiers.frozenDeposits;
    UNPROCESSED_DEPOSIT_REFUND_VERIFIER = _verifiers.unprocessedDeposit;
    L2_TOKEN = IPortalFactory(msg.sender).pendingL2Token();
  }

  function deposit(bytes32 _recipientCommitment, uint256 _amount)
    external
    override(IOxidePortal)
    returns (bytes32 key, uint256 index, uint256 creditedAmount)
  {
    require(!$frozen, Errors.OxidePortal__FrozenPortal());
    require(_recipientCommitment != bytes32(0), Errors.OxidePortal__ZeroRecipientCommitment());
    require(_amount > 0, Errors.OxidePortal__ZeroAmount());
    require(_amount <= type(uint128).max, Errors.OxidePortal__AmountTooLarge());
    creditedAmount = _amount;
    _markUsage(creditedAmount);

    bytes32 contentHash = Hash.sha256ToField(abi.encodeWithSignature("deposit(uint256)", creditedAmount));

    UNDERLYING.safeTransferFrom(msg.sender, address(this), _amount);

    (key, index) = INBOX.sendL2Message(
      DataStructures.L2Actor({actor: L2_TOKEN, version: ROLLUP_VERSION}), contentHash, _recipientCommitment
    );
    $depositMessageIndex[key] = index + 1;

    emit Deposit(_recipientCommitment, creditedAmount, key, index);
  }

  function withdraw(IOxidePortal.WithdrawArgs calldata _args) external override(IOxidePortal) nonReentrant {
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

    uint256 executionAmount = _args.content.amount - _args.content.proverTip;
    UNDERLYING.safeTransfer(_args.content.executor, executionAmount);
    IExecutor(_args.content.executor)
      .execute(IExecutor.Flow.Withdrawal, executionAmount, _args.userPayload, _args.relayerPayload);

    emit WithdrawalOrRefund(IExecutor.Flow.Withdrawal, _args.withdrawalId, _args.content.executor, executionAmount);
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
    require(!$frozen, Errors.OxidePortal__AlreadyFrozen());

    IHaveVersion canonicalRollup = REGISTRY.getCanonicalRollup();
    require(address(canonicalRollup) != address(ROLLUP), Errors.OxidePortal__RollupStillCanonical());

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
    publicInputs[3] = L2_TOKEN;
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

    bytes32 finalDigest =
      sha256(abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND, address(TEE_REGISTRY), publicInputs));
    address signer = ECDSA.recover(finalDigest, _args.teeSignature);
    _assertTeeRegistered(signer);

    require(
      FROZEN_NOTES_REFUND_VERIFIER.verify(_args.proof, publicInputs),
      Errors.OxidePortal__InvalidFrozenNotesRefundProof()
    );

    UNDERLYING.safeTransfer(_args.executor, _args.amount);
    IExecutor(_args.executor)
      .execute(IExecutor.Flow.FrozenNotesRefund, _args.amount, _args.userPayload, _args.relayerPayload);

    emit WithdrawalOrRefund(IExecutor.Flow.FrozenNotesRefund, _args.nullifiers[0], _args.executor, _args.amount);
  }

  function refundFrozenDeposits(IOxidePortal.RefundFrozenDepositsArgs calldata _args)
    external
    override(IOxidePortal)
    nonReentrant
  {
    require($frozen, Errors.OxidePortal__NotFrozen());
    require(_args.executor.code.length > 0, Errors.OxidePortal__InvalidWithdrawalExecutor());
    require(_args.nullifiers.length > 0, Errors.OxidePortal__EmptyFrozenDepositsRefundNullifiers());
    require(
      _args.nullifiers.length <= OxideConstants.MAX_FROZEN_DEPOSITS_PER_REFUND,
      Errors.OxidePortal__TooManyFrozenDepositsRefundNullifiers(_args.nullifiers.length)
    );
    _enforceTxCap(_args.amount);

    bytes32[] memory publicInputs = new bytes32[](OxideConstants.FROZEN_DEPOSITS_REFUND_PUBLIC_INPUT_COUNT);
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

    for (uint256 i = 0; i < _args.nullifiers.length; i++) {
      bytes32 nullifier = _args.nullifiers[i];
      require(nullifier != bytes32(0), Errors.OxidePortal__ZeroRefundNullifier());
      publicInputs[i + 7] = nullifier;
      require(!$isRefundNullifierSpent[nullifier], Errors.OxidePortal__RefundNullifierAlreadySpent(nullifier));
      $isRefundNullifierSpent[nullifier] = true;
    }

    bytes32 finalDigest = sha256(abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_FROZEN_DEPOSITS_REFUND, publicInputs));
    address signer = ECDSA.recover(finalDigest, _args.teeSignature);
    _assertTeeRegistered(signer);

    require(
      FROZEN_DEPOSITS_REFUND_VERIFIER.verify(_args.proof, publicInputs),
      Errors.OxidePortal__InvalidFrozenDepositsRefundProof()
    );

    UNDERLYING.safeTransfer(_args.executor, _args.amount);
    IExecutor(_args.executor)
      .execute(IExecutor.Flow.FrozenDepositsRefund, _args.amount, _args.userPayload, _args.relayerPayload);

    emit WithdrawalOrRefund(IExecutor.Flow.FrozenDepositsRefund, _args.nullifiers[0], _args.executor, _args.amount);
  }

  function refundUnprocessedDeposit(IOxidePortal.RefundUnprocessedDepositArgs calldata _args)
    external
    override(IOxidePortal)
    nonReentrant
  {
    require($frozen, Errors.OxidePortal__NotFrozen());
    require(_args.executor.code.length > 0, Errors.OxidePortal__InvalidWithdrawalExecutor());
    require(_args.siloedNullifier != bytes32(0), Errors.OxidePortal__ZeroRefundNullifier());
    require(
      !$isRefundNullifierSpent[_args.siloedNullifier],
      Errors.OxidePortal__RefundNullifierAlreadySpent(_args.siloedNullifier)
    );
    _enforceTxCap(_args.amount);

    require(
      $depositMessageIndex[_args.messageHash] == _args.messageLeafIndex + 1,
      Errors.OxidePortal__UnknownDepositMessage(_args.messageHash)
    );

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

  function _validateUnprocessedDepositRefundTeeSignature(bytes32[] memory _publicInputs, bytes calldata _teeSignature)
    internal
    view
  {
    bytes32 finalDigest =
      sha256(abi.encodePacked(OxideConstants.TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND, _publicInputs));
    address signer = ECDSA.recover(finalDigest, _teeSignature);
    _assertTeeRegistered(signer);
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
      ProverClaimLib.verify(msg.sender, proof, messageContent, chainEnv, $claimed);
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

  function _chainEnv() internal view returns (ProverClaimLib.ChainEnv memory) {
    return ProverClaimLib.ChainEnv({
      rollup: ROLLUP, outbox: OUTBOX, rollupVersion: ROLLUP_VERSION, l2Token: L2_TOKEN, portal: address(this)
    });
  }

  function _enforceTxCap(uint256 _amount) internal view {
    require(_amount <= TX_AMOUNT_CAP, Errors.Caps__TxLimitSurpassed());
  }

  function _assertTeeRegistered(address _tee) internal view {
    require(TEE_REGISTRY.isTeeRegistered(_tee), Errors.OxidePortal__UnregisteredTEE());
  }

  function _buildWithdrawalMessage(WithdrawContent memory _content)
    internal
    view
    returns (DataStructures.L2ToL1Msg memory)
  {
    return DataStructures.L2ToL1Msg({
      sender: DataStructures.L2Actor({actor: L2_TOKEN, version: ROLLUP_VERSION}),
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
      abi.encodePacked(
        OxideConstants.TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED,
        address(TEE_REGISTRY),
        _archiveRoot,
        _withdrawalId,
        _messageHash
      )
    );
    address signer = ECDSA.recover(finalDigest, _teeSignature);
    _assertTeeRegistered(signer);
  }
}
