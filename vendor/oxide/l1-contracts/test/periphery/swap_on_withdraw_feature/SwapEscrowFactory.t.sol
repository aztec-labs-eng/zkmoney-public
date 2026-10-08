// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowBase} from "@periphery/EscrowBase.sol";
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

  function test_FundedDeployAndExecutePaysTipToCallerAndUsdcToRecipient() external {
    address escrow = _fundAndDeploy(_args(0), AMOUNT);

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

  function test_ExecuteRevertsForNonFactoryCaller() external {
    address escrow = _fundAndDeploy(_args(0), AMOUNT);

    vm.expectRevert(EscrowBase.EscrowBase__NotFactory.selector);
    SwapEscrow(escrow).execute(address(this));
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
}
