// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";

import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {HonkVerifier as FrozenNotesHonkVerifier} from "@generated/FrozenNotesRefundVerifier.sol";
import {HonkVerifier as FrozenDepositsHonkVerifier} from "@generated/FrozenDepositsRefundVerifier.sol";
import {HonkVerifier as UnprocessedDepositHonkVerifier} from "@generated/UnprocessedDepositRefundVerifier.sol";

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";

interface VmCool {
  function cool(address) external;
}

contract PlainWithdrawalSubsidyModeledTxGasTest is OxidePortalBase {
  uint256 internal constant INTRINSIC_TX_GAS = 21_000;
  uint256 internal constant DRIFT_FLOOR_PERCENT = 90;
  uint256 internal constant CHEAPEST_PATH_DEPTH = 0;

  uint256 internal constant CHEAPEST_WITHDRAWAL_EPOCH = 2;

  address internal constant RELAYER = address(0x9E14);

  function _setupOutbox() internal override {
    wiredOutbox = IOutbox(address(new Outbox(address(rollup), ROLLUP_VERSION)));
  }

  function setUp() public virtual override {
    super.setUp();
    underlying.mint(address(plainWithdrawalSubsidy), 1_000_000 ether);
    vm.startPrank(OWNER);
    plainWithdrawalSubsidy.setFlowPricing(
      IExecutor.Flow.Withdrawal, PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: 1000 ether})
    );
    plainWithdrawalSubsidy.setFlowPricing(
      IExecutor.Flow.FrozenNotesRefund, PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: 1000 ether})
    );
    plainWithdrawalSubsidy.setFlowPricing(
      IExecutor.Flow.FrozenDepositsRefund,
      PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: 1000 ether})
    );
    plainWithdrawalSubsidy.setFlowPricing(
      IExecutor.Flow.UnprocessedDepositRefund,
      PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: 1000 ether})
    );
    vm.stopPrank();
    vm.fee(4 gwei);
    vm.txGasPrice(4 gwei);
  }

  function test_GivenTheCheapestWithdrawal_ThenTheModelStaysUnderIt() external givenTeeIsRegistered("tee") {
    _freezeAtCheapestWithdrawalEpoch();
    _withdrawChainCostAtDepth(1, 0, 2, 1 ether);
    _withdrawChainCostAtDepth(2, 1, 2, 1 ether);
    uint256 measured = _cheaper(_withdrawChainCostAtDepth(3, 2, 2, 1 ether), _withdrawChainCostAtDepth(4, 3, 2, 1));
    measured = _cheaper(measured, _withdrawChainCostAtDepth(5, 0, CHEAPEST_PATH_DEPTH, 1 ether));
    _assertModels(IExecutor.Flow.Withdrawal, "withdrawal", measured);
  }

  function test_GivenTheCheapestFrozenNotesRefund_ThenTheModelStaysUnderIt() external givenTeeIsRegistered("tee") {
    frozenNotesRefundVerifier.setAcceptAll(true);
    _freeze();
    _frozenNotesRefundChainCost(1, 10 ether);
    _frozenNotesRefundChainCost(2, 10 ether);
    uint256 measured = _cheaper(_frozenNotesRefundChainCost(3, 10 ether), _frozenNotesRefundChainCost(4, 0))
      + _verificationGas(address(new FrozenNotesHonkVerifier()), "frozen_notes_refund");
    _assertModels(IExecutor.Flow.FrozenNotesRefund, "frozenNotesRefund", measured);
  }

  function test_GivenTheCheapestFrozenDepositsRefund_ThenTheModelStaysUnderIt() external givenTeeIsRegistered("tee") {
    frozenDepositsRefundVerifier.setAcceptAll(true);
    _freeze();
    _frozenDepositsRefundChainCost(1, 10 ether);
    _frozenDepositsRefundChainCost(2, 10 ether);
    uint256 measured = _cheaper(_frozenDepositsRefundChainCost(3, 10 ether), _frozenDepositsRefundChainCost(4, 0))
      + _verificationGas(address(new FrozenDepositsHonkVerifier()), "frozen_deposits_refund");
    _assertModels(IExecutor.Flow.FrozenDepositsRefund, "frozenDepositsRefund", measured);
  }

  function test_GivenTheCheapestUnprocessedDepositRefund_ThenTheModelStaysUnderIt()
    external
    givenTeeIsRegistered("tee")
  {
    unprocessedDepositRefundVerifier.setAcceptAll(true);
    for (uint256 seed = 1; seed <= 4; seed++) {
      (bytes32 messageHash, uint256 messageLeafIndex) = _unprocessedDepositMessage(seed);
      _recordDeposit(messageHash, messageLeafIndex);
    }
    _freeze();
    _unprocessedDepositRefundChainCost(1, 10 ether);
    _unprocessedDepositRefundChainCost(2, 10 ether);
    uint256 measured = _cheaper(
      _unprocessedDepositRefundChainCost(3, 10 ether), _unprocessedDepositRefundChainCost(4, 0)
    ) + _verificationGas(address(new UnprocessedDepositHonkVerifier()), "unprocessed_deposit_refund");
    _assertModels(IExecutor.Flow.UnprocessedDepositRefund, "unprocessedDepositRefund", measured);
  }

  function _cheaper(uint256 _a, uint256 _b) internal pure returns (uint256) {
    return _a < _b ? _a : _b;
  }

  function _assertModels(IExecutor.Flow _flow, string memory _label, uint256 _measured) internal view {
    uint256 priced = plainWithdrawalSubsidy.modeledTxGas(_flow);
    console2.log(_label, "measured chain cost", _measured);
    console2.log(_label, "priced by the model", priced);
    assertLe(
      priced, _measured, "the model pays more than the cheapest operation of this flow burns: the subsidy is farmable"
    );
    assertGe(
      priced,
      (_measured * DRIFT_FLOOR_PERCENT) / 100,
      "the model has drifted well under the cheapest operation: relayers are paid far less than it costs"
    );
  }

  function _verificationGas(address _verifier, string memory _fixture) internal returns (uint256) {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    bytes memory callData = abi.encodeCall(FrozenNotesHonkVerifier.verify, (proof, publicInputs));
    VmCool(address(vm)).cool(_verifier);
    (bool ok, bytes memory ret) = _verifier.staticcall(callData);
    require(ok && abi.decode(ret, (bool)), "the refund verifier did not accept the fixture proof");
    return _lastCallCost(callData) - _calldataGas(callData);
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

  function _freezeAtCheapestWithdrawalEpoch() internal {
    _setCheckpoint(CHEAPEST_WITHDRAWAL_EPOCH);
    vm.prank(address(rollup));
    wiredOutbox.insert(Epoch.wrap(CHEAPEST_WITHDRAWAL_EPOCH), 1, bytes32(uint256(1)));
    _freeze();
  }

  function _withdrawChainCostAtDepth(uint256 _seed, uint256 _leafIndex, uint256 _depth, uint256 _amount)
    internal
    returns (uint256)
  {
    address recipient = address(uint160(uint256(keccak256(abi.encode("withdrawalRecipient", _seed)))));

    WithdrawParams memory p = _defaultWithdrawParams();
    p.recipient = recipient;
    p.amount = _amount;
    p.processorTip = p.amount;
    p.epochNumber = CHEAPEST_WITHDRAWAL_EPOCH;
    p.leafIndex = _leafIndex;
    p.withdrawalId = bytes32(_seed);
    _syncPayloadHash(p);

    (bytes32[] memory path, bytes32 root) = _pathAndRoot(_messageHash(p), _leafIndex, _depth);
    vm.prank(address(rollup));
    wiredOutbox.insert(Epoch.wrap(p.epochNumber), 1, root);

    underlying.mint(address(portal), p.amount);

    bytes memory callData = abi.encodeCall(
      IOxidePortal.withdraw,
      (IOxidePortal.WithdrawArgs({
          content: _content(p),
          userPayload: _userPayload(p),
          relayerPayload: _relayerPayload(RELAYER),
          epochNumber: p.epochNumber,
          numCheckpointsInEpoch: 1,
          leafIndex: p.leafIndex,
          path: path,
          checkpointNumber: p.checkpointNumber,
          withdrawalId: p.withdrawalId,
          teeSignature: _signTee(teePk, _finalDigest(p))
        }))
    );
    return _chainCostOfPortalCall(callData, recipient);
  }

  function _frozenNotesRefundChainCost(uint256 _seed, uint256 _amount) internal returns (uint256) {
    address recipient = address(uint160(uint256(keccak256(abi.encode("notesRecipient", _seed)))));

    WithdrawParams memory p = _defaultWithdrawParams();
    p.recipient = recipient;
    p.amount = _amount;
    p.processorTip = p.amount;
    _syncPayloadHash(p);

    bytes32[] memory nullifiers = new bytes32[](1);
    nullifiers[0] = keccak256(abi.encode("notesNullifier", _seed));

    (bytes memory proof,) = _fixtureProof("frozen_notes_refund");
    underlying.mint(address(portal), p.amount);

    bytes memory callData = abi.encodeCall(
      IOxidePortal.refundFrozenNotes,
      (IOxidePortal.RefundFrozenNotesArgs({
          executor: p.executor,
          userPayload: _userPayload(p),
          relayerPayload: _relayerPayload(RELAYER),
          amount: p.amount,
          nullifiers: nullifiers,
          proof: proof,
          teeSignature: _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers))
        }))
    );
    return _chainCostOfPortalCall(callData, recipient);
  }

  function _frozenDepositsRefundChainCost(uint256 _seed, uint256 _amount) internal returns (uint256) {
    address recipient = address(uint160(uint256(keccak256(abi.encode("depositRecipient", _seed)))));

    WithdrawParams memory p = _defaultWithdrawParams();
    p.recipient = recipient;
    p.amount = _amount;
    p.processorTip = p.amount;
    _syncPayloadHash(p);

    bytes32 siloedNullifier = keccak256(abi.encode("depositNullifier", _seed));
    (bytes memory proof,) = _fixtureProof("frozen_deposits_refund");
    underlying.mint(address(portal), p.amount);

    bytes memory callData = abi.encodeCall(
      IOxidePortal.refundFrozenDeposits,
      (IOxidePortal.RefundFrozenDepositsArgs({
          executor: p.executor,
          userPayload: _userPayload(p),
          relayerPayload: _relayerPayload(RELAYER),
          amount: p.amount,
          nullifiers: _oneNullifier(siloedNullifier),
          proof: proof,
          teeSignature: _signTee(teePk, _frozenDepositsRefundFinalDigest(p, siloedNullifier))
        }))
    );
    return _chainCostOfPortalCall(callData, recipient);
  }

  function _unprocessedDepositRefundChainCost(uint256 _seed, uint256 _amount) internal returns (uint256) {
    address recipient = address(uint160(uint256(keccak256(abi.encode("unprocessedRecipient", _seed)))));

    WithdrawParams memory p = _defaultWithdrawParams();
    p.recipient = recipient;
    p.amount = _amount;
    p.processorTip = p.amount;
    _syncPayloadHash(p);

    bytes32 siloedNullifier = keccak256(abi.encode("unprocessedNullifier", _seed));
    (bytes32 messageHash, uint256 messageLeafIndex) = _unprocessedDepositMessage(_seed);

    (bytes memory proof,) = _fixtureProof("unprocessed_deposit_refund");
    underlying.mint(address(portal), p.amount);

    bytes memory callData = abi.encodeCall(
      IOxidePortal.refundUnprocessedDeposit,
      (IOxidePortal.RefundUnprocessedDepositArgs({
          executor: p.executor,
          userPayload: _userPayload(p),
          relayerPayload: _relayerPayload(RELAYER),
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
    return _chainCostOfPortalCall(callData, recipient);
  }

  function _unprocessedDepositMessage(uint256 _seed)
    internal
    pure
    returns (bytes32 messageHash, uint256 messageLeafIndex)
  {
    messageHash = keccak256(abi.encode("unprocessedMessage", _seed));
    messageLeafIndex = 5000 + _seed;
  }

  function _chainCostOfPortalCall(bytes memory _callData, address _recipient) internal returns (uint256) {
    _coolEveryAccountARelayerTouches(_recipient);
    vm.prank(RELAYER, RELAYER);
    (bool ok, bytes memory ret) = address(portal).call(_callData);
    if (!ok) {
      console2.logBytes(ret);
      revert("the metered portal call reverted");
    }
    return _lastCallCost(_callData) + INTRINSIC_TX_GAS;
  }

  function _coolEveryAccountARelayerTouches(address _recipient) internal {
    address[10] memory touched = [
      address(portal),
      address(teeRegistry),
      address(underlying),
      address(wiredOutbox),
      address(wiredInbox),
      address(rollup),
      address(plainWithdrawalExecutor),
      address(plainWithdrawalSubsidy),
      RELAYER,
      _recipient
    ];
    for (uint256 i = 0; i < touched.length; i++) {
      VmCool(address(vm)).cool(touched[i]);
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

  function _calldataGas(bytes memory _data) internal pure returns (uint256 total) {
    for (uint256 i = 0; i < _data.length; i++) {
      total += _data[i] == 0 ? 4 : 16;
    }
  }

  function _lastCallCost(bytes memory _callData) internal returns (uint256) {
    Vm.Gas memory g = vm.lastCallGas();
    uint256 burnt = uint256(g.gasTotalUsed);
    uint256 refunded = uint256(int256(g.gasRefunded));
    return _calldataGas(_callData) + burnt - (refunded < burnt / 5 ? refunded : burnt / 5);
  }
}
