// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";

contract CoreAdapterHarness is CoreAdapter {}

contract CoreAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant BALANCE = 100e18;
  uint256 internal constant FIXED_AMOUNT = 40e18;
  uint256 internal constant ETH_BALANCE = 2 ether;
  uint256 internal constant ETH_FIXED_AMOUNT = 0.5 ether;

  TestERC20 internal token;
  CoreAdapterHarness internal adapter;
  address internal recipient = makeAddr("recipient");

  function setUp() external {
    token = new TestERC20("Token", "TKN", address(this));
    adapter = new CoreAdapterHarness();
  }

  function test_Erc20TransferOfMaxMovesTheWholeBalance() external {
    token.mint(address(adapter), BALANCE);

    adapter.erc20Transfer(token, MAX, recipient);

    assertEq(token.balanceOf(recipient), BALANCE);
    assertEq(token.balanceOf(address(adapter)), 0);
  }

  function test_Erc20TransferOfAFixedAmountLeavesTheRest() external {
    token.mint(address(adapter), BALANCE);

    adapter.erc20Transfer(token, FIXED_AMOUNT, recipient);

    assertEq(token.balanceOf(recipient), FIXED_AMOUNT);
    assertEq(token.balanceOf(address(adapter)), BALANCE - FIXED_AMOUNT);
  }

  function test_ATransferToAZeroRecipientReverts() external {
    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.erc20Transfer(token, MAX, address(0));

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.ethTransfer(MAX, address(0));
  }

  function test_EthTransferOfMaxMovesTheWholeBalance() external {
    vm.deal(address(adapter), ETH_BALANCE);

    adapter.ethTransfer(MAX, recipient);

    assertEq(recipient.balance, ETH_BALANCE);
    assertEq(address(adapter).balance, 0);
  }

  function test_EthTransferOfAFixedAmountLeavesTheRest() external {
    vm.deal(address(adapter), ETH_BALANCE);

    adapter.ethTransfer(ETH_FIXED_AMOUNT, recipient);

    assertEq(recipient.balance, ETH_FIXED_AMOUNT);
    assertEq(address(adapter).balance, ETH_BALANCE - ETH_FIXED_AMOUNT);
  }

  function test_ReceiveAcceptsEthFromAnySender() external {
    address[2] memory senders = [makeAddr("first-sender"), makeAddr("second-sender")];
    for (uint256 i = 0; i < senders.length; i++) {
      vm.deal(senders[i], 1 ether);
      vm.prank(senders[i]);
      (bool success,) = address(adapter).call{value: 1 ether}("");
      assertTrue(success);
    }

    assertEq(address(adapter).balance, 2 ether);
  }
}
