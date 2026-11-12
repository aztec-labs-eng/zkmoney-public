// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {
  ERC7579Utils,
  Mode,
  ModeSelector,
  ModePayload
} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {UserOpAdapter} from "@periphery/adapters/UserOpAdapter.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";

contract UserOpAdapterTest is Test {
  uint256 internal constant PASSKEY = 12_345;
  uint192 internal constant KEY = 0xC0FFEE;
  uint256 internal constant VERIFICATION_GAS = 400_000;
  uint256 internal constant CALL_GAS = 400_000;
  bytes32 internal constant DATA_KEY = keccak256("data-key");
  bytes internal constant VALUE = hex"01";

  EntryPoint internal entryPoint;
  OxideAccount internal account;
  UserOpAdapter internal adapter;

  function setUp() external {
    entryPoint = EntryPoint(payable(address(ERC4337Utils.ENTRYPOINT_V08)));
    vm.etch(address(entryPoint), address(new EntryPoint()).code);
    account = OxideAccount(payable(new OxideAccountFactory().deploy(makeAddr("bootstrap"))));
    vm.prank(address(entryPoint));
    account.addAuthKey(_passkey(PASSKEY), "");
    adapter = new UserOpAdapter();
  }

  function test_APendingOpRunsAndTheNonceAdvances() external {
    UserOpAdapter.HandleUserOp memory step = _step(_nonce(KEY));

    adapter.handleUserOp(step);

    assertEq(account.getData(DATA_KEY), VALUE);
    assertEq(entryPoint.getNonce(address(account), KEY), _nonceAfterOne(KEY));
  }

  function test_AnOpThatAlreadyRanIsSkipped() external {
    UserOpAdapter.HandleUserOp memory step = _step(_nonce(KEY));
    _runDirectly(step);

    adapter.handleUserOp(step);

    assertEq(account.getData(DATA_KEY), VALUE);
    assertEq(entryPoint.getNonce(address(account), KEY), _nonceAfterOne(KEY));
  }

  function test_AnOpWhoseNonceIsAheadReverts() external {
    UserOpAdapter.HandleUserOp memory step = _step(_nonceAfterOne(KEY));

    vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA25 invalid account nonce"));
    adapter.handleUserOp(step);
  }

  function test_AnOpWhoseCallRevertsUsesTheNonceWithoutReverting() external {
    UserOpAdapter.HandleUserOp memory step = _step(_nonce(KEY));
    step.callData = _execute(_failingCall());
    step.signature = _sign(step, PASSKEY);

    adapter.handleUserOp(step);

    assertEq(account.getData(DATA_KEY), "");
    assertEq(entryPoint.getNonce(address(account), KEY), _nonceAfterOne(KEY));
  }

  function _nonce(uint192 _key) internal view returns (uint256) {
    return entryPoint.getNonce(address(account), _key);
  }

  function _nonceAfterOne(uint192 _key) internal pure returns (uint256) {
    return (uint256(_key) << 64) | 1;
  }

  function _step(uint256 _opNonce) internal view returns (UserOpAdapter.HandleUserOp memory step) {
    step = UserOpAdapter.HandleUserOp({
      sender: address(account),
      nonce: _opNonce,
      callData: _execute(_setData(DATA_KEY)),
      accountGasLimits: bytes32((VERIFICATION_GAS << 128) | CALL_GAS),
      signature: ""
    });
    step.signature = _sign(step, PASSKEY);
  }

  function _setData(bytes32 _dataKey) internal view returns (Execution[] memory batch) {
    batch = new Execution[](1);
    batch[0] = Execution(address(account), 0, abi.encodeCall(OxideAccount.setData, (_dataKey, VALUE)));
  }

  function _failingCall() internal view returns (Execution[] memory batch) {
    batch = new Execution[](1);
    batch[0] = Execution(address(adapter), 0, hex"12345678");
  }

  function _execute(Execution[] memory _batch) internal pure returns (bytes memory) {
    Mode mode = ERC7579Utils.encodeMode(
      ERC7579Utils.CALLTYPE_BATCH, ERC7579Utils.EXECTYPE_DEFAULT, ModeSelector.wrap(0x00000000), ModePayload.wrap(0x00)
    );
    return abi.encodeCall(ERC7821.execute, (Mode.unwrap(mode), abi.encode(_batch)));
  }

  function _userOp(UserOpAdapter.HandleUserOp memory _s) internal pure returns (PackedUserOperation memory op) {
    op.sender = _s.sender;
    op.nonce = _s.nonce;
    op.callData = _s.callData;
    op.accountGasLimits = _s.accountGasLimits;
    op.signature = _s.signature;
  }

  function _sign(UserOpAdapter.HandleUserOp memory _s, uint256 _privateKey) internal view returns (bytes memory) {
    return AccountSignatures.r1(0, _privateKey, entryPoint.getUserOpHash(_userOp(_s)));
  }

  function _passkey(uint256 _privateKey) internal pure returns (OxideAccount.R1Key memory) {
    (uint256 x, uint256 y) = vm.publicKeyP256(_privateKey);
    return OxideAccount.R1Key(bytes32(x), bytes32(y));
  }

  function _runDirectly(UserOpAdapter.HandleUserOp memory _s) internal {
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0] = _userOp(_s);
    entryPoint.handleOps(ops, payable(address(account)));
  }
}
