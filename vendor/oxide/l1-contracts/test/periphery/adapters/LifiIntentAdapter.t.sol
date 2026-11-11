// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {MultiStepExecutor} from "@periphery/MultiStepExecutor.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";
import {LifiIntentAdapter} from "@periphery/adapters/LifiIntentAdapter.sol";
import {ILifiInputSettlerEscrow, MandateOutput, StandardOrder} from "@periphery/interfaces/ILifiInputSettlerEscrow.sol";

contract LifiIntentAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT = 10 ether;
  uint256 internal constant FIXED_AMOUNT = 4 ether;
  uint256 internal constant NOW = 1_700_000_000;
  uint256 internal constant DESTINATION_CHAIN_ID = 8453;
  uint256 internal constant MIN_OUTPUT = 9e6;
  uint256 internal constant NONCE = 7;
  uint32 internal constant FILL_WINDOW = 1 hours;
  uint32 internal constant EXPIRY_WINDOW = 1 days;
  bytes32 internal constant OUTPUT_ORACLE = keccak256("outputOracle");
  bytes32 internal constant OUTPUT_SETTLER = keccak256("outputSettler");
  bytes32 internal constant OUTPUT_TOKEN = keccak256("outputToken");
  bytes32 internal constant RECIPIENT = keccak256("recipient");
  bytes internal constant CALLBACK_DATA = "callbackData";
  bytes internal constant CONTEXT = "context";

  TestERC20 internal token;
  ILifiInputSettlerEscrow internal settler = ILifiInputSettlerEscrow(makeAddr("settler"));
  LifiIntentAdapter internal adapter;
  address internal inputOracle = makeAddr("inputOracle");
  address internal refundRecipient = makeAddr("refundRecipient");
  HookStepAdapter internal stepAdapter = new HookStepAdapter();
  address internal stepRecipient = makeAddr("stepRecipient");
  address internal fallbackRecipient = makeAddr("fallbackRecipient");

  function setUp() external {
    vm.warp(NOW);
    token = new TestERC20("Test", "TST", address(this));
    adapter = new LifiIntentAdapter();
    token.mint(address(adapter), AMOUNT);
    vm.mockCall(address(settler), abi.encodeWithSelector(ILifiInputSettlerEscrow.open.selector), "");
  }

  function test_MaxOpensAnOrderForTheWholeBalance() external {
    vm.expectCall(address(settler), abi.encodeCall(ILifiInputSettlerEscrow.open, (_expectedOrder(AMOUNT, ""))));

    adapter.lifiOpen(_open(MAX, refundRecipient, RECIPIENT));

    assertEq(token.allowance(address(adapter), address(settler)), AMOUNT);
  }

  function test_AFixedAmountOpensAnOrderForOnlyThatAmount() external {
    vm.expectCall(address(settler), abi.encodeCall(ILifiInputSettlerEscrow.open, (_expectedOrder(FIXED_AMOUNT, ""))));

    adapter.lifiOpen(_open(FIXED_AMOUNT, refundRecipient, RECIPIENT));

    assertEq(token.allowance(address(adapter), address(settler)), FIXED_AMOUNT);
  }

  function test_TheFillHookPutsTheCallbackDataInTheOutput() external {
    vm.expectCall(
      address(settler), abi.encodeCall(ILifiInputSettlerEscrow.open, (_expectedOrder(AMOUNT, CALLBACK_DATA)))
    );

    adapter.lifiOpenWithHook(_openWithHook(MAX, CALLBACK_DATA));

    assertEq(token.allowance(address(adapter), address(settler)), AMOUNT);
  }

  function test_AZeroRecipientReverts() external {
    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.lifiOpen(_open(MAX, address(0), RECIPIENT));

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.lifiOpen(_open(MAX, refundRecipient, bytes32(0)));
  }

  function test_TheFillHookSendsTheOutputToTheRecipientAndRunsTheSteps() external {
    vm.prank(makeAddr("anyone"));
    adapter.outputFilled(_token32(), AMOUNT, _hook(_transferStep(MAX, stepRecipient)));

    assertEq(token.balanceOf(stepRecipient), AMOUNT);
    assertEq(token.balanceOf(fallbackRecipient), 0);
    assertEq(token.balanceOf(address(adapter)), 0);
    assertEq(token.balanceOf(address(stepAdapter)), 0);
  }

  function test_WhenAStepReverts_TheWholeOutputGoesToTheFallbackRecipient() external {
    vm.expectEmit(address(adapter));
    emit LifiIntentAdapter.HookFailed(abi.encodeWithSelector(Errors.CoreAdapter__ZeroRecipient.selector));

    adapter.outputFilled(_token32(), AMOUNT, _hook(_transferStep(MAX, address(0))));

    assertEq(token.balanceOf(fallbackRecipient), AMOUNT);
    assertEq(token.balanceOf(address(stepAdapter)), 0);
    assertEq(token.balanceOf(address(adapter)), 0);
  }

  function test_ANativeOutputIsForwardedToTheRecipient() external {
    vm.deal(address(adapter), AMOUNT);

    adapter.outputFilled(bytes32(0), AMOUNT, _hook(_ethTransferStep(stepRecipient)));

    assertEq(stepRecipient.balance, AMOUNT);
    assertEq(fallbackRecipient.balance, 0);
    assertEq(address(adapter).balance, 0);
  }

  function test_AZeroFallbackRecipientReverts() external {
    bytes memory executionData = abi.encode(address(stepAdapter), address(0), new MultiStepExecutor.Step[](0));

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.outputFilled(_token32(), AMOUNT, executionData);
  }

  function test_OnlyTheAdapterCanRunTheHook() external {
    vm.expectRevert(Errors.LifiIntentAdapter__NotSelf.selector);
    adapter.lifiRunHook(address(token), AMOUNT, stepRecipient, new MultiStepExecutor.Step[](0));
  }

  function _open(uint256 _amount, address _refundRecipient, bytes32 _recipient)
    internal
    view
    returns (LifiIntentAdapter.Open memory)
  {
    return LifiIntentAdapter.Open({
      token: token,
      amount: _amount,
      destinationChainId: DESTINATION_CHAIN_ID,
      inputSettler: settler,
      inputOracle: inputOracle,
      outputOracle: OUTPUT_ORACLE,
      outputSettler: OUTPUT_SETTLER,
      outputToken: OUTPUT_TOKEN,
      recipient: _recipient,
      minOutput: MIN_OUTPUT,
      refundRecipient: _refundRecipient,
      nonce: NONCE,
      fillWindow: FILL_WINDOW,
      expiryWindow: EXPIRY_WINDOW,
      context: CONTEXT
    });
  }

  function _openWithHook(uint256 _amount, bytes memory _callbackData)
    internal
    view
    returns (LifiIntentAdapter.OpenWithHook memory)
  {
    return LifiIntentAdapter.OpenWithHook({
      token: token,
      amount: _amount,
      destinationChainId: DESTINATION_CHAIN_ID,
      inputSettler: settler,
      inputOracle: inputOracle,
      outputOracle: OUTPUT_ORACLE,
      outputSettler: OUTPUT_SETTLER,
      outputToken: OUTPUT_TOKEN,
      recipient: RECIPIENT,
      minOutput: MIN_OUTPUT,
      refundRecipient: refundRecipient,
      nonce: NONCE,
      fillWindow: FILL_WINDOW,
      expiryWindow: EXPIRY_WINDOW,
      context: CONTEXT,
      callbackData: _callbackData
    });
  }

  function _expectedOrder(uint256 _amount, bytes memory _callbackData) internal view returns (StandardOrder memory) {
    uint256[2][] memory inputs = new uint256[2][](1);
    inputs[0] = [uint256(uint160(address(token))), _amount];
    MandateOutput[] memory outputs = new MandateOutput[](1);
    outputs[0] = MandateOutput({
      oracle: OUTPUT_ORACLE,
      settler: OUTPUT_SETTLER,
      chainId: DESTINATION_CHAIN_ID,
      token: OUTPUT_TOKEN,
      amount: MIN_OUTPUT,
      recipient: RECIPIENT,
      callbackData: _callbackData,
      context: CONTEXT
    });
    return StandardOrder({
      user: refundRecipient,
      nonce: NONCE,
      originChainId: block.chainid,
      expires: uint32(NOW) + EXPIRY_WINDOW,
      fillDeadline: uint32(NOW) + FILL_WINDOW,
      inputOracle: inputOracle,
      inputs: inputs,
      outputs: outputs
    });
  }

  function _token32() internal view returns (bytes32) {
    return bytes32(uint256(uint160(address(token))));
  }

  function _transferStep(uint256 _amount, address _recipient) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({
      target: address(stepAdapter), data: abi.encodeCall(CoreAdapter.erc20Transfer, (token, _amount, _recipient))
    });
  }

  function _hook(MultiStepExecutor.Step memory _step) internal view returns (bytes memory) {
    MultiStepExecutor.Step[] memory steps = new MultiStepExecutor.Step[](1);
    steps[0] = _step;
    return abi.encode(address(stepAdapter), fallbackRecipient, steps);
  }

  function _ethTransferStep(address _recipient) internal view returns (MultiStepExecutor.Step memory) {
    return MultiStepExecutor.Step({
      target: address(stepAdapter), data: abi.encodeCall(CoreAdapter.ethTransfer, (MAX, _recipient))
    });
  }
}

contract HookStepAdapter is CoreAdapter {}
