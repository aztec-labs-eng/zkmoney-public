// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IProverSubsidy} from "@core/interfaces/IProverSubsidy.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";

contract CallbackExecutor is IExecutor {
  IERC20 private immutable asset;
  bytes private callback;
  bool public callbackSuccess;
  bool public approveDeposit;

  constructor(IERC20 _asset) {
    asset = _asset;
  }

  function configure(bytes calldata _callback, bool _approveDeposit) external {
    callback = _callback;
    approveDeposit = _approveDeposit;
  }

  function execute(IExecutor.Flow, uint256, bytes calldata, bytes calldata) external {
    if (approveDeposit) {
      asset.approve(msg.sender, type(uint256).max);
    }
    (callbackSuccess,) = msg.sender.call(callback);
  }
}

// solhint-disable oxide/no-comments
// `withdraw` hands control to an untrusted `IExecutor` after the funds leave the portal, so these tests pin down what
// that callee can call back into: every exit and state-critical entrypoint must be blocked by the re-entrancy guard,
// and `deposit` must stay open.
// solhint-enable oxide/no-comments
contract OxidePortalReentrancyTest is OxidePortalBase {
  CallbackExecutor private executor;

  function setUp() public override {
    super.setUp();
    executor = new CallbackExecutor(IERC20(address(underlying)));
  }

  function testExecutorCannotReenterWithdraw()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("callback-withdraw")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    IOxidePortal.WithdrawArgs memory args = _withdrawArgs(p, _dummyPath(), "");
    _withdrawWithCallback(p, abi.encodeCall(portal.withdraw, (args)), false);
  }

  function testExecutorCannotReenterFrozenNotesRefund()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("callback-frozen-notes")
  {
    bytes32[] memory nullifiers = new bytes32[](0);
    _withdrawWithCallback(
      _defaultWithdrawParams(),
      abi.encodeCall(
        portal.refundFrozenNotes, (IOxidePortal.RefundFrozenNotesArgs(address(0), "", "", 0, nullifiers, "", ""))
      ),
      false
    );
  }

  function testExecutorCannotReenterFrozenDepositRefund()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("callback-frozen-deposit")
  {
    _withdrawWithCallback(
      _defaultWithdrawParams(),
      abi.encodeCall(
        portal.refundFrozenDeposit, (IOxidePortal.RefundFrozenDepositArgs(address(0), "", "", 0, bytes32(0), "", ""))
      ),
      false
    );
  }

  function testExecutorCannotReenterUnprocessedDepositRefund()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("callback-unprocessed-deposit")
  {
    bytes32[] memory path = new bytes32[](0);
    _withdrawWithCallback(
      _defaultWithdrawParams(),
      abi.encodeCall(
        portal.refundUnprocessedDeposit,
        (IOxidePortal.RefundUnprocessedDepositArgs(address(0), "", "", 0, bytes32(0), bytes32(0), 0, path, "", ""))
      ),
      false
    );
  }

  function testExecutorCannotReenterProverClaims()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("callback-prover-claims")
  {
    IOxidePortal.ProverTipClaim[] memory claims = new IOxidePortal.ProverTipClaim[](0);
    _withdrawWithCallback(
      _defaultWithdrawParams(), abi.encodeCall(portal.claimProverTips, (IProverSubsidy(address(0)), claims)), false
    );
  }

  function testExecutorCannotReenterFreeze() external givenPortalIsInitialized givenTeeIsRegistered("callback-freeze") {
    _withdrawWithCallback(_defaultWithdrawParams(), abi.encodeCall(portal.freeze, ()), false);
  }

  function testExecutorCanDepositDuringWithdraw()
    external
    givenPortalIsInitialized
    givenTeeIsRegistered("callback-deposit")
  {
    WithdrawParams memory p = _defaultWithdrawParams();
    bytes32 commitment = bytes32(uint256(1));
    _withdrawWithCallback(p, abi.encodeCall(portal.deposit, (commitment, p.amount)), true);
    assertEq(underlying.balanceOf(address(portal)), p.amount);
  }

  function _withdrawWithCallback(WithdrawParams memory p, bytes memory callback, bool approveDeposit) private {
    p.executor = address(executor);
    p.userPayloadHash = Hash.sha256ToField(_userPayload(p));
    executor.configure(callback, approveDeposit);
    underlying.mint(address(portal), p.amount);
    _withdraw(p, _dummyPath(), _signTee(teePk, _finalDigest(p)));
    assertEq(executor.callbackSuccess(), approveDeposit);
  }

  function _withdrawArgs(WithdrawParams memory p, bytes32[] memory path, bytes memory signature)
    private
    view
    returns (IOxidePortal.WithdrawArgs memory)
  {
    return IOxidePortal.WithdrawArgs({
      content: _content(p),
      userPayload: _userPayload(p),
      relayerPayload: _relayerPayload(address(0), address(0)),
      epochNumber: p.epochNumber,
      numCheckpointsInEpoch: 1,
      leafIndex: p.leafIndex,
      path: path,
      checkpointNumber: p.checkpointNumber,
      withdrawalId: p.withdrawalId,
      teeSignature: signature
    });
  }
}
