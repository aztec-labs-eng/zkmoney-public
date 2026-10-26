// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {FeeChargingExecutorBase} from "@periphery/FeeChargingExecutorBase.sol";
import {Errors} from "@periphery/Errors.sol";

contract FeeChargingExecutorBaseTest is Test {
  TestERC20 internal asset;
  FeeChargingExecutorBaseHarness internal executor;
  address internal constant PORTAL = address(0xA11CE);
  address internal constant BENEFICIARY = address(0xFEE);
  uint256 internal constant FEE = 1 ether;

  function setUp() external {
    asset = new TestERC20("Test", "TST", address(this));
    vm.etch(PORTAL, hex"00");
    vm.mockCall(PORTAL, abi.encodeWithSelector(IOxidePortal.UNDERLYING.selector), abi.encode(address(asset)));
    executor = new FeeChargingExecutorBaseHarness(PORTAL, FEE, BENEFICIARY);
  }

  function testAdoptsThePortalAndTheFeeTerms() external view {
    assertEq(executor.PORTAL(), PORTAL);
    assertEq(address(executor.ASSET()), address(asset));
    assertEq(executor.FEE(), FEE);
    assertEq(executor.BENEFICIARY(), BENEFICIARY);
  }

  function testRejectsAPortalWithoutCode() external {
    vm.expectRevert(Errors.FeeChargingExecutorBase__InvalidPortal.selector);
    new FeeChargingExecutorBaseHarness(address(0xDEAD), FEE, BENEFICIARY);
  }

  function testRejectsAFeeWithoutABeneficiary() external {
    vm.expectRevert(Errors.FeeChargingExecutorBase__ZeroBeneficiary.selector);
    new FeeChargingExecutorBaseHarness(PORTAL, FEE, address(0));
  }

  function testPaysTheFeeAndPassesTheRestToTheExecutor() external {
    asset.mint(address(executor), 10 ether);
    vm.prank(PORTAL);
    executor.execute(IExecutor.Flow.Withdrawal, 10 ether, hex"01", hex"02");
    assertEq(asset.balanceOf(BENEFICIARY), FEE);
    assertEq(executor.lastAmount(), 9 ether);
    assertEq(uint8(executor.lastFlow()), uint8(IExecutor.Flow.Withdrawal));
    assertEq(executor.lastUserPayload(), hex"01");
    assertEq(executor.lastRelayerPayload(), hex"02");
  }

  function testRejectsAWithdrawalThatTheFeeTakesWhole() external {
    uint256[3] memory amounts = [uint256(0), 0.4 ether, FEE];
    for (uint256 i = 0; i < amounts.length; i++) {
      asset.mint(address(executor), amounts[i]);
      vm.prank(PORTAL);
      vm.expectRevert(Errors.FeeChargingExecutorBase__AmountNotAboveFee.selector);
      executor.execute(IExecutor.Flow.Withdrawal, amounts[i], "", "");
    }
  }

  function testRejectsAZeroWithdrawalWithAZeroFee() external {
    FeeChargingExecutorBaseHarness free = new FeeChargingExecutorBaseHarness(PORTAL, 0, address(0));
    vm.prank(PORTAL);
    vm.expectRevert(Errors.FeeChargingExecutorBase__AmountNotAboveFee.selector);
    free.execute(IExecutor.Flow.Withdrawal, 0, "", "");
  }

  function testChargesNoFeeOnRefunds() external {
    IExecutor.Flow[3] memory refunds =
      [IExecutor.Flow.FrozenNotesRefund, IExecutor.Flow.FrozenDepositsRefund, IExecutor.Flow.UnprocessedDepositRefund];
    for (uint256 i = 0; i < refunds.length; i++) {
      asset.mint(address(executor), 10 ether);
      vm.prank(PORTAL);
      executor.execute(refunds[i], 10 ether, "", "");
      assertEq(executor.lastAmount(), 10 ether);
    }
    assertEq(asset.balanceOf(BENEFICIARY), 0);
  }

  function testChargesNothingWithAZeroFee() external {
    FeeChargingExecutorBaseHarness free = new FeeChargingExecutorBaseHarness(PORTAL, 0, address(0));
    asset.mint(address(free), 10 ether);
    vm.prank(PORTAL);
    free.execute(IExecutor.Flow.Withdrawal, 10 ether, "", "");
    assertEq(free.lastAmount(), 10 ether);
  }

  function testRejectsANonPortalCaller() external {
    vm.expectRevert(Errors.FeeChargingExecutorBase__UnauthorizedCaller.selector);
    executor.execute(IExecutor.Flow.Withdrawal, 0, "", "");
  }

  function testFuzzChargesTheWholeFeeFromEachAmountAboveIt(uint128 _amount) external {
    uint256 amount = bound(_amount, FEE + 1, type(uint128).max);
    asset.mint(address(executor), amount);
    vm.prank(PORTAL);
    executor.execute(IExecutor.Flow.Withdrawal, amount, "", "");
    assertEq(asset.balanceOf(BENEFICIARY), FEE);
    assertEq(executor.lastAmount(), amount - FEE);
  }
}

contract FeeChargingExecutorBaseHarness is FeeChargingExecutorBase {
  IExecutor.Flow public lastFlow;
  uint256 public lastAmount;
  bytes public lastUserPayload;
  bytes public lastRelayerPayload;
  uint256 public calls;

  constructor(address _portal, uint256 _fee, address _beneficiary)
    FeeChargingExecutorBase(_portal, _fee, _beneficiary)
  {}

  function _execute(IExecutor.Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    internal
    override
  {
    lastFlow = _flow;
    lastAmount = _amount;
    lastUserPayload = _userPayload;
    lastRelayerPayload = _relayerPayload;
    calls++;
  }
}
