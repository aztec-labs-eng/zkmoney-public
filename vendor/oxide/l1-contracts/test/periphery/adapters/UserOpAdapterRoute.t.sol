// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
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
import {MultiStepExecutor} from "@periphery/MultiStepExecutor.sol";
import {UserOpAdapter} from "@periphery/adapters/UserOpAdapter.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";
import {MultiStepExecutorTestBase} from "@test/periphery/MultiStepExecutorTestBase.sol";

contract UserOpAdapterRouteTest is MultiStepExecutorTestBase {
  uint256 internal constant USER_PASSKEY = 12_345;
  uint192 internal constant KEY = 0xC0FFEE;
  uint256 internal constant OP_GAS = 400_000;
  bytes32 internal constant DATA_KEY = keccak256("data-key");
  bytes internal constant VALUE = hex"01";

  EntryPoint internal entryPoint;
  OxideAccount internal account;
  UserOpAdapter internal adapter;
  address internal thirdParty = makeAddr("third-party");

  function setUp() public override {
    super.setUp();
    entryPoint = EntryPoint(payable(address(ERC4337Utils.ENTRYPOINT_V08)));
    vm.etch(address(entryPoint), address(new EntryPoint()).code);
    account = OxideAccount(payable(new OxideAccountFactory().deploy(makeAddr("user-bootstrap"))));
    (uint256 x, uint256 y) = vm.publicKeyP256(USER_PASSKEY);
    vm.prank(address(entryPoint));
    account.addAuthKey(OxideAccount.R1Key(bytes32(x), bytes32(y)), "");
    adapter = new UserOpAdapter();
  }

  function test_AWithdrawalRunsItsOpAndPaysOut() external {
    UserOpAdapter.HandleUserOp memory op = _signedOp();

    _relay(_opThenRemainderPayload(op), AMOUNT);

    assertEq(account.getData(DATA_KEY), VALUE);
    assertEq(dai.balanceOf(alice), NET);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function test_AThirdPartyThatRunsTheOpFirstDoesNotBlockTheWithdrawal() external {
    UserOpAdapter.HandleUserOp memory op = _signedOp();
    _runAsThirdParty(op);

    _relay(_opThenRemainderPayload(op), AMOUNT);

    assertEq(account.getData(DATA_KEY), VALUE);
    assertEq(dai.balanceOf(alice), NET);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function test_AThirdPartyThatRunsTheOpFirstDoesNotBlockAWithdrawalOfOnlyTheOp() external {
    UserOpAdapter.HandleUserOp memory op = _signedOp();
    _runAsThirdParty(op);

    _relay(_payload(TIP, _commitment(), address(0), _noTransfers(), _steps(_opStep(op))), TIP);

    assertEq(account.getData(DATA_KEY), VALUE);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function _opThenRemainderPayload(UserOpAdapter.HandleUserOp memory _op)
    internal
    view
    returns (MultiStepExecutor.UserPayload memory)
  {
    return _payload(TIP, _commitment(), alice, _noTransfers(), _steps(_opStep(_op)));
  }

  function _opStep(UserOpAdapter.HandleUserOp memory _op) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({target: address(adapter), data: abi.encodeCall(UserOpAdapter.handleUserOp, (_op))});
  }

  function _runAsThirdParty(UserOpAdapter.HandleUserOp memory _op) internal {
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0] = _packed(_op);
    vm.prank(thirdParty);
    entryPoint.handleOps(ops, payable(thirdParty));
    assertEq(account.getData(DATA_KEY), VALUE);
  }

  function _signedOp() internal view returns (UserOpAdapter.HandleUserOp memory op) {
    Execution[] memory batch = new Execution[](1);
    batch[0] = Execution(address(account), 0, abi.encodeCall(OxideAccount.setData, (DATA_KEY, VALUE)));
    Mode mode = ERC7579Utils.encodeMode(
      ERC7579Utils.CALLTYPE_BATCH, ERC7579Utils.EXECTYPE_DEFAULT, ModeSelector.wrap(0x00000000), ModePayload.wrap(0x00)
    );
    op = UserOpAdapter.HandleUserOp({
      sender: address(account),
      nonce: entryPoint.getNonce(address(account), KEY),
      callData: abi.encodeCall(ERC7821.execute, (Mode.unwrap(mode), abi.encode(batch))),
      accountGasLimits: bytes32((OP_GAS << 128) | OP_GAS),
      signature: ""
    });
    op.signature = AccountSignatures.r1(0, USER_PASSKEY, entryPoint.getUserOpHash(_packed(op)));
  }

  function _packed(UserOpAdapter.HandleUserOp memory _op) internal pure returns (PackedUserOperation memory packed) {
    packed.sender = _op.sender;
    packed.nonce = _op.nonce;
    packed.callData = _op.callData;
    packed.accountGasLimits = _op.accountGasLimits;
    packed.signature = _op.signature;
  }
}
