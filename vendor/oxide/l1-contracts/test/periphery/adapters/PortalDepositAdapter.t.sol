// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {PortalDepositAdapter} from "@periphery/adapters/PortalDepositAdapter.sol";

contract PortalDepositAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT = 10 ether;
  uint256 internal constant FIXED_AMOUNT = 4 ether;
  bytes32 internal constant RECIPIENT_COMMITMENT = keccak256("recipientCommitment");

  TestERC20 internal token;
  IOxidePortal internal portal = IOxidePortal(makeAddr("portal"));
  PortalDepositAdapter internal adapter;

  function setUp() external {
    token = new TestERC20("Test", "TST", address(this));
    adapter = new PortalDepositAdapter();
    token.mint(address(adapter), AMOUNT);
    vm.mockCall(address(portal), abi.encodeCall(IOxidePortal.UNDERLYING, ()), abi.encode(token));
    vm.mockCall(
      address(portal), abi.encodeWithSelector(IOxidePortal.deposit.selector), abi.encode(bytes32(0), uint256(0), 0)
    );
  }

  function test_MaxDepositsTheWholeBalanceToTheRecipientCommitment() external {
    vm.expectCall(address(portal), abi.encodeCall(IOxidePortal.deposit, (RECIPIENT_COMMITMENT, AMOUNT)));

    adapter.portalDeposit(portal, MAX, RECIPIENT_COMMITMENT);

    assertEq(token.allowance(address(adapter), address(portal)), AMOUNT);
  }

  function test_AFixedAmountDepositsOnlyThatAmount() external {
    vm.expectCall(address(portal), abi.encodeCall(IOxidePortal.deposit, (RECIPIENT_COMMITMENT, FIXED_AMOUNT)));

    adapter.portalDeposit(portal, FIXED_AMOUNT, RECIPIENT_COMMITMENT);

    assertEq(token.allowance(address(adapter), address(portal)), FIXED_AMOUNT);
  }
}
