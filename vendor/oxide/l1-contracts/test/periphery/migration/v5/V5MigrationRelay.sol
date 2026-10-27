// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {IERC20 as IERC20OZ} from "@oz/token/ERC20/IERC20.sol";

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {MigrationExecutor} from "@periphery/migration/MigrationExecutor.sol";
import {MigrationSubsidy} from "@periphery/migration/MigrationSubsidy.sol";

import {MigrationRelay} from "@test/periphery/migration/MigrationRelay.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {MockProofVerifier} from "@test/fixtures/MockProofVerifier.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";

import {V5OxidePortal} from "./V5OxidePortal.sol";
import {IV5OxidePortal} from "./IV5OxidePortal.sol";
import {IV5NitroValidator} from "./V5TEERegistrationLib.sol";
import {V5Inbox} from "./V5Inbox.sol";
import {V5OxideConstants} from "./V5OxideConstants.sol";

interface VmCoolV5MigrationAccount {
  function cool(address) external;
}

abstract contract V5MigrationRelay is MigrationRelay {
  uint256 internal constant V5_ROLLUP_VERSION = ROLLUP_VERSION + 2;
  bytes32 internal constant V5_L2_PORTAL = bytes32(uint256(0x5D0C7A1));
  uint256 internal constant V5_INBOX_LAG = 2;
  uint256 internal constant V5_FPC_FUNDING_CUT = 0.5 ether;
  uint256 internal constant V5_DEPOSITS_BEFORE_THE_FREEZE = 3;
  uint256 internal constant V5_FROZEN_NOTES_REFUND_VERIFICATION_GAS = 2_129_779;
  uint256 internal constant V5_FROZEN_DEPOSIT_REFUND_VERIFICATION_GAS = 2_030_003;
  uint256 internal constant V5_UNPROCESSED_DEPOSIT_REFUND_VERIFICATION_GAS = 2_032_840;
  uint256 internal constant V5_REFUNDED_DEPOSIT = 1;
  uint256 internal constant V5_DEPOSIT_AMOUNT = 10 ether;
  bytes32 internal constant V5_WITHDRAWAL_ID = keccak256("v5Migration");

  V5OxidePortal internal v5Portal;
  MockRollup internal v5Rollup;
  V5Inbox internal v5Inbox;
  IOutbox internal v5Outbox;
  MockProofVerifier internal v5FrozenNotesVerifier;
  MockProofVerifier internal v5FrozenDepositVerifier;
  MockProofVerifier internal v5UnprocessedDepositVerifier;
  MigrationExecutor internal v5Executor;
  MigrationSubsidy internal v5Subsidy;

  bytes32[] internal v5DepositLeaves;
  uint256[] internal v5DepositIndexes;
  bytes internal v5Withdrawal;

  function setUp() public virtual override {
    super.setUp();
    _buildV5Source();
    v5Executor = new MigrationExecutor(
      IOxidePortal(address(v5Portal)),
      IOxidePortal(address(destinationPortal)),
      IERC20OZ(address(payoutToken)),
      OWNER,
      keccak256(type(OperationExecutor).runtimeCode),
      ethUsdFeed
    );
    v5Subsidy = v5Executor.SUBSIDY();
    _mintPayout(address(v5Subsidy), SUBSIDY_POT);
    vm.prank(OWNER);
    v5Subsidy.setConfig(0, type(uint128).max, MIN_MIGRATED_AMOUNT);

    _depositIntoV5();
    v5Withdrawal = _v5WithdrawCall(MIGRATION_COMMITMENT, _relayTip(), address(operationExecutor), 20);
    if (_freezeV5Source()) {
      vm.prank(OWNER);
      v5Portal.freeze();
    }
    underlying.mint(address(v5Portal), RELAY_PORTAL_FLOAT);
  }

  function _freezeV5Source() internal view virtual returns (bool) {
    return true;
  }

  function _buildV5Source() internal {
    v5Rollup = new MockRollup();
    v5Inbox = new V5Inbox(address(v5Rollup), V5_ROLLUP_VERSION, Constants.L1_TO_L2_MSG_SUBTREE_HEIGHT, V5_INBOX_LAG);
    v5Outbox = IOutbox(address(new Outbox(address(v5Rollup), V5_ROLLUP_VERSION)));
    v5Rollup.setInbox(IInbox(address(v5Inbox)));
    v5Rollup.setOutbox(v5Outbox);
    v5Rollup.setCheckpoint(DEFAULT_CHECKPOINT_NUMBER, DEFAULT_ARCHIVE_ROOT, MIGRATION_WITHDRAWAL_EPOCH);
    v5Rollup.setProvenCheckpointNumber(DEFAULT_CHECKPOINT_NUMBER);
    registry.setRollup(V5_ROLLUP_VERSION, IHaveVersion(address(v5Rollup)));
    v5FrozenNotesVerifier = new MockProofVerifier();
    v5FrozenDepositVerifier = new MockProofVerifier();
    v5UnprocessedDepositVerifier = new MockProofVerifier();
    v5FrozenNotesVerifier.setAcceptAll(true);
    v5FrozenDepositVerifier.setAcceptAll(true);
    v5UnprocessedDepositVerifier.setAcceptAll(true);
    v5Portal = new V5OxidePortal(
      OWNER,
      V5OxidePortal.FpcFunding({funder: makeAddr("v5FpcFunder"), cut: V5_FPC_FUNDING_CUT}),
      ICertManager(address(certManager)),
      IV5NitroValidator(address(nitroValidator)),
      IERC20OZ(address(underlying)),
      IRegistry(address(registry)),
      V5_ROLLUP_VERSION,
      V5OxidePortal.RefundVerifiers({
        frozenNotes: IVerifier(address(v5FrozenNotesVerifier)),
        frozenDeposit: IVerifier(address(v5FrozenDepositVerifier)),
        unprocessedDeposit: IVerifier(address(v5UnprocessedDepositVerifier))
      }),
      RATE,
      GLOBAL_LIMIT
    );
    vm.prank(OWNER);
    v5Portal.initialize(V5_L2_PORTAL);
    _activateV5Tee(TEST_TEE_SIGNER);
  }

  function _activateV5Tee(address _tee) internal {
    vm.record();
    v5Portal.isTeeActive(_tee);
    (bytes32[] memory reads,) = vm.accesses(address(v5Portal));
    require(reads.length == 1, "the TEE check reads one slot");
    vm.store(address(v5Portal), reads[0], keccak256(TEST_TEE_PCR0));
    require(v5Portal.isTeeActive(_tee), "the TEE is active");
  }

  function _depositIntoV5() internal {
    vm.startPrank(USER);
    underlying.approve(address(v5Portal), type(uint256).max);
    for (uint256 i = 0; i < V5_DEPOSITS_BEFORE_THE_FREEZE; i++) {
      (bytes32 key, uint256 index,) = v5Portal.deposit(bytes32(uint256(0xD5000 + i)), V5_DEPOSIT_AMOUNT);
      v5DepositLeaves.push(key);
      v5DepositIndexes.push(index);
    }
    vm.stopPrank();
  }

  function _v5RelayTo(MigrationSubsidy _subsidy, bytes memory _inner) internal returns (uint256 txGas, uint256 priced) {
    bytes memory outer = abi.encodeCall(OperationExecutor.execute, (address(_subsidy), _inner, payoutToken, 0, 0, 0));
    uint256 potBefore = payoutToken.balanceOf(address(_subsidy));
    _coolEveryAccountOfTheRelay(address(operationExecutor), MIGRATION_RELAYER);
    address[9] memory touched = [
      address(v5Portal),
      address(v5Rollup),
      address(v5Inbox),
      address(v5Outbox),
      address(v5FrozenNotesVerifier),
      address(v5FrozenDepositVerifier),
      address(v5UnprocessedDepositVerifier),
      address(v5Executor),
      address(v5Subsidy)
    ];
    for (uint256 i = 0; i < touched.length; i++) {
      VmCoolV5MigrationAccount(address(vm)).cool(touched[i]);
    }
    vm.prank(MIGRATION_RELAYER, MIGRATION_RELAYER);
    (bool ok, bytes memory ret) = address(operationExecutor).call(outer);
    if (!ok) {
      assembly ("memory-safe") {
        revert(add(ret, 32), mload(ret))
      }
    }
    txGas = RelayerTransaction.lastTxGas(outer);
    priced = _pricedGasOf(_subsidy, potBefore - payoutToken.balanceOf(address(_subsidy)));
  }

  function _v5Relay(bytes memory _inner) internal returns (uint256 txGas, uint256 priced) {
    return _v5RelayTo(v5Subsidy, _inner);
  }

  function _v5FrozenNotesCall(uint256 _seed, uint256 _amount, uint256 _tip, address _tipRecipient, uint256 _notes)
    internal
    view
    returns (bytes memory)
  {
    bytes memory payload = _migrationPayload(MIGRATION_COMMITMENT, _tip);
    bytes32[] memory nullifiers = new bytes32[](_notes);
    bytes32[] memory publicInputs = new bytes32[](V5OxideConstants.FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(V5_ROLLUP_VERSION);
    publicInputs[2] = bytes32(uint256(uint160(address(v5Portal))));
    publicInputs[3] = V5_L2_PORTAL;
    publicInputs[4] = v5Portal.$freezeArchive();
    publicInputs[5] = bytes32(_amount);
    publicInputs[6] = bytes32(uint256(uint160(address(v5Executor))));
    publicInputs[7] = Hash.sha256ToField(payload);
    for (uint256 i = 0; i < _notes; i++) {
      nullifiers[i] = _notesNullifier(_seed, i);
      publicInputs[i + 8] = nullifiers[i];
    }
    (bytes memory proof,) = _fixtureProof("v5_frozen_notes_refund");
    bytes32 digest = sha256(abi.encodePacked(V5OxideConstants.TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND, publicInputs));
    return abi.encodeCall(
      IV5OxidePortal.refundFrozenNotes,
      (IV5OxidePortal.RefundFrozenNotesArgs({
          executor: address(v5Executor),
          userPayload: payload,
          relayerPayload: _relayerPayload(_tipRecipient),
          amount: _amount,
          nullifiers: nullifiers,
          proof: proof,
          teeSignature: _signTee(TEST_TEE_PK, digest)
        }))
    );
  }

  function _v5FrozenDepositCall(uint256 _seed, uint256 _amount, uint256 _tip, address _tipRecipient)
    internal
    view
    returns (bytes memory)
  {
    bytes memory payload = _migrationPayload(MIGRATION_COMMITMENT, _tip);
    bytes32 nullifier = _depositNullifier(_seed);
    bytes32[] memory publicInputs = new bytes32[](V5OxideConstants.FROZEN_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(V5_ROLLUP_VERSION);
    publicInputs[2] = bytes32(uint256(uint160(address(v5Portal))));
    publicInputs[3] = v5Portal.$freezeArchive();
    publicInputs[4] = bytes32(_amount);
    publicInputs[5] = bytes32(uint256(uint160(address(v5Executor))));
    publicInputs[6] = Hash.sha256ToField(payload);
    publicInputs[7] = nullifier;
    (bytes memory proof,) = _fixtureProof("v5_frozen_deposit_refund");
    bytes32 digest = sha256(abi.encodePacked(V5OxideConstants.TEE_SIG_DOMAIN_FROZEN_DEPOSIT_REFUND, publicInputs));
    return abi.encodeCall(
      IV5OxidePortal.refundFrozenDeposit,
      (IV5OxidePortal.RefundFrozenDepositArgs({
          executor: address(v5Executor),
          userPayload: payload,
          relayerPayload: _relayerPayload(_tipRecipient),
          amount: _amount,
          siloedNullifier: nullifier,
          proof: proof,
          teeSignature: _signTee(TEST_TEE_PK, digest)
        }))
    );
  }

  function _v5UnprocessedDepositCall(uint256 _seed, uint256 _tip, address _tipRecipient)
    internal
    view
    returns (bytes memory)
  {
    bytes memory payload = _migrationPayload(MIGRATION_COMMITMENT, _tip);
    bytes32 nullifier = _unprocessedNullifier(_seed);
    bytes32 messageHash = v5DepositLeaves[V5_REFUNDED_DEPOSIT];
    uint256 messageLeafIndex = v5DepositIndexes[V5_REFUNDED_DEPOSIT];
    uint256 amount = V5_DEPOSIT_AMOUNT - V5_FPC_FUNDING_CUT;
    bytes32[] memory publicInputs = new bytes32[](V5OxideConstants.UNPROCESSED_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(V5_ROLLUP_VERSION);
    publicInputs[2] = bytes32(uint256(uint160(address(v5Portal))));
    publicInputs[3] = v5Portal.$freezeArchive();
    publicInputs[4] = bytes32(amount);
    publicInputs[5] = bytes32(uint256(uint160(address(v5Executor))));
    publicInputs[6] = Hash.sha256ToField(payload);
    publicInputs[7] = messageHash;
    publicInputs[8] = bytes32(messageLeafIndex);
    publicInputs[9] = nullifier;
    (bytes memory proof,) = _fixtureProof("v5_unprocessed_deposit_refund");
    bytes32 digest = sha256(abi.encodePacked(V5OxideConstants.TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND, publicInputs));
    return abi.encodeCall(
      IV5OxidePortal.refundUnprocessedDeposit,
      (IV5OxidePortal.RefundUnprocessedDepositArgs({
          executor: address(v5Executor),
          userPayload: payload,
          relayerPayload: _relayerPayload(_tipRecipient),
          amount: amount,
          siloedNullifier: nullifier,
          messageHash: messageHash,
          messageLeafIndex: messageLeafIndex,
          inboxSiblingPath: _v5InboxSiblingPath(V5_REFUNDED_DEPOSIT),
          proof: proof,
          teeSignature: _signTee(TEST_TEE_PK, digest)
        }))
    );
  }

  function _v5InboxSiblingPath(uint256 _position) internal view returns (bytes32[] memory path) {
    uint256 height = Constants.L1_TO_L2_MSG_SUBTREE_HEIGHT;
    path = new bytes32[](height);
    bytes32[] memory layer = v5DepositLeaves;
    bytes32 zero = bytes32(0);
    uint256 position = _position;
    for (uint256 level = 0; level < height; level++) {
      uint256 sibling = position ^ 1;
      path[level] = sibling < layer.length ? layer[sibling] : zero;
      bytes32[] memory parent = new bytes32[]((layer.length + 1) / 2);
      for (uint256 i = 0; i < parent.length; i++) {
        bytes32 right = 2 * i + 1 < layer.length ? layer[2 * i + 1] : zero;
        parent[i] = Hash.sha256ToField(bytes.concat(layer[2 * i], right));
      }
      layer = parent;
      zero = Hash.sha256ToField(bytes.concat(zero, zero));
      position >>= 1;
    }
  }

  function _v5WithdrawCall(bytes32 _commitment, uint256 _tip, address _tipRecipient, uint256 _depth)
    internal
    returns (bytes memory)
  {
    bytes memory payload = _migrationPayload(_commitment, _tip);
    IV5OxidePortal.WithdrawContent memory content = IV5OxidePortal.WithdrawContent({
      executor: address(v5Executor),
      userPayloadHash: Hash.sha256ToField(payload),
      amount: MIGRATION_AMOUNT,
      proverTip: MIGRATION_PROVER_TIP,
      randomness: 0xDEC0DE
    });
    bytes32 messageHash = Hash.sha256ToField(
      DataStructures.L2ToL1Msg({
        sender: DataStructures.L2Actor({actor: V5_L2_PORTAL, version: V5_ROLLUP_VERSION}),
        recipient: DataStructures.L1Actor({actor: address(v5Portal), chainId: block.chainid}),
        content: Hash.sha256ToField(
          abi.encodeWithSignature(
            "withdraw(address,bytes32,uint256,uint256,uint256)",
            content.executor,
            content.userPayloadHash,
            content.amount,
            content.proverTip,
            content.randomness
          )
        )
      })
    );
    (bytes32[] memory path, bytes32 root) = _pathAndRoot(messageHash, 0, _depth);
    vm.prank(address(v5Rollup));
    v5Outbox.insert(Epoch.wrap(MIGRATION_WITHDRAWAL_EPOCH), MIGRATION_WITHDRAWAL_CHECKPOINTS, root);
    bytes32 digest = sha256(
      abi.encodePacked(
        V5OxideConstants.TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED, DEFAULT_ARCHIVE_ROOT, V5_WITHDRAWAL_ID, messageHash
      )
    );
    return abi.encodeCall(
      IV5OxidePortal.withdraw,
      (IV5OxidePortal.WithdrawArgs({
          content: content,
          userPayload: payload,
          relayerPayload: _relayerPayload(_tipRecipient),
          epochNumber: MIGRATION_WITHDRAWAL_EPOCH,
          numCheckpointsInEpoch: MIGRATION_WITHDRAWAL_CHECKPOINTS,
          leafIndex: 0,
          path: path,
          checkpointNumber: DEFAULT_CHECKPOINT_NUMBER,
          withdrawalId: V5_WITHDRAWAL_ID,
          teeSignature: _signTee(TEST_TEE_PK, digest)
        }))
    );
  }

  function _v5PotPaid(uint256 _potBefore) internal view returns (uint256) {
    return _potBefore - payoutToken.balanceOf(address(v5Subsidy));
  }

  function _frozenNotesVerificationGas() internal pure override returns (uint256) {
    return V5_FROZEN_NOTES_REFUND_VERIFICATION_GAS;
  }

  function _frozenDepositVerificationGas() internal pure override returns (uint256) {
    return V5_FROZEN_DEPOSIT_REFUND_VERIFICATION_GAS;
  }

  function _unprocessedDepositVerificationGas() internal pure override returns (uint256) {
    return V5_UNPROCESSED_DEPOSIT_REFUND_VERIFICATION_GAS;
  }
}
