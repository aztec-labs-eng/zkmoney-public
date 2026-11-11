// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {AcrossAdapter} from "@periphery/adapters/AcrossAdapter.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {MockAcrossSpokePool} from "@test/mocks/MockAcrossSpokePool.sol";

contract AcrossAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT = 10e6;
  uint256 internal constant FIXED_AMOUNT = 4e6;
  uint256 internal constant FEE = 1e6;
  uint8 internal constant USDC_DECIMALS = 6;
  uint8 internal constant DAI_DECIMALS = 18;
  uint256 internal constant DAI_TO_USDC_SCALE = 10 ** (DAI_DECIMALS - USDC_DECIMALS);
  uint256 internal constant DESTINATION_CHAIN_ID = 8453;
  uint32 internal constant FILL_DEADLINE_OFFSET = 6 hours;
  bytes internal constant MESSAGE = "message";

  MintableToken internal usdc;
  MockAcrossSpokePool internal spokePool;
  AcrossAdapter internal adapter;
  address internal outputToken = makeAddr("outputToken");
  address internal recipient = makeAddr("recipient");
  address internal depositor = makeAddr("depositor");

  function setUp() external {
    usdc = new MintableToken("USDC", "USDC", USDC_DECIMALS);
    spokePool = new MockAcrossSpokePool();
    adapter = new AcrossAdapter(spokePool);
    usdc.mint(address(adapter), AMOUNT);
  }

  function test_MaxDepositsTheWholeBalance() external {
    adapter.acrossDeposit(_deposit(usdc, MAX, USDC_DECIMALS, recipient, depositor));

    MockAcrossSpokePool.Deposit memory deposit = spokePool.lastDeposit();
    assertEq(deposit.depositor, depositor);
    assertEq(deposit.recipient, recipient);
    assertEq(deposit.inputToken, address(usdc));
    assertEq(deposit.outputToken, outputToken);
    assertEq(deposit.inputAmount, AMOUNT);
    assertEq(deposit.outputAmount, AMOUNT - FEE);
    assertEq(deposit.destinationChainId, DESTINATION_CHAIN_ID);
    assertEq(deposit.exclusiveRelayer, address(0));
    assertEq(deposit.fillDeadlineOffset, FILL_DEADLINE_OFFSET);
    assertEq(deposit.exclusivityParameter, 0);
    assertEq(deposit.message, "");
    assertEq(usdc.balanceOf(address(spokePool)), AMOUNT);
    assertEq(usdc.balanceOf(address(adapter)), 0);
  }

  function test_AFixedAmountLeavesTheRestInTheAdapter() external {
    adapter.acrossDeposit(_deposit(usdc, FIXED_AMOUNT, USDC_DECIMALS, recipient, depositor));

    assertEq(spokePool.lastDeposit().inputAmount, FIXED_AMOUNT);
    assertEq(spokePool.lastDeposit().outputAmount, FIXED_AMOUNT - FEE);
    assertEq(usdc.balanceOf(address(spokePool)), FIXED_AMOUNT);
    assertEq(usdc.balanceOf(address(adapter)), AMOUNT - FIXED_AMOUNT);
  }

  function test_TheMessageVariantPassesTheMessage() external {
    adapter.acrossDepositWithMessage(
      AcrossAdapter.DepositWithMessage({
        inputToken: IERC20(address(usdc)),
        amount: MAX,
        destinationChainId: DESTINATION_CHAIN_ID,
        outputToken: outputToken,
        outputDecimals: USDC_DECIMALS,
        recipient: recipient,
        fee: FEE,
        depositor: depositor,
        fillDeadlineOffset: FILL_DEADLINE_OFFSET,
        message: MESSAGE
      })
    );

    MockAcrossSpokePool.Deposit memory deposit = spokePool.lastDeposit();
    assertEq(deposit.inputAmount, AMOUNT);
    assertEq(deposit.outputAmount, AMOUNT - FEE);
    assertEq(deposit.message, MESSAGE);
    assertEq(usdc.balanceOf(address(spokePool)), AMOUNT);
  }

  function test_TheOutputAmountIsScaledToTheOutputDecimals() external {
    adapter.acrossDeposit(_deposit(usdc, MAX, DAI_DECIMALS, recipient, depositor));
    assertEq(spokePool.lastDeposit().outputAmount, (AMOUNT - FEE) * DAI_TO_USDC_SCALE);

    MintableToken dai = new MintableToken("DAI", "DAI", DAI_DECIMALS);
    dai.mint(address(adapter), AMOUNT * DAI_TO_USDC_SCALE + 1);
    AcrossAdapter.Deposit memory deposit = _deposit(dai, MAX, USDC_DECIMALS, recipient, depositor);
    deposit.fee = FEE * DAI_TO_USDC_SCALE;
    adapter.acrossDeposit(deposit);
    assertEq(spokePool.lastDeposit().outputAmount, AMOUNT - FEE);
  }

  function test_AnAmountNotAboveTheFeeReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Errors.AcrossAdapter__AmountNotAboveFee.selector, FEE, FEE));
    adapter.acrossDeposit(_deposit(usdc, FEE, USDC_DECIMALS, recipient, depositor));
  }

  function test_AZeroRecipientReverts() external {
    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.acrossDeposit(_deposit(usdc, MAX, USDC_DECIMALS, address(0), depositor));

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.acrossDeposit(_deposit(usdc, MAX, USDC_DECIMALS, recipient, address(0)));
  }

  function _deposit(
    MintableToken _inputToken,
    uint256 _amount,
    uint8 _outputDecimals,
    address _recipient,
    address _depositor
  ) internal view returns (AcrossAdapter.Deposit memory) {
    return AcrossAdapter.Deposit({
      inputToken: IERC20(address(_inputToken)),
      amount: _amount,
      destinationChainId: DESTINATION_CHAIN_ID,
      outputToken: outputToken,
      outputDecimals: _outputDecimals,
      recipient: _recipient,
      fee: FEE,
      depositor: _depositor,
      fillDeadlineOffset: FILL_DEADLINE_OFFSET
    });
  }
}
