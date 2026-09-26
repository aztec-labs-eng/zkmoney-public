// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Errors} from "@periphery/Errors.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {SwapEscrow} from "@periphery/swap_on_withdraw_feature/SwapEscrow.sol";
import {SwapEscrowFactory} from "@periphery/swap_on_withdraw_feature/SwapEscrowFactory.sol";
import {SwapEscrowTestBase} from "./SwapEscrowTestBase.sol";

contract SwapEscrowFactoryTest is SwapEscrowTestBase {
  function test_PredictionMatchesDeployAndGettersReturnCommittedArgs() external {
    SwapEscrow.Args memory args = _args(1);
    address predicted = factory.predictEscrowAddress(args);

    address escrow = _fundAndDeploy(args, AMOUNT);

    assertEq(escrow, predicted);
    assertGt(escrow.code.length, 0);
    assertEq(SwapEscrow(escrow).route(), 1);
    assertEq(SwapEscrow(escrow).recipient(), alice);
    assertEq(SwapEscrow(escrow).recoveryCommitment(), _args(0).recoveryCommitment);
    assertEq(SwapEscrow(escrow).relayerTip(), TIP);
    assertEq(SwapEscrow(escrow).nonce(), NONCE);
  }

  function test_EveryArgsFieldChangesTheAddress() external {
    SwapEscrow.Args memory base = _args(0);
    address baseEscrow = factory.predictEscrowAddress(base);

    SwapEscrow.Args memory changed = base;
    changed.route = 1;
    address routeEscrow = factory.predictEscrowAddress(changed);

    changed = base;
    changed.recipient = makeAddr("other");
    address recipientEscrow = factory.predictEscrowAddress(changed);

    changed = base;
    changed.recoveryCommitment =
      RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("other-salt"), address(account));
    address recoveryEscrow = factory.predictEscrowAddress(changed);

    changed = base;
    changed.relayerTip = TIP + 1;
    address tipEscrow = factory.predictEscrowAddress(changed);

    changed = base;
    changed.nonce = keccak256("other-nonce");
    address nonceEscrow = factory.predictEscrowAddress(changed);

    assertNotEq(routeEscrow, baseEscrow);
    assertNotEq(recipientEscrow, baseEscrow);
    assertNotEq(recoveryEscrow, baseEscrow);
    assertNotEq(tipEscrow, baseEscrow);
    assertNotEq(nonceEscrow, baseEscrow);
  }

  function test_PredictionMatchesOZClonesLibrary() external view {
    SwapEscrow.Args memory args = _args(2);
    address predicted = Clones.predictDeterministicAddressWithImmutableArgs(
      factory.IMPLEMENTATION(), abi.encode(args), bytes32(0), address(factory)
    );
    assertEq(factory.predictEscrowAddress(args), predicted);
  }

  function test_BalanceBelowTipDeployAndExecuteIsNoOp() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = _fundAndDeploy(args, TIP - 1);

    assertEq(escrow, factory.predictEscrowAddress(args));
    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), TIP - 1);
    assertEq(dai.balanceOf(relayer), 0);
  }

  function test_ZeroBalanceZeroTipDeployAndExecuteIsNoOp() external {
    SwapEscrow.Args memory args = _args(0);
    args.relayerTip = 0;

    vm.prank(relayer);
    address escrow = factory.deployAndExecute(args);

    assertEq(escrow.code.length, 0);
    assertEq(usdc.balanceOf(alice), 0);
  }

  function test_FundedDeployAndExecutePaysTipToCallerAndUsdcToRecipient() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.expectEmit(true, true, true, true, address(factory));
    emit SwapEscrowFactory.SwapEscrowExecuted(escrow, relayer);
    vm.prank(relayer);
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(usdc.balanceOf(alice), ((AMOUNT - TIP) * USDC_RATE) / 1e18);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_FundedDeployAndExecutePaysTipToCallerAndUsdtToRecipient() external {
    address escrow = _fundAndDeploy(_args(1), AMOUNT);

    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(usdt.balanceOf(alice), ((AMOUNT - TIP) * USDT_RATE) / 1e18);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_FundedDeployAndExecutePaysTipToCallerAndEthToRecipient() external {
    address escrow = _fundAndDeploy(_args(2), AMOUNT);

    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(alice.balance, _ethOut(AMOUNT - TIP));
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_DrainedDeployAndExecuteIsNoOp() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = _fundAndDeploy(args, AMOUNT);
    uint256 recipientBalance = usdc.balanceOf(alice);

    address secondRelayer = makeAddr("second-relayer");
    vm.prank(secondRelayer);
    address redeployed = factory.deployAndExecute(args);

    assertEq(redeployed, escrow);
    assertEq(usdc.balanceOf(alice), recipientBalance);
    assertEq(dai.balanceOf(secondRelayer), 0);
  }

  function test_RefundedDeployedEscrowExecutesAgain() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = _fundAndDeploy(args, AMOUNT);
    assertGt(escrow.code.length, 0);
    uint256 recipientBalance = usdc.balanceOf(alice);

    dai.mint(escrow, AMOUNT);
    address secondRelayer = makeAddr("second-relayer");
    vm.prank(secondRelayer);
    address executed = factory.deployAndExecute(args);

    assertEq(executed, escrow);
    assertEq(usdc.balanceOf(alice), recipientBalance + ((AMOUNT - TIP) * USDC_RATE) / 1e18);
    assertEq(dai.balanceOf(secondRelayer), TIP);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_EarlyDeploymentCannotTrapLaterWithdrawalFunding() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = factory.predictEscrowAddress(args);

    uint256 earlySwapAmount = 1e18;
    dai.mint(escrow, TIP + earlySwapAmount);
    address attacker = makeAddr("attacker");
    vm.prank(attacker);
    factory.deployAndExecute(args);

    assertGt(escrow.code.length, 0);
    assertEq(dai.balanceOf(attacker), TIP);
    assertEq(usdc.balanceOf(alice), (earlySwapAmount * USDC_RATE) / 1e18);

    dai.mint(escrow, AMOUNT);
    address honestRelayer = makeAddr("honest-relayer");
    vm.prank(honestRelayer);
    factory.deployAndExecute(args);

    assertEq(usdc.balanceOf(alice), ((earlySwapAmount + AMOUNT - TIP) * USDC_RATE) / 1e18);
    assertEq(dai.balanceOf(honestRelayer), TIP);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_DeployDeploysUnfundedCloneWithoutExecuting() external {
    SwapEscrow.Args memory args = _args(0);
    address predicted = factory.predictEscrowAddress(args);

    vm.prank(makeAddr("anyone"));
    address escrow = factory.deploy(args);

    assertEq(escrow, predicted);
    assertGt(escrow.code.length, 0);
    assertEq(SwapEscrow(escrow).recoveryCommitment(), _args(0).recoveryCommitment);
    assertEq(router.callCount(), 0);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_DeployOnFundedEscrowDoesNotSwapOrPayTip() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    factory.deploy(args);

    assertGt(escrow.code.length, 0);
    assertEq(router.callCount(), 0);
    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(dai.balanceOf(relayer), 0);
    assertEq(usdc.balanceOf(alice), 0);
  }

  function test_DeployIsIdempotentAndDeployAndExecuteReusesTheClone() external {
    SwapEscrow.Args memory args = _args(0);
    address escrow = factory.deploy(args);
    assertEq(factory.deploy(args), escrow);

    dai.mint(escrow, AMOUNT);
    vm.prank(relayer);
    assertEq(factory.deployAndExecute(args), escrow);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(usdc.balanceOf(alice), ((AMOUNT - TIP) * USDC_RATE) / 1e18);
  }

  function test_ExecuteRevertsForNonFactoryCaller() external {
    address escrow = _fundAndDeploy(_args(0), AMOUNT);

    vm.expectRevert(SwapEscrow.SwapEscrow__NotFactory.selector);
    SwapEscrow(escrow).execute(address(this));
  }

  function test_ImplementationRevertsAsNotClone() external {
    vm.expectRevert(SwapEscrow.SwapEscrow__NotClone.selector);
    implementation.route();

    vm.prank(address(factory));
    vm.expectRevert(SwapEscrow.SwapEscrow__NotClone.selector);
    implementation.execute(address(this));
  }

  function test_ExecutorPathPaysRelayerTheTip() external {
    OperationExecutor executor = new OperationExecutor();
    SwapEscrow.Args memory args = _args(1);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    uint256 payout = executor.execute(
      address(factory), abi.encodeCall(SwapEscrowFactory.deployAndExecute, (args)), IERC20(address(dai)), TIP
    );

    assertEq(payout, TIP);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(dai.balanceOf(address(executor)), 0);
    assertEq(usdt.balanceOf(alice), ((AMOUNT - TIP) * USDT_RATE) / 1e18);
  }

  function test_ExecutorPathOnUnfundedEscrowPaysZero() external {
    OperationExecutor executor = new OperationExecutor();
    SwapEscrow.Args memory args = _args(1);
    bytes memory deployCalldata = abi.encodeCall(SwapEscrowFactory.deployAndExecute, (args));

    vm.prank(relayer);
    uint256 payout = executor.execute(address(factory), deployCalldata, IERC20(address(dai)), 0);
    assertEq(payout, 0);
    assertEq(factory.predictEscrowAddress(args).code.length, 0);

    vm.expectRevert(abi.encodeWithSelector(Errors.OperationExecutor__InsufficientPayout.selector, 0, TIP));
    vm.prank(relayer);
    executor.execute(address(factory), deployCalldata, IERC20(address(dai)), TIP);
  }
}
