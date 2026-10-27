// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Outbox} from "@aztec/core/messagebridge/Outbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";

import {HonkVerifier as FrozenNotesHonkVerifier} from "@generated/FrozenNotesRefundVerifier.sol";
import {HonkVerifier as FrozenDepositsHonkVerifier} from "@generated/FrozenDepositsRefundVerifier.sol";
import {HonkVerifier as UnprocessedDepositHonkVerifier} from "@generated/UnprocessedDepositRefundVerifier.sol";

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";

import {RelayedWithdrawal, VmCoolAccount} from "@test/periphery/RelayedWithdrawal.sol";

abstract contract RelayedExit is RelayedWithdrawal {
  uint256 internal constant RELAYED_REFUND_AMOUNT = 10 ether;
  uint256 internal constant RELAYED_REFUND_TIP = 1 ether;

  function _setupOutbox() internal virtual override {
    wiredOutbox = IOutbox(address(new Outbox(address(rollup), ROLLUP_VERSION)));
  }

  function setUp() public virtual override {
    plainWithdrawalFee = 0.1 ether;
    super.setUp();
    underlying.mint(address(plainWithdrawalSubsidy), 1_000_000 ether);
    vm.startPrank(OWNER);
    for (uint256 flow = 0; flow <= uint256(IExecutor.Flow.UnprocessedDepositRefund); flow++) {
      plainWithdrawalSubsidy.setFlowPricing(
        IExecutor.Flow(flow), PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: 1000 ether})
      );
    }
    vm.stopPrank();
    vm.fee(RELAY_GAS_PRICE);
    vm.txGasPrice(RELAY_GAS_PRICE);
  }

  function _relayFrozenNotesRefund(uint256 _notes) internal returns (uint256 chainGas, uint256 priced) {
    frozenNotesRefundVerifier.setAcceptAll(true);
    _freeze();
    (bytes memory inner, address recipient) =
      _frozenNotesRefundCall(1, RELAYED_REFUND_AMOUNT, RELAYED_REFUND_TIP, address(operationExecutor), _notes);
    uint256 txGas;
    (txGas, priced) = _relayExit(inner, recipient);
    chainGas = txGas + _verificationGas(address(new FrozenNotesHonkVerifier()), "frozen_notes_refund");
  }

  function _relayFrozenDepositsRefund() internal returns (uint256 chainGas, uint256 priced) {
    frozenDepositsRefundVerifier.setAcceptAll(true);
    _freeze();
    (bytes memory inner, address recipient) =
      _frozenDepositsRefundCall(1, RELAYED_REFUND_AMOUNT, RELAYED_REFUND_TIP, address(operationExecutor));
    uint256 txGas;
    (txGas, priced) = _relayExit(inner, recipient);
    chainGas = txGas + _verificationGas(address(new FrozenDepositsHonkVerifier()), "frozen_deposits_refund");
  }

  function _relayUnprocessedDepositRefund() internal returns (uint256 chainGas, uint256 priced) {
    unprocessedDepositRefundVerifier.setAcceptAll(true);
    (bytes32 messageHash, uint256 messageLeafIndex) = _unprocessedDepositMessage(1);
    _recordDeposit(messageHash, messageLeafIndex);
    _freeze();
    (bytes memory inner, address recipient) =
      _unprocessedDepositRefundCall(1, RELAYED_REFUND_AMOUNT, RELAYED_REFUND_TIP, address(operationExecutor));
    uint256 txGas;
    (txGas, priced) = _relayExit(inner, recipient);
    chainGas = txGas + _verificationGas(address(new UnprocessedDepositHonkVerifier()), "unprocessed_deposit_refund");
  }

  function _refundParams(address _recipient, uint256 _amount, uint256 _tip)
    internal
    view
    returns (WithdrawParams memory p)
  {
    p = _defaultWithdrawParams();
    p.recipient = _recipient;
    p.amount = _amount;
    p.processorTip = _tip;
    _syncPayloadHash(p);
  }

  function _frozenNotesRefundCall(uint256 _seed, uint256 _amount, uint256 _tip, address _tipRecipient, uint256 _notes)
    internal
    returns (bytes memory callData, address recipient)
  {
    recipient = address(uint160(uint256(keccak256(abi.encode("notesRecipient", _seed)))));
    WithdrawParams memory p = _refundParams(recipient, _amount, _tip);

    bytes32[] memory nullifiers = new bytes32[](_notes);
    for (uint256 i = 0; i < _notes; i++) {
      nullifiers[i] = keccak256(abi.encode("notesNullifier", _seed, i));
    }

    (bytes memory proof,) = _fixtureProof("frozen_notes_refund");
    _fund(address(portal), p.amount);

    callData = abi.encodeCall(
      IOxidePortal.refundFrozenNotes,
      (IOxidePortal.RefundFrozenNotesArgs({
          executor: p.executor,
          userPayload: _userPayload(p),
          relayerPayload: _relayerPayload(_tipRecipient),
          amount: p.amount,
          nullifiers: nullifiers,
          proof: proof,
          teeSignature: _signTee(teePk, _frozenNotesRefundFinalDigest(p, nullifiers))
        }))
    );
  }

  function _frozenDepositsRefundCall(uint256 _seed, uint256 _amount, uint256 _tip, address _tipRecipient)
    internal
    returns (bytes memory callData, address recipient)
  {
    recipient = address(uint160(uint256(keccak256(abi.encode("depositRecipient", _seed)))));
    WithdrawParams memory p = _refundParams(recipient, _amount, _tip);

    bytes32[] memory nullifiers = new bytes32[](1);
    nullifiers[0] = keccak256(abi.encode("depositNullifier", _seed));
    (bytes memory proof,) = _fixtureProof("frozen_deposits_refund");
    _fund(address(portal), p.amount);

    callData = abi.encodeCall(
      IOxidePortal.refundFrozenDeposits,
      (IOxidePortal.RefundFrozenDepositsArgs({
          executor: p.executor,
          userPayload: _userPayload(p),
          relayerPayload: _relayerPayload(_tipRecipient),
          amount: p.amount,
          nullifiers: nullifiers,
          proof: proof,
          teeSignature: _signTee(teePk, _frozenDepositsRefundFinalDigest(p, nullifiers))
        }))
    );
  }

  function _unprocessedDepositRefundCall(uint256 _seed, uint256 _amount, uint256 _tip, address _tipRecipient)
    internal
    returns (bytes memory callData, address recipient)
  {
    recipient = address(uint160(uint256(keccak256(abi.encode("unprocessedRecipient", _seed)))));
    WithdrawParams memory p = _refundParams(recipient, _amount, _tip);

    bytes32 siloedNullifier = keccak256(abi.encode("unprocessedNullifier", _seed));
    (bytes32 messageHash, uint256 messageLeafIndex) = _unprocessedDepositMessage(_seed);

    (bytes memory proof,) = _fixtureProof("unprocessed_deposit_refund");
    _fund(address(portal), p.amount);

    callData = abi.encodeCall(
      IOxidePortal.refundUnprocessedDeposit,
      (IOxidePortal.RefundUnprocessedDepositArgs({
          executor: p.executor,
          userPayload: _userPayload(p),
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

  function _unprocessedDepositMessage(uint256 _seed) internal pure returns (bytes32 messageHash, uint256 leafIndex) {
    messageHash = keccak256(abi.encode("unprocessedMessage", _seed));
    leafIndex = 5000 + _seed;
  }

  function _verificationGas(address _verifier, string memory _fixture) internal returns (uint256) {
    (bytes memory proof, bytes32[] memory publicInputs) = _fixtureProof(_fixture);
    bytes memory callData = abi.encodeCall(FrozenNotesHonkVerifier.verify, (proof, publicInputs));
    VmCoolAccount(address(vm)).cool(_verifier);
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

  function _fund(address _to, uint256 _amount) internal virtual override {
    underlying.mint(_to, _amount);
  }

  function _payoutToken() internal view virtual override returns (IERC20) {
    return IERC20(address(underlying));
  }
}
