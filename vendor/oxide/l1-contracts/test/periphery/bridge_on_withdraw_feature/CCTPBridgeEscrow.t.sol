// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {CCTPBridgeEscrow} from "@periphery/bridge_on_withdraw_feature/CCTPBridgeEscrow.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";
import {MockTokenMessengerV2} from "@test/mocks/MockTokenMessengerV2.sol";
import {CCTPBridgeEscrowTestBase} from "./CCTPBridgeEscrowTestBase.sol";

contract CCTPBridgeEscrowTest is CCTPBridgeEscrowTestBase {
  uint256 internal constant USDC_MIN_OUT = 2_450_250_000;
  uint256 internal constant USDC_MIN_OUT_RATE = 99e4;

  bytes32 internal constant RECOVERY_NONCE = keccak256("recovery-nonce");
  address internal target = makeAddr("recovery-target");
  uint256 internal deadline;

  function setUp() public override {
    super.setUp();
    deadline = block.timestamp + 1 days;
  }

  function test_DirectRouteBurnsSwappedUsdcToRecipientWithForwardHook() external {
    address escrow = _fundAndDeploy(_args(implementation.ROUTE_DIRECT()), AMOUNT);

    MockTokenMessengerV2.Burn memory burn = tokenMessenger.lastBurn();
    assertEq(burn.sender, escrow);
    assertEq(burn.amount, SWAPPED_USDC);
    assertEq(burn.destinationDomain, BASE_DOMAIN);
    assertEq(burn.mintRecipient, bytes32(uint256(uint160(alice))));
    assertEq(burn.burnToken, address(usdc));
    assertEq(burn.destinationCaller, bytes32(0));
    assertEq(burn.maxFee, MAX_FEE);
    assertEq(burn.minFinalityThreshold, FAST_FINALITY);
    assertEq(burn.hookData, hex"636374702d666f72776172640000000000000000000000000000000000000000");
    assertEq(usdc.balanceOf(address(tokenMessenger)), SWAPPED_USDC);
    assertEq(usdc.balanceOf(escrow), 0);
  }

  function test_HyperCoreSpotRouteBurnsToForwarderWithRecipientInHook() external {
    _fundAndDeploy(_args(implementation.ROUTE_HYPERCORE_SPOT()), AMOUNT);

    MockTokenMessengerV2.Burn memory burn = tokenMessenger.lastBurn();
    bytes32 forwarder = bytes32(uint256(uint160(hyperEvmCctpForwarder)));
    assertEq(burn.destinationDomain, implementation.HYPEREVM_DOMAIN());
    assertEq(burn.mintRecipient, forwarder);
    assertEq(burn.destinationCaller, forwarder);
    assertEq(
      burn.hookData,
      abi.encodePacked(
        hex"636374702d666f7277617264000000000000000000000000", hex"00000000", hex"00000018", alice, hex"ffffffff"
      )
    );
  }

  function test_UsdcOutputExactlyAtMinOutBurns() external {
    threePool.setRate(address(usdc), USDC_MIN_OUT_RATE);
    _fundAndDeploy(_args(implementation.ROUTE_DIRECT()), AMOUNT);

    assertEq(tokenMessenger.lastBurn().amount, USDC_MIN_OUT);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function test_UsdcOutputOneUnitBelowMinOutReverts() external {
    threePool.setRate(address(usdc), USDC_MIN_OUT_RATE - 1);
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_DIRECT());
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.prank(relayer);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    factory.deployAndExecute(args);
  }

  function test_SwapMinOutMissRevertsAndLeavesFundsInPlace() external {
    threePool.setRate(address(usdc), 5e5);
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_DIRECT());
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert("Exchange resulted in fewer coins than expected");
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(tokenMessenger.burnCount(), 0);
  }

  function test_BurnFailureThenSignedRecoveryMovesFullBalance() external {
    vm.mockCallRevert(
      address(tokenMessenger), abi.encodeWithSelector(ITokenMessengerV2.depositForBurnWithHook.selector), "burn failed"
    );
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_DIRECT());
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(bytes("burn failed"));
    factory.deployAndExecute(args);
    assertEq(escrow.code.length, 0);

    vm.prank(makeAddr("anyone"));
    assertEq(factory.deploy(args), escrow);
    assertGt(escrow.code.length, 0);

    bytes memory signature = _signRecoverERC20(escrow, target, address(dai), RECOVERY_NONCE, deadline);
    vm.expectEmit(true, true, true, true, escrow);
    emit EscrowBase.EscrowRecovered(address(dai), target, AMOUNT);
    vm.prank(makeAddr("anyone"));
    CCTPBridgeEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(dai), RECOVERY_NONCE, deadline);

    assertEq(dai.balanceOf(target), AMOUNT);
    assertEq(dai.balanceOf(escrow), 0);
    assertTrue(CCTPBridgeEscrow(escrow).usedNonces(RECOVERY_NONCE));
  }

  function test_UnknownRouteReverts() external {
    CCTPBridgeEscrow.Args memory args = _args(2);
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(CCTPBridgeEscrow.CCTPBridgeEscrow__UnknownRoute.selector, 2));
    factory.deployAndExecute(args);
  }

  function test_BalanceExactlyTipDeployIsNoOp() external {
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_DIRECT());
    address escrow = _fundAndDeploy(args, TIP);

    assertEq(escrow, factory.predictEscrowAddress(args));
    assertEq(escrow.code.length, 0);
    assertEq(threePool.callCount(), 0);
    assertEq(tokenMessenger.burnCount(), 0);
    assertEq(dai.balanceOf(relayer), 0);
    assertEq(dai.balanceOf(escrow), TIP);
  }

  function test_BalanceOneWeiAboveTipSwapsAndRevertsBelowMaxFee() external {
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_DIRECT());
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, TIP + 1);

    vm.prank(relayer);
    vm.expectRevert(
      abi.encodeWithSelector(CCTPBridgeEscrow.CCTPBridgeEscrow__AmountNotAboveMaxFee.selector, 0, MAX_FEE)
    );
    factory.deployAndExecute(args);

    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), TIP + 1);
    assertEq(tokenMessenger.burnCount(), 0);
  }

  function test_HyperCoreSpotRouteRevertsOffTheHyperEvmDomain() external {
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_HYPERCORE_SPOT());
    args.destinationDomain = BASE_DOMAIN;
    dai.mint(factory.predictEscrowAddress(args), AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(CCTPBridgeEscrow.CCTPBridgeEscrow__NotHyperEvmDomain.selector, BASE_DOMAIN));
    factory.deployAndExecute(args);
  }

  function test_HyperCoreSpotRouteRevertsOnZeroRecipientAndLeavesFundsInPlace() external {
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_HYPERCORE_SPOT());
    args.recipient = address(0);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(CCTPBridgeEscrow.CCTPBridgeEscrow__ZeroRecipient.selector);
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(tokenMessenger.burnCount(), 0);
  }

  function test_UsdcOneUnitAboveMaxFeeBurns() external {
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_DIRECT());
    args.maxFee = SWAPPED_USDC - 1;
    _fundAndDeploy(args, AMOUNT);

    assertEq(tokenMessenger.lastBurn().amount, SWAPPED_USDC);
    assertEq(tokenMessenger.lastBurn().maxFee, SWAPPED_USDC - 1);
    assertEq(dai.balanceOf(relayer), TIP);
  }

  function test_UsdcExactlyAtMaxFeeRevertsAndLeavesFundsInPlace() external {
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_DIRECT());
    args.maxFee = SWAPPED_USDC;
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    vm.expectRevert(
      abi.encodeWithSelector(
        CCTPBridgeEscrow.CCTPBridgeEscrow__AmountNotAboveMaxFee.selector, SWAPPED_USDC, SWAPPED_USDC
      )
    );
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(tokenMessenger.burnCount(), 0);
  }
}
