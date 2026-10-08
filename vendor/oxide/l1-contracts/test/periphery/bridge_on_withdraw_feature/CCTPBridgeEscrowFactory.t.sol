// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CCTPBridgeEscrow} from "@periphery/bridge_on_withdraw_feature/CCTPBridgeEscrow.sol";
import {CCTPBridgeEscrowFactory} from "@periphery/bridge_on_withdraw_feature/CCTPBridgeEscrowFactory.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {CCTPBridgeEscrowTestBase} from "./CCTPBridgeEscrowTestBase.sol";

contract CCTPBridgeEscrowFactoryTest is CCTPBridgeEscrowTestBase {
  uint32 internal constant STANDARD_FINALITY = 2000;

  function test_PredictionMatchesDeployAndGettersReturnCommittedArgs() external {
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_HYPERCORE_SPOT());
    address predicted = factory.predictEscrowAddress(args);

    address escrow = _fundAndDeploy(args, AMOUNT);

    assertEq(escrow, predicted);
    assertGt(escrow.code.length, 0);
    assertEq(CCTPBridgeEscrow(escrow).route(), args.route);
    assertEq(CCTPBridgeEscrow(escrow).destinationDomain(), args.destinationDomain);
    assertEq(CCTPBridgeEscrow(escrow).recipient(), alice);
    assertEq(CCTPBridgeEscrow(escrow).minFinalityThreshold(), FAST_FINALITY);
    assertEq(CCTPBridgeEscrow(escrow).maxFee(), MAX_FEE);
    assertEq(CCTPBridgeEscrow(escrow).recoveryCommitment(), args.recoveryCommitment);
    assertEq(CCTPBridgeEscrow(escrow).relayerTip(), TIP);
    assertEq(CCTPBridgeEscrow(escrow).nonce(), NONCE);
  }

  function test_EveryArgsFieldChangesTheAddress() external {
    CCTPBridgeEscrow.Args memory base = _args(implementation.ROUTE_DIRECT());
    address baseEscrow = factory.predictEscrowAddress(base);

    CCTPBridgeEscrow.Args memory changed = base;
    changed.route = implementation.ROUTE_HYPERCORE_SPOT();
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.destinationDomain = implementation.HYPEREVM_DOMAIN();
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.recipient = makeAddr("other");
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.minFinalityThreshold = STANDARD_FINALITY;
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.maxFee = MAX_FEE + 1;
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.recoveryCommitment =
      RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("other-salt"), address(account));
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.relayerTip = TIP + 1;
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.nonce = keccak256("other-nonce");
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);
  }

  function test_FundedDeployAndExecutePaysTipToCallerAndBurnsUsdc() external {
    address escrow = _fundAndDeploy(_args(implementation.ROUTE_DIRECT()), AMOUNT);

    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(tokenMessenger.lastBurn().amount, SWAPPED_USDC);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_ExecuteRevertsForNonFactoryCaller() external {
    address escrow = _fundAndDeploy(_args(implementation.ROUTE_DIRECT()), AMOUNT);

    vm.expectRevert(EscrowBase.EscrowBase__NotFactory.selector);
    CCTPBridgeEscrow(escrow).execute(address(this));
  }

  function test_ImplementationRevertsAsNotClone() external {
    vm.expectRevert(EscrowBase.EscrowBase__NotClone.selector);
    implementation.route();

    vm.prank(address(factory));
    vm.expectRevert(EscrowBase.EscrowBase__NotClone.selector);
    implementation.execute(address(this));
  }

  function test_ExecutorPathPaysRelayerTheTip() external {
    OperationExecutor executor = new OperationExecutor();
    CCTPBridgeEscrow.Args memory args = _args(implementation.ROUTE_DIRECT());
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    uint256 payout = executor.execute(
      address(factory), abi.encodeCall(CCTPBridgeEscrowFactory.deployAndExecute, (args)), IERC20(address(dai)), TIP
    );

    assertEq(payout, TIP);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(dai.balanceOf(address(executor)), 0);
    assertEq(tokenMessenger.lastBurn().amount, SWAPPED_USDC);
  }
}
