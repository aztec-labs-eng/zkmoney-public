// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {PlainWithdrawalExecutor} from "@periphery/PlainWithdrawalExecutor.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IWithdrawalSubsidy} from "@periphery/interfaces/IWithdrawalSubsidy.sol";
import {Errors} from "@periphery/Errors.sol";

contract PlainWithdrawalExecutorTest is Test {
  TestERC20 internal asset;
  PlainWithdrawalExecutor internal executor;
  address internal constant PORTAL = address(0xA11CE);
  address internal constant RECIPIENT = address(0xBEEF);
  address internal constant TIP_RECIPIENT = address(0xCAFE);

  IExecutor.Flow internal constant WITHDRAWAL = IExecutor.Flow.Withdrawal;

  function setUp() external {
    asset = new TestERC20("Test", "TST", address(this));
    _mockPortal(PORTAL, address(asset));
    executor = new PlainWithdrawalExecutor(PORTAL);
  }

  function testExecutesCanonicalPayload() external {
    asset.mint(address(executor), 10 ether);
    vm.prank(PORTAL);
    executor.execute(WITHDRAWAL, 10 ether, abi.encode(RECIPIENT, 3 ether), abi.encode(TIP_RECIPIENT, address(0)));
    assertEq(asset.balanceOf(RECIPIENT), 7 ether);
    assertEq(asset.balanceOf(TIP_RECIPIENT), 3 ether);
  }

  function testPreservesDonation() external {
    asset.mint(address(executor), 12 ether);
    vm.prank(PORTAL);
    executor.execute(WITHDRAWAL, 10 ether, abi.encode(RECIPIENT, 0), abi.encode(address(0), address(0)));
    assertEq(asset.balanceOf(address(executor)), 2 ether);
  }

  function testRejectsNonCanonicalUserPayload() external {
    vm.prank(PORTAL);
    vm.expectRevert(Errors.PlainWithdrawalExecutor__InvalidUserPayload.selector);
    executor.execute(WITHDRAWAL, 0, hex"00", abi.encode(address(0), address(0)));
  }

  function testRejectsDirtyAddressPadding() external {
    bytes memory userPayload = abi.encode(bytes32(uint256(uint160(RECIPIENT)) | (uint256(1) << 160)), uint256(0));
    vm.prank(PORTAL);
    vm.expectRevert(Errors.PlainWithdrawalExecutor__InvalidUserPayload.selector);
    executor.execute(WITHDRAWAL, 0, userPayload, abi.encode(address(0), address(0)));
  }

  function testIncompatibleWithdrawalSubsidyRollsBack() external {
    asset.mint(address(executor), 10 ether);
    vm.prank(PORTAL);
    vm.expectRevert();
    executor.execute(WITHDRAWAL, 10 ether, abi.encode(RECIPIENT, 1 ether), abi.encode(TIP_RECIPIENT, PORTAL));
    assertEq(asset.balanceOf(address(executor)), 10 ether);
    assertEq(asset.balanceOf(RECIPIENT), 0);
    assertEq(asset.balanceOf(TIP_RECIPIENT), 0);
  }

  function testRejectsTipWithoutRecipient() external {
    asset.mint(address(executor), 10 ether);
    vm.prank(PORTAL);
    vm.expectRevert(Errors.PlainWithdrawalExecutor__ZeroTipRecipient.selector);
    executor.execute(WITHDRAWAL, 10 ether, abi.encode(RECIPIENT, 1 ether), abi.encode(address(0), address(0)));
  }

  function testForwardsZeroTipRecipientToTheWithdrawalSubsidy() external {
    RecordingSubsidy subsidy = new RecordingSubsidy();
    asset.mint(address(executor), 10 ether);
    vm.prank(PORTAL);
    executor.execute(WITHDRAWAL, 10 ether, abi.encode(RECIPIENT, 0), abi.encode(address(0), address(subsidy)));
    assertEq(asset.balanceOf(RECIPIENT), 10 ether);
    assertEq(subsidy.lastTipRecipient(), address(0));
  }

  function testRejectsNonPortalCaller() external {
    vm.expectRevert(Errors.PlainWithdrawalExecutor__UnauthorizedCaller.selector);
    executor.execute(WITHDRAWAL, 0, abi.encode(RECIPIENT, 0), abi.encode(address(0), address(0)));
  }

  function testForwardsTheCallingFlowToTheWithdrawalSubsidy() external {
    RecordingSubsidy subsidy = new RecordingSubsidy();
    asset.mint(address(executor), 10 ether);
    vm.prank(PORTAL);
    executor.execute(
      IExecutor.Flow.FrozenNotesRefund,
      10 ether,
      abi.encode(RECIPIENT, 1 ether),
      abi.encode(TIP_RECIPIENT, address(subsidy))
    );
    assertEq(uint256(subsidy.lastFlow()), uint256(IExecutor.Flow.FrozenNotesRefund));
    assertEq(subsidy.lastTipRecipient(), TIP_RECIPIENT);
  }

  function testRejectsPortalWithoutCode() external {
    vm.expectRevert(Errors.PlainWithdrawalExecutor__InvalidPortal.selector);
    new PlainWithdrawalExecutor(address(0));
  }

  function testAdoptsPortalUnderlying() external view {
    assertEq(address(executor.ASSET()), address(asset));
    assertEq(executor.PORTAL(), PORTAL);
  }

  function _mockPortal(address _portal, address _underlying) private {
    vm.etch(_portal, hex"00");
    vm.mockCall(_portal, abi.encodeWithSelector(IOxidePortal.UNDERLYING.selector), abi.encode(_underlying));
  }
}

contract RecordingSubsidy is IWithdrawalSubsidy {
  IExecutor.Flow public lastFlow;
  address public lastTipRecipient;

  function paySubsidy(IExecutor.Flow _flow, address _tipRecipient) external returns (uint256) {
    lastFlow = _flow;
    lastTipRecipient = _tipRecipient;
    return 0;
  }
}
