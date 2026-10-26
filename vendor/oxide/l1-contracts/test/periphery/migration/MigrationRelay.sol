// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Inbox} from "@aztec/core/messagebridge/Inbox.sol";
import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {IHaveVersion} from "@aztec/governance/interfaces/IRegistry.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {HonkVerifier as FrozenNotesHonkVerifier} from "@generated/FrozenNotesRefundVerifier.sol";
import {HonkVerifier as FrozenDepositsHonkVerifier} from "@generated/FrozenDepositsRefundVerifier.sol";
import {HonkVerifier as UnprocessedDepositHonkVerifier} from "@generated/UnprocessedDepositRefundVerifier.sol";
import {IERC20 as IERC20OZ} from "@oz/token/ERC20/IERC20.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {MigrationExecutor} from "@periphery/migration/MigrationExecutor.sol";
import {MigrationSubsidy} from "@periphery/migration/MigrationSubsidy.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {MockOutbox} from "@test/fixtures/MockOutbox.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";
import {MockProofVerifier} from "@test/fixtures/MockProofVerifier.sol";

interface VmCoolMigrationAccount {
  function cool(address) external;
}

abstract contract MigrationRelay is OxidePortalBase {
  uint256 internal constant DESTINATION_ROLLUP_VERSION = ROLLUP_VERSION + 1;
  uint256 internal constant PRICED_MIGRATION_TOLERANCE = 2000;
  uint256 internal constant HARNESS_TO_CHAIN_MIGRATION_RELAY = 8600;
  uint256 internal constant RELAY_GAS_PRICE = 4 gwei;
  uint256 internal constant RELAY_PORTAL_FLOAT = 1_000_000 ether;
  uint256 internal constant SUBSIDY_POT = 1_000_000 ether;
  uint256 internal constant DESTINATION_WARM_DEPOSITS = 8;

  uint256 internal constant MIGRATION_WITHDRAWAL_EPOCH = 3;
  uint256 internal constant MIGRATION_WITHDRAWAL_CHECKPOINTS = 3;
  uint256 internal constant MIGRATION_WITHDRAWAL_PATH_DEPTH = 5;
  uint256 internal constant MIGRATION_AMOUNT = 1000 ether;
  uint256 internal constant MIGRATION_TIP = 0.1 ether;
  uint256 internal constant MIGRATION_PROVER_TIP = 70 ether;
  uint128 internal constant MIN_MIGRATED_AMOUNT = 1 ether;

  address internal constant MIGRATION_RELAYER = address(0x9E16);
  bytes32 internal constant MIGRATION_COMMITMENT = bytes32(uint256(0xC0FFEE));

  OxidePortal internal destinationPortal;
  MockRollup internal destinationRollup;
  IInbox internal destinationInbox;
  IERC20 internal payoutToken;
  MigrationExecutor internal migrationExecutor;
  MigrationSubsidy internal migrationSubsidy;
  bool internal freezeSourceForWithdrawals;

  function _setupOutbox() internal virtual override {
    wiredOutbox = IOutbox(address(new Outbox(address(rollup), ROLLUP_VERSION)));
  }

  function setUp() public virtual override {
    super.setUp();
    payoutToken = _separatePayoutToken()
      ? IERC20(address(new TestERC20("Payout", "PAY", address(this))))
      : IERC20(address(underlying));
    _buildDestination();
    migrationExecutor = new MigrationExecutor(
      IOxidePortal(address(portal)),
      IOxidePortal(address(destinationPortal)),
      IERC20OZ(address(payoutToken)),
      OWNER,
      keccak256(type(OperationExecutor).runtimeCode),
      ethUsdFeed
    );
    migrationSubsidy = migrationExecutor.SUBSIDY();
    _mintPayout(address(migrationSubsidy), SUBSIDY_POT);
    vm.prank(OWNER);
    migrationSubsidy.setConfig(0, type(uint128).max, MIN_MIGRATED_AMOUNT);

    (bytes32 messageHash, uint256 messageLeafIndex) = _unprocessedDepositMessage(1);
    _recordDeposit(messageHash, messageLeafIndex);
    _warmDestination();
    underlying.mint(address(portal), RELAY_PORTAL_FLOAT);
    if (_relayerHoldsToken()) {
      _mintPayout(MIGRATION_RELAYER, 1);
    }
    vm.fee(RELAY_GAS_PRICE);
    vm.txGasPrice(RELAY_GAS_PRICE);
    freezeSourceForWithdrawals = true;
  }

  function _separatePayoutToken() internal view virtual returns (bool) {
    return false;
  }

  function _relayerHoldsToken() internal view virtual returns (bool) {
    return true;
  }

  function _relayTip() internal view returns (uint256) {
    return _separatePayoutToken() ? 0 : MIGRATION_TIP;
  }

  function _mintPayout(address _to, uint256 _amount) internal {
    TestERC20(address(payoutToken)).mint(_to, _amount);
  }

  function _buildDestination() internal {
    destinationRollup = new MockRollup();
    destinationInbox = IInbox(
      address(new Inbox(address(destinationRollup), IERC20OZ(address(underlying)), DESTINATION_ROLLUP_VERSION, 512))
    );
    destinationRollup.setInbox(destinationInbox);
    destinationRollup.setOutbox(IOutbox(address(new MockOutbox())));
    registry.setRollup(DESTINATION_ROLLUP_VERSION, IHaveVersion(address(destinationRollup)));
    destinationPortal = new OxidePortal(
      teeRegistry,
      IERC20OZ(address(underlying)),
      IRegistry(address(registry)),
      DESTINATION_ROLLUP_VERSION,
      OxidePortal.RefundVerifiers({
        frozenNotes: IVerifier(address(new MockProofVerifier())),
        frozenDeposits: IVerifier(address(new MockProofVerifier())),
        unprocessedDeposit: IVerifier(address(new MockProofVerifier()))
      }),
      TX_AMOUNT_CAP,
      RATE,
      GLOBAL_LIMIT
    );
  }

  function _warmDestination() internal {
    vm.startPrank(USER);
    underlying.approve(address(destinationPortal), type(uint256).max);
    for (uint256 i = 0; i < DESTINATION_WARM_DEPOSITS; i++) {
      destinationPortal.deposit(bytes32(uint256(0xAA00 + i)), 1 ether);
    }
    vm.stopPrank();
  }

  function _openNextInboxBucket() internal {
    vm.warp(vm.getBlockTimestamp() + 12);
    vm.roll(vm.getBlockNumber() + 1);
  }

  function _migrationPayload(bytes32 _commitment, uint256 _tip) internal pure returns (bytes memory) {
    return abi.encode(_commitment, _tip);
  }

  function _migrationParams(bytes memory _payload, uint256 _amount) internal view returns (WithdrawParams memory p) {
    p = _defaultWithdrawParams();
    p.executor = address(migrationExecutor);
    p.userPayloadHash = Hash.sha256ToField(_payload);
    p.amount = _amount;
  }

  function _migrationWithdrawCall(bytes32 _commitment, uint256 _tip, address _tipRecipient, uint256 _depth)
    internal
    returns (bytes memory)
  {
    return _migrationWithdrawCallOf(
      address(migrationExecutor), _commitment, MIGRATION_AMOUNT, _tip, _tipRecipient, _depth, keccak256("migration")
    );
  }

  function _migrationWithdrawCallOf(
    address _executor,
    bytes32 _commitment,
    uint256 _amount,
    uint256 _tip,
    address _tipRecipient,
    uint256 _depth,
    bytes32 _withdrawalId
  ) internal returns (bytes memory) {
    bytes memory payload = _executor == address(migrationExecutor)
      ? _migrationPayload(_commitment, _tip)
      : abi.encode(address(uint160(uint256(_commitment))), _tip);
    WithdrawParams memory p = _migrationParams(payload, _amount);
    p.executor = _executor;
    p.proverTip = _amount > MIGRATION_PROVER_TIP ? MIGRATION_PROVER_TIP : 0;
    p.epochNumber = MIGRATION_WITHDRAWAL_EPOCH;
    p.leafIndex = 0;
    p.withdrawalId = _withdrawalId;
    _setCheckpoint(p.epochNumber);
    (bytes32[] memory path, bytes32 root) = _pathAndRoot(_messageHash(p), p.leafIndex, _depth);
    vm.prank(address(rollup));
    wiredOutbox.insert(Epoch.wrap(MIGRATION_WITHDRAWAL_EPOCH), MIGRATION_WITHDRAWAL_CHECKPOINTS, root);
    if (freezeSourceForWithdrawals) {
      _freezeSource();
    }
    return abi.encodeCall(
      IOxidePortal.withdraw,
      (IOxidePortal.WithdrawArgs({
          content: _content(p),
          userPayload: payload,
          relayerPayload: _relayerPayload(_tipRecipient),
          epochNumber: p.epochNumber,
          numCheckpointsInEpoch: MIGRATION_WITHDRAWAL_CHECKPOINTS,
          leafIndex: p.leafIndex,
          path: path,
          checkpointNumber: p.checkpointNumber,
          withdrawalId: p.withdrawalId,
          teeSignature: _signTee(teePk, _finalDigest(p))
        }))
    );
  }

  function _frozenNotesMigrationCall(
    uint256 _seed,
    bytes32 _commitment,
    uint256 _amount,
    uint256 _tip,
    address _tipRecipient,
    uint256 _notes
  ) internal view returns (bytes memory) {
    bytes memory payload = _migrationPayload(_commitment, _tip);
    WithdrawParams memory p = _migrationParams(payload, _amount);
    bytes32[] memory nullifiers = new bytes32[](_notes);
    for (uint256 i = 0; i < _notes; i++) {
      nullifiers[i] = _notesNullifier(_seed, i);
    }
    (bytes memory proof,) = _fixtureProof("frozen_notes_refund");
    return abi.encodeCall(
      IOxidePortal.refundFrozenNotes,
      (IOxidePortal.RefundFrozenNotesArgs({
          executor: p.executor,
          userPayload: payload,
          relayerPayload: _relayerPayload(_tipRecipient),
          amount: p.amount,
          nullifiers: nullifiers,
          proof: proof,
          teeSignature: _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers))
        }))
    );
  }

  function _frozenDepositMigrationCall(
    uint256 _seed,
    bytes32 _commitment,
    uint256 _amount,
    uint256 _tip,
    address _tipRecipient
  ) internal view returns (bytes memory) {
    bytes memory payload = _migrationPayload(_commitment, _tip);
    WithdrawParams memory p = _migrationParams(payload, _amount);
    bytes32[] memory nullifiers = new bytes32[](1);
    nullifiers[0] = _depositNullifier(_seed);
    (bytes memory proof,) = _fixtureProof("frozen_deposits_refund");
    return abi.encodeCall(
      IOxidePortal.refundFrozenDeposits,
      (IOxidePortal.RefundFrozenDepositsArgs({
          executor: p.executor,
          userPayload: payload,
          relayerPayload: _relayerPayload(_tipRecipient),
          amount: p.amount,
          nullifiers: nullifiers,
          proof: proof,
          teeSignature: _signTee(teePk, _frozenDepositsRefundFinalDigest(p, nullifiers))
        }))
    );
  }

  function _unprocessedDepositMigrationCall(
    uint256 _seed,
    bytes32 _commitment,
    uint256 _amount,
    uint256 _tip,
    address _tipRecipient
  ) internal view returns (bytes memory) {
    bytes memory payload = _migrationPayload(_commitment, _tip);
    WithdrawParams memory p = _migrationParams(payload, _amount);
    bytes32 siloedNullifier = _unprocessedNullifier(_seed);
    (bytes32 messageHash, uint256 messageLeafIndex) = _unprocessedDepositMessage(_seed);
    (bytes memory proof,) = _fixtureProof("unprocessed_deposit_refund");
    return abi.encodeCall(
      IOxidePortal.refundUnprocessedDeposit,
      (IOxidePortal.RefundUnprocessedDepositArgs({
          executor: p.executor,
          userPayload: payload,
          relayerPayload: _relayerPayload(_tipRecipient),
          amount: p.amount,
          siloedNullifier: siloedNullifier,
          messageHash: messageHash,
          messageLeafIndex: messageLeafIndex,
          proof: proof,
          teeSignature: _signTee(
            teePk, _unprocessedDepositRefundFinalDigest(p, messageHash, messageLeafIndex, siloedNullifier)
          )
        }))
    );
  }

  function _freezeForRefunds() internal {
    frozenNotesRefundVerifier.setAcceptAll(true);
    frozenDepositsRefundVerifier.setAcceptAll(true);
    unprocessedDepositRefundVerifier.setAcceptAll(true);
    _freezeSource();
  }

  function _freezeSource() internal {
    if (!portal.$frozen()) {
      _freeze();
    }
  }

  function _notesNullifier(uint256 _seed, uint256 _index) internal pure returns (bytes32) {
    return keccak256(abi.encode("migrationNotesNullifier", _seed, _index));
  }

  function _depositNullifier(uint256 _seed) internal pure returns (bytes32) {
    return keccak256(abi.encode("migrationDepositNullifier", _seed));
  }

  function _unprocessedNullifier(uint256 _seed) internal pure returns (bytes32) {
    return keccak256(abi.encode("migrationUnprocessedNullifier", _seed));
  }

  function _unprocessedDepositMessage(uint256 _seed) internal pure returns (bytes32 messageHash, uint256 leafIndex) {
    messageHash = keccak256(abi.encode("migrationUnprocessedMessage", _seed));
    leafIndex = 5000 + _seed;
  }

  function _relay(bytes memory _inner) internal returns (uint256 txGas, uint256 priced) {
    return _relayThrough(operationExecutor, MIGRATION_RELAYER, _inner);
  }

  function _relayThrough(OperationExecutor _executor, address _from, bytes memory _inner)
    internal
    returns (uint256 txGas, uint256 priced)
  {
    bytes memory outer =
      abi.encodeCall(OperationExecutor.execute, (address(migrationSubsidy), _inner, payoutToken, 0, 0, 0));
    uint256 potBefore = _pot();
    _coolEveryAccountOfTheRelay(address(_executor), _from);
    vm.prank(_from, _from);
    (bool ok, bytes memory ret) = address(_executor).call(outer);
    if (!ok) {
      assembly ("memory-safe") {
        revert(add(ret, 32), mload(ret))
      }
    }
    txGas = RelayerTransaction.lastTxGas(outer);
    priced = _pricedGasOf(potBefore - _pot());
  }

  function _assertPaysItsGas(string memory _label, uint256 _txGas, uint256 _priced) internal pure {
    console2.log(_label, "tx gas", _txGas);
    console2.log(_label, "priced", _priced);
    assertLe(_priced, _txGas, "the subsidy pays more gas than the relayer's transaction uses: a relayer farms it");
    assertGe(
      _priced + PRICED_MIGRATION_TOLERANCE, _txGas, "the subsidy pays less gas than a relayer spends on this migration"
    );
  }

  function _pricedGasOf(uint256 _paid) internal view returns (uint256) {
    return _pricedGasOf(migrationSubsidy, _paid);
  }

  function _pricedGasOf(MigrationSubsidy _subsidy, uint256 _paid) internal view returns (uint256) {
    (uint128 profit,,) = _subsidy.$config();
    if (_paid <= profit) {
      return 0;
    }
    return ((_paid - profit) * 1e18) / (RELAY_GAS_PRICE * _feedTokenWeiPerEth());
  }

  function _feedTokenWeiPerEth() internal view returns (uint256) {
    (, int256 usdPerEth,,,) = ethUsdFeed.latestRoundData();
    return (uint256(usdPerEth) * 1e18) / 10 ** ethUsdFeed.decimals();
  }

  function _pot() internal view returns (uint256) {
    return payoutToken.balanceOf(address(migrationSubsidy));
  }

  function _destinationBalance() internal view returns (uint256) {
    return underlying.balanceOf(address(destinationPortal));
  }

  function _coolEveryAccountOfTheRelay(address _operationExecutor, address _from) internal {
    address[20] memory touched = [
      address(portal),
      address(destinationPortal),
      address(underlying),
      address(payoutToken),
      address(wiredOutbox),
      address(wiredInbox),
      address(destinationInbox),
      address(rollup),
      address(destinationRollup),
      address(registry),
      address(teeRegistry),
      address(frozenNotesRefundVerifier),
      address(frozenDepositsRefundVerifier),
      address(unprocessedDepositRefundVerifier),
      address(migrationExecutor),
      address(migrationSubsidy),
      _operationExecutor,
      address(ethUsdFeed),
      _from,
      address(plainWithdrawalExecutor)
    ];
    for (uint256 i = 0; i < touched.length; i++) {
      VmCoolMigrationAccount(address(vm)).cool(touched[i]);
    }
  }

  function _pathAndRoot(bytes32 _leaf, uint256 _index, uint256 _depth)
    internal
    pure
    returns (bytes32[] memory path, bytes32 root)
  {
    path = _pathOfLength(_depth);
    bytes32 node = _leaf;
    uint256 index = _index;
    for (uint256 height = 0; height < _depth; height++) {
      node = (index & 1) == 1
        ? Hash.sha256ToField(bytes.concat(path[height], node))
        : Hash.sha256ToField(bytes.concat(node, path[height]));
      index >>= 1;
    }
    root = node;
  }

  function _fixtureProof(string memory _fixture)
    internal
    view
    returns (bytes memory proof, bytes32[] memory publicInputs)
  {
    string memory json = vm.readFile(string.concat("./test/fixtures/", _fixture, "_proof.json"));
    proof = vm.parseJsonBytes(json, ".proof");
    publicInputs = vm.parseJsonBytes32Array(json, ".publicInputs");
  }

  function _frozenNotesVerificationGas() internal virtual returns (uint256) {
    return _verificationGas(address(new FrozenNotesHonkVerifier()), "frozen_notes_refund");
  }

  function _frozenDepositVerificationGas() internal virtual returns (uint256) {
    return _verificationGas(address(new FrozenDepositsHonkVerifier()), "frozen_deposits_refund");
  }

  function _unprocessedDepositVerificationGas() internal virtual returns (uint256) {
    return _verificationGas(address(new UnprocessedDepositHonkVerifier()), "unprocessed_deposit_refund");
  }

  function _verificationGas(address _verifier, string memory _fixture) internal view returns (uint256) {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    bytes memory callData = abi.encodeCall(FrozenNotesHonkVerifier.verify, (proof, publicInputs));
    (bool ok, bytes memory ret) = _verifier.staticcall(callData);
    require(ok && abi.decode(ret, (bool)), "the refund verifier did not accept the fixture proof");
    Vm.Gas memory g = vm.lastCallGas();
    return uint256(g.gasTotalUsed);
  }
}
