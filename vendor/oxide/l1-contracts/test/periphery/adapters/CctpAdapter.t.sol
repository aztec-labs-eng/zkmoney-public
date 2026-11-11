// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {CctpAdapter} from "@periphery/adapters/CctpAdapter.sol";
import {MockTokenMessengerV2} from "@test/mocks/MockTokenMessengerV2.sol";

contract CctpAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT = 10e6;
  uint256 internal constant FIXED_AMOUNT = 4e6;
  uint32 internal constant DESTINATION_DOMAIN = 6;
  uint256 internal constant MAX_FEE = 1e6;
  uint32 internal constant MIN_FINALITY_THRESHOLD = 1000;
  bytes32 internal constant MINT_RECIPIENT = keccak256("mintRecipient");
  bytes32 internal constant DESTINATION_CALLER = keccak256("destinationCaller");
  bytes internal constant HOOK_DATA = "hookData";

  TestERC20 internal usdc;
  MockTokenMessengerV2 internal tokenMessenger;
  CctpAdapter internal adapter;

  function setUp() external {
    usdc = new TestERC20("USDC", "USDC", address(this));
    tokenMessenger = new MockTokenMessengerV2();
    adapter = new CctpAdapter(tokenMessenger, usdc);
    usdc.mint(address(adapter), AMOUNT);
  }

  function test_MaxDepositsTheWholeBalance() external {
    adapter.cctpDeposit(MAX, DESTINATION_DOMAIN, MINT_RECIPIENT, MAX_FEE, MIN_FINALITY_THRESHOLD);

    MockTokenMessengerV2.Burn memory burn = tokenMessenger.lastBurn();
    assertEq(burn.amount, AMOUNT);
    assertEq(burn.destinationDomain, DESTINATION_DOMAIN);
    assertEq(burn.mintRecipient, MINT_RECIPIENT);
    assertEq(burn.burnToken, address(usdc));
    assertEq(burn.destinationCaller, bytes32(0));
    assertEq(burn.maxFee, MAX_FEE);
    assertEq(burn.minFinalityThreshold, MIN_FINALITY_THRESHOLD);
    assertEq(burn.hookData, "");
    assertEq(usdc.balanceOf(address(tokenMessenger)), AMOUNT);
    assertEq(usdc.balanceOf(address(adapter)), 0);
  }

  function test_AFixedAmountLeavesTheRestInTheAdapter() external {
    adapter.cctpDeposit(FIXED_AMOUNT, DESTINATION_DOMAIN, MINT_RECIPIENT, MAX_FEE, MIN_FINALITY_THRESHOLD);

    assertEq(tokenMessenger.lastBurn().amount, FIXED_AMOUNT);
    assertEq(usdc.balanceOf(address(tokenMessenger)), FIXED_AMOUNT);
    assertEq(usdc.balanceOf(address(adapter)), AMOUNT - FIXED_AMOUNT);
  }

  function test_TheHookVariantPassesTheDestinationCallerAndTheHookData() external {
    adapter.cctpDepositWithHook(
      MAX, DESTINATION_DOMAIN, MINT_RECIPIENT, DESTINATION_CALLER, MAX_FEE, MIN_FINALITY_THRESHOLD, HOOK_DATA
    );

    MockTokenMessengerV2.Burn memory burn = tokenMessenger.lastBurn();
    assertEq(burn.amount, AMOUNT);
    assertEq(burn.destinationCaller, DESTINATION_CALLER);
    assertEq(burn.hookData, HOOK_DATA);
    assertEq(usdc.balanceOf(address(tokenMessenger)), AMOUNT);
  }

  function test_AZeroRecipientReverts() external {
    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.cctpDeposit(MAX, DESTINATION_DOMAIN, bytes32(0), MAX_FEE, MIN_FINALITY_THRESHOLD);

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.cctpDepositWithHook(
      MAX, DESTINATION_DOMAIN, bytes32(0), DESTINATION_CALLER, MAX_FEE, MIN_FINALITY_THRESHOLD, HOOK_DATA
    );
  }
}
