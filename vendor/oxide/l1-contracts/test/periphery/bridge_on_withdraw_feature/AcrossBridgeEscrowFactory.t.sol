// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AcrossBridgeEscrow} from "@periphery/bridge_on_withdraw_feature/AcrossBridgeEscrow.sol";
import {AcrossBridgeEscrowFactory} from "@periphery/bridge_on_withdraw_feature/AcrossBridgeEscrowFactory.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {AcrossBridgeEscrowTestBase} from "./AcrossBridgeEscrowTestBase.sol";

contract AcrossBridgeEscrowFactoryTest is AcrossBridgeEscrowTestBase {
  function test_PredictionMatchesDeployAndGettersReturnCommittedArgs() external {
    AcrossBridgeEscrow.Args memory args = _args();
    address predicted = factory.predictEscrowAddress(args);

    address escrow = _fundAndDeploy(args, AMOUNT);

    assertEq(escrow, predicted);
    assertGt(escrow.code.length, 0);
    assertEq(AcrossBridgeEscrow(escrow).acrossInputToken(), address(usdt));
    assertEq(AcrossBridgeEscrow(escrow).destinationChainId(), ARBITRUM_CHAIN_ID);
    assertEq(AcrossBridgeEscrow(escrow).recipient(), alice);
    assertEq(AcrossBridgeEscrow(escrow).acrossOutputToken(), arbitrumUsdt);
    assertEq(AcrossBridgeEscrow(escrow).acrossOutputTokenDecimals(), ARBITRUM_USDT_DECIMALS);
    assertEq(AcrossBridgeEscrow(escrow).acrossFee(), ACROSS_FEE);
    assertEq(AcrossBridgeEscrow(escrow).recoveryCommitment(), args.recoveryCommitment);
    assertEq(AcrossBridgeEscrow(escrow).relayerTip(), TIP);
    assertEq(AcrossBridgeEscrow(escrow).nonce(), NONCE);
  }

  function test_EveryArgsFieldChangesTheAddress() external {
    AcrossBridgeEscrow.Args memory base = _args();
    address baseEscrow = factory.predictEscrowAddress(base);

    AcrossBridgeEscrow.Args memory changed = base;
    changed.acrossInputToken = address(usdc);
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.destinationChainId = ARBITRUM_CHAIN_ID + 1;
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.recipient = makeAddr("other");
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.acrossOutputToken = makeAddr("other-token");
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.acrossOutputTokenDecimals = ARBITRUM_USDT_DECIMALS + 1;
    assertNotEq(factory.predictEscrowAddress(changed), baseEscrow);

    changed = base;
    changed.acrossFee = ACROSS_FEE + 1;
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

  function test_ExecuteRevertsForNonFactoryCaller() external {
    address escrow = _fundAndDeploy(_args(), AMOUNT);

    vm.expectRevert(EscrowBase.EscrowBase__NotFactory.selector);
    AcrossBridgeEscrow(escrow).execute(address(this));
  }

  function test_ImplementationRevertsAsNotClone() external {
    vm.expectRevert(EscrowBase.EscrowBase__NotClone.selector);
    implementation.recipient();

    vm.prank(address(factory));
    vm.expectRevert(EscrowBase.EscrowBase__NotClone.selector);
    implementation.execute(address(this));
  }

  function test_ExecutorPathPaysRelayerTheTip() external {
    OperationExecutor executor = new OperationExecutor();
    AcrossBridgeEscrow.Args memory args = _args();
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    uint256 payout = executor.execute(
      address(factory), abi.encodeCall(AcrossBridgeEscrowFactory.deployAndExecute, (args)), IERC20(address(dai)), TIP
    );

    assertEq(payout, TIP);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(dai.balanceOf(address(executor)), 0);
    assertEq(spokePool.lastDeposit().inputAmount, SWAPPED_AMOUNT);
  }
}
