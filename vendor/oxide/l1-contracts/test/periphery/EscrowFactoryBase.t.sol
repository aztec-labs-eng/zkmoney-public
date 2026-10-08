// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {EscrowFactoryBase} from "@periphery/EscrowFactoryBase.sol";
import {Errors} from "@periphery/Errors.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";

contract EscrowFactoryBaseTest is Test {
  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 25e18;

  TestERC20 internal dai;
  TestPayoutEscrowFactory internal factory;

  address internal relayer = makeAddr("relayer");
  address internal alice = makeAddr("alice");

  function setUp() public {
    dai = new TestERC20("DAI", "DAI", address(this));
    factory = new TestPayoutEscrowFactory(IERC20(address(dai)));
  }

  function test_PredictionMatchesOZClonesLibrary() external view {
    TestPayoutEscrow.Args memory args = _args();
    address predicted = Clones.predictDeterministicAddressWithImmutableArgs(
      factory.IMPLEMENTATION(), abi.encode(args), bytes32(0), address(factory)
    );
    assertEq(factory.predictEscrowAddress(args), predicted);
  }

  function test_BalanceBelowTipDeployAndExecuteIsNoOp() external {
    TestPayoutEscrow.Args memory args = _args();
    address escrow = _fundAndDeploy(args, TIP - 1);

    assertEq(escrow, factory.predictEscrowAddress(args));
    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), TIP - 1);
    assertEq(dai.balanceOf(relayer), 0);
  }

  function test_BalanceExactlyTipDeployAndExecuteIsNoOp() external {
    address escrow = _fundAndDeploy(_args(), TIP);

    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), TIP);
    assertEq(dai.balanceOf(relayer), 0);
  }

  function test_ZeroBalanceZeroTipDeployAndExecuteIsNoOp() external {
    TestPayoutEscrow.Args memory args = _args();
    args.relayerTip = 0;

    vm.prank(relayer);
    address escrow = factory.deployAndExecute(args);

    assertEq(escrow.code.length, 0);
    assertEq(dai.balanceOf(alice), 0);
  }

  function test_FundedDeployAndExecutePaysTipToCallerAndEmitsEscrowExecuted() external {
    TestPayoutEscrow.Args memory args = _args();
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.expectEmit(true, true, true, true, address(factory));
    emit EscrowFactoryBase.EscrowExecuted(escrow, relayer);
    vm.prank(relayer);
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(dai.balanceOf(alice), AMOUNT - TIP);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_DrainedDeployAndExecuteIsNoOp() external {
    TestPayoutEscrow.Args memory args = _args();
    address escrow = _fundAndDeploy(args, AMOUNT);

    address secondRelayer = makeAddr("second-relayer");
    vm.prank(secondRelayer);
    address redeployed = factory.deployAndExecute(args);

    assertEq(redeployed, escrow);
    assertEq(dai.balanceOf(alice), AMOUNT - TIP);
    assertEq(dai.balanceOf(secondRelayer), 0);
  }

  function test_RefundedDeployedEscrowExecutesAgain() external {
    TestPayoutEscrow.Args memory args = _args();
    address escrow = _fundAndDeploy(args, AMOUNT);

    dai.mint(escrow, AMOUNT);
    address secondRelayer = makeAddr("second-relayer");
    vm.prank(secondRelayer);
    address executed = factory.deployAndExecute(args);

    assertEq(executed, escrow);
    assertEq(dai.balanceOf(alice), 2 * (AMOUNT - TIP));
    assertEq(dai.balanceOf(secondRelayer), TIP);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_EarlyDeploymentCannotTrapLaterWithdrawalFunding() external {
    TestPayoutEscrow.Args memory args = _args();
    address escrow = factory.predictEscrowAddress(args);

    uint256 earlyAmount = 1e18;
    dai.mint(escrow, TIP + earlyAmount);
    address attacker = makeAddr("attacker");
    vm.prank(attacker);
    factory.deployAndExecute(args);

    assertGt(escrow.code.length, 0);
    assertEq(dai.balanceOf(attacker), TIP);
    assertEq(dai.balanceOf(alice), earlyAmount);

    dai.mint(escrow, AMOUNT);
    address honestRelayer = makeAddr("honest-relayer");
    vm.prank(honestRelayer);
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(alice), earlyAmount + AMOUNT - TIP);
    assertEq(dai.balanceOf(honestRelayer), TIP);
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_DeployDeploysUnfundedCloneWithoutExecuting() external {
    TestPayoutEscrow.Args memory args = _args();
    address predicted = factory.predictEscrowAddress(args);

    vm.prank(makeAddr("anyone"));
    address escrow = factory.deploy(args);

    assertEq(escrow, predicted);
    assertGt(escrow.code.length, 0);
    assertEq(TestPayoutEscrow(escrow).FACTORY(), address(factory));
  }

  function test_DeployOnFundedEscrowDoesNotExecute() external {
    TestPayoutEscrow.Args memory args = _args();
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, AMOUNT);

    vm.prank(relayer);
    factory.deploy(args);

    assertGt(escrow.code.length, 0);
    assertEq(dai.balanceOf(escrow), AMOUNT);
    assertEq(dai.balanceOf(relayer), 0);
    assertEq(dai.balanceOf(alice), 0);
  }

  function test_DeployIsIdempotentAndDeployAndExecuteReusesTheClone() external {
    TestPayoutEscrow.Args memory args = _args();
    address escrow = factory.deploy(args);
    assertEq(factory.deploy(args), escrow);

    dai.mint(escrow, AMOUNT);
    vm.prank(relayer);
    assertEq(factory.deployAndExecute(args), escrow);
    assertEq(dai.balanceOf(relayer), TIP);
    assertEq(dai.balanceOf(alice), AMOUNT - TIP);
  }

  function test_ExecutorPathOnUnfundedEscrowPaysZero() external {
    OperationExecutor executor = new OperationExecutor();
    TestPayoutEscrow.Args memory args = _args();
    bytes memory deployCalldata = abi.encodeCall(TestPayoutEscrowFactory.deployAndExecute, (args));

    vm.prank(relayer);
    uint256 payout = executor.execute(address(factory), deployCalldata, IERC20(address(dai)), 0);
    assertEq(payout, 0);
    assertEq(factory.predictEscrowAddress(args).code.length, 0);

    vm.expectRevert(abi.encodeWithSelector(Errors.OperationExecutor__InsufficientPayout.selector, 0, TIP));
    vm.prank(relayer);
    executor.execute(address(factory), deployCalldata, IERC20(address(dai)), TIP);
  }

  function _args() internal view returns (TestPayoutEscrow.Args memory) {
    return TestPayoutEscrow.Args({recipient: alice, relayerTip: TIP, nonce: keccak256("nonce")});
  }

  function _fundAndDeploy(TestPayoutEscrow.Args memory _escrowArgs, uint256 _funding)
    internal
    returns (address escrow)
  {
    dai.mint(factory.predictEscrowAddress(_escrowArgs), _funding);
    vm.prank(relayer);
    escrow = factory.deployAndExecute(_escrowArgs);
  }
}

