// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {IMakerPsm} from "@periphery/interfaces/IMakerPsm.sol";
import {MakerPsmAdapter} from "@periphery/adapters/MakerPsmAdapter.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {MockMakerPsm} from "@test/mocks/MockMakerPsm.sol";

contract MakerPsmAdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT_IN = 1000e18;
  uint256 internal constant TO_18 = 1e12;
  uint256 internal constant TOUT = 1e15;
  uint256 internal constant FEE_GEM_OUT = 999_000_999;
  uint256 internal constant FIXED_AMOUNT_IN = 400e18;
  uint256 internal constant FIXED_GEM_OUT = 400e6;

  TestERC20 internal dai;
  MintableToken internal usdc;
  MockMakerPsm internal psm;
  MakerPsmAdapter internal adapter;
  address internal recipient = makeAddr("recipient");

  function setUp() external {
    dai = new TestERC20("DAI", "DAI", address(this));
    usdc = new MintableToken("USDC", "USDC", 6);
    psm = new MockMakerPsm(address(dai), address(usdc), usdc.decimals());
    usdc.mint(address(psm), 1_000_000e6);
    adapter = new MakerPsmAdapter();
  }

  function test_MaxSellsTheWholeBalanceAtPar() external {
    dai.mint(address(adapter), AMOUNT_IN);

    adapter.psmBuyGem(psm, MAX, 0, recipient);

    assertEq(usdc.balanceOf(recipient), AMOUNT_IN / TO_18);
    assertEq(dai.balanceOf(address(psm)), AMOUNT_IN);
    assertEq(dai.balanceOf(address(adapter)), 0);
  }

  function test_AFixedAmountLeavesTheRestInTheAdapter() external {
    dai.mint(address(adapter), AMOUNT_IN);

    adapter.psmBuyGem(psm, FIXED_AMOUNT_IN, 0, recipient);

    assertEq(usdc.balanceOf(recipient), FIXED_GEM_OUT);
    assertEq(dai.balanceOf(address(psm)), FIXED_AMOUNT_IN);
    assertEq(dai.balanceOf(address(adapter)), AMOUNT_IN - FIXED_AMOUNT_IN);
  }

  function test_AFeeLowersTheGemOutAndThePullStaysWithinTheAmountIn() external {
    vm.mockCall(address(psm), abi.encodeCall(IMakerPsm.tout, ()), abi.encode(TOUT));
    dai.mint(address(adapter), AMOUNT_IN);

    adapter.psmBuyGem(psm, MAX, 0, recipient);

    assertEq(usdc.balanceOf(recipient), FEE_GEM_OUT);
    assertLe(dai.balanceOf(address(psm)), AMOUNT_IN);
  }

  function test_AMinOutAboveTheOutputReverts() external {
    dai.mint(address(adapter), AMOUNT_IN);
    uint256 gemAmt = AMOUNT_IN / TO_18;

    vm.expectRevert(abi.encodeWithSelector(Errors.MakerPsmAdapter__InsufficientOutput.selector, gemAmt, gemAmt + 1));
    adapter.psmBuyGem(psm, MAX, gemAmt + 1, recipient);
  }

  function test_AZeroRecipientReverts() external {
    dai.mint(address(adapter), AMOUNT_IN);

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.psmBuyGem(psm, MAX, 0, address(0));
  }
}