contract TestPayoutEscrow is EscrowBase {
  using SafeERC20 for IERC20;

  struct Args {
    address recipient;
    uint256 relayerTip;
    bytes32 nonce;
  }

  IERC20 public immutable DAI;

  constructor(IERC20 _dai) {
    DAI = _dai;
  }

  function execute(address _tipRecipient) external override onlyFactory {
    Args memory args = abi.decode(_cloneArgs(), (Args));
    DAI.safeTransfer(_tipRecipient, args.relayerTip);
    DAI.safeTransfer(args.recipient, DAI.balanceOf(address(this)));
  }

  function _recoveryCommitment() internal pure override returns (bytes32) {
    return bytes32(0);
  }
}

contract TestPayoutEscrowFactory is EscrowFactoryBase {
  constructor(IERC20 _dai) EscrowFactoryBase(_dai, address(new TestPayoutEscrow(_dai))) {}

  function deployAndExecute(TestPayoutEscrow.Args calldata _args) external returns (address escrow) {
    return _deployAndExecute(abi.encode(_args), _args.relayerTip);
  }

  function deploy(TestPayoutEscrow.Args calldata _args) external returns (address escrow) {
    return _deploy(abi.encode(_args));
  }

  function predictEscrowAddress(TestPayoutEscrow.Args calldata _args) external view returns (address) {
    return _predictEscrowAddress(abi.encode(_args));
  }
}
