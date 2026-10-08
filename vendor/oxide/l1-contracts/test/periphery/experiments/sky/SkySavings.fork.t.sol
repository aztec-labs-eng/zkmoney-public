// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {PlainWithdrawalExecutor} from "@periphery/PlainWithdrawalExecutor.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {SkyWithdrawalExecutor} from "@periphery/experiments/sky/SkyWithdrawalExecutor.sol";
import {SkyEscrow} from "@periphery/experiments/sky/SkyEscrow.sol";
import {SkyEscrowFactory} from "@periphery/experiments/sky/SkyEscrowFactory.sol";
import {SkyRoute} from "@periphery/experiments/sky/SkyTypes.sol";
import {IDaiUsds} from "@periphery/experiments/sky/interfaces/IDaiUsds.sol";
import {ISUsds} from "@periphery/experiments/sky/interfaces/ISUsds.sol";
import {DAI} from "@periphery/ThreePoolLib.sol";
import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {SkyHelpers} from "@test/periphery/experiments/sky/SkyTestBase.sol";

interface IDaiUsdsView {
  function dai() external view returns (address);

  function usds() external view returns (address);
}

contract SkySavingsForkTest is MainnetForkFixture, SkyHelpers {
  using SafeERC20 for IERC20;

  IDaiUsds internal constant DAI_USDS = IDaiUsds(0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A);
  IERC20 internal constant USDS = IERC20(0xdC035D45d973E3EC169d2276DDab16f1e407384F);
  ISUsds internal constant SUSDS = ISUsds(0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD);

  uint256 internal constant DAI_PORTAL_CUT = 0.5 ether;
  uint256 internal constant RELEASE_TIP = 1e18;
  uint256 internal constant ESCROW_TIP = 2e18;

  bytes32 internal constant RECIPIENT_COMMITMENT = keccak256("sky-fork-recipient");
  address internal constant PAYOUT_RECIPIENT = address(0xBEEF);
  address internal constant RELAYER = address(0xCAFE);

  bool internal live;

  OxidePortal internal daiPortal;
  OxidePortal internal sUsdsPortal;
  PlainWithdrawalExecutor internal daiExecutor;
  SkyWithdrawalExecutor internal skyExecutor;
  SkyEscrowFactory internal escrowFactory;

  function setUp() public override(OxidePortalBase) {
    string memory rpc = vm.envOr("MAINNET_FORK_RPC_URL", string(""));
    if (bytes(rpc).length == 0) {
      console2.log("MAINNET_FORK_RPC_URL is not set, so the Sky fork test is skipped.");
      console2.log("The checked-in allocs fixture does not hold the Sky contracts.");
      return;
    }
    live = true;

    vm.createSelectFork(rpc, FORK_BLOCK);
    super.setUp();

    daiPortal = _newPortal(address(DAI), DAI_PORTAL_CUT);
    _initializeAndRegister(daiPortal, L2_PORTAL);
    sUsdsPortal = _newPortal(address(SUSDS), 0);
    _initializeAndRegister(sUsdsPortal, SUSDS_L2_PORTAL);

    daiExecutor = new PlainWithdrawalExecutor(address(daiPortal));
    skyExecutor = new SkyWithdrawalExecutor(sUsdsPortal, _route());
    escrowFactory = new SkyEscrowFactory(_route(), daiPortal, sUsdsPortal, skyExecutor);
  }

  function test_GivenMainnet_ThenTheSkyAddressesAreWhatWeExpect() external {
    _requireFork();
    assertEq(IERC20Metadata(address(DAI)).symbol(), "DAI", "the dai address is wrong");
    assertEq(IERC20Metadata(address(USDS)).symbol(), "USDS", "the usds address is wrong");
    assertEq(IERC20Metadata(address(SUSDS)).symbol(), "sUSDS", "the susds address is wrong");
    assertEq(SUSDS.asset(), address(USDS), "susds does not hold usds");
    assertEq(IDaiUsdsView(address(DAI_USDS)).dai(), address(DAI), "the converter does not hold dai");
    assertEq(IDaiUsdsView(address(DAI_USDS)).usds(), address(USDS), "the converter does not hold usds");
    assertGe(SUSDS.convertToAssets(1e18), 1e18, "the susds share price never drops under one");
  }

  function test_GivenRealShares_WhenReleasedThroughTheSkyExecutor_ThenTheRecipientIsPaidInDai() external {
    _requireFork();
    uint256 shares = _acquireShares(address(sUsdsPortal), 1000e18);
    uint256 assets = SUSDS.previewRedeem(shares);
    IOxidePortal.WithdrawArgs memory args = _withdrawArgs(
      sUsdsPortal,
      address(skyExecutor),
      shares,
      abi.encode(PAYOUT_RECIPIENT, RELEASE_TIP),
      abi.encode(RELAYER, address(0))
    );

    vm.prank(RELAYER);
    uint256 before = gasleft();
    sUsdsPortal.withdraw(args);
    console2.log("fork: sUSDS portal withdraw through SkyWithdrawalExecutor, gas:", before - gasleft());

    assertEq(DAI.balanceOf(RELAYER), RELEASE_TIP);
    assertEq(DAI.balanceOf(PAYOUT_RECIPIENT), assets - RELEASE_TIP);
    assertEq(SUSDS.balanceOf(address(skyExecutor)), 0);
    assertEq(USDS.balanceOf(address(skyExecutor)), 0);
  }

  function test_GivenAStake_WhenTheReleaseAndTheRunLand_ThenTheSUsdsPortalEscrowsRealShares() external {
    _requireFork();
    SkyEscrow.Args memory args = _args(0);
    address escrow = escrowFactory.predictEscrowAddress(args);
    uint256 amount = 1000e18;
    deal(address(DAI), address(daiPortal), amount);

    IOxidePortal.WithdrawArgs memory release = _withdrawArgs(
      daiPortal, address(daiExecutor), amount, abi.encode(escrow, RELEASE_TIP), abi.encode(RELAYER, address(0))
    );
    vm.prank(RELAYER);
    uint256 before = gasleft();
    daiPortal.withdraw(release);
    console2.log("fork: stake release, a plain DAI withdraw, gas:", before - gasleft());

    uint256 escrowed = amount - DAI_PORTAL_CUT - RELEASE_TIP;
    uint256 expectedShares = SUSDS.previewDeposit(escrowed - ESCROW_TIP);
    vm.expectEmit(true, true, false, true, address(SUSDS));
    emit ISUsds.Referral(2014, escrow, escrowed - ESCROW_TIP, expectedShares);
    vm.prank(RELAYER);
    before = gasleft();
    escrowFactory.deployAndExecute(args);
    console2.log("fork: stake run, deploy and DAI to sUSDS deposit, gas:", before - gasleft());

    assertEq(SUSDS.balanceOf(address(sUsdsPortal)), expectedShares, "the sUSDS portal escrows the shares");
    assertEq(DAI.balanceOf(RELAYER), RELEASE_TIP + ESCROW_TIP);
    assertEq(DAI.balanceOf(escrow), 0);
    assertEq(USDS.balanceOf(escrow), 0);
    assertApproxEqRel(SUSDS.convertToAssets(expectedShares), escrowed - ESCROW_TIP, 1e12);
  }

  function test_GivenAnUnstake_WhenTheReleaseAndTheRunLand_ThenTheDaiPortalEscrowsTheDai() external {
    _requireFork();
    SkyEscrow.Args memory args = _args(1);
    address escrow = escrowFactory.predictEscrowAddress(args);
    uint256 shares = _acquireShares(address(sUsdsPortal), 1000e18);
    uint256 assets = SUSDS.previewRedeem(shares);

    IOxidePortal.WithdrawArgs memory release = _withdrawArgs(
      sUsdsPortal, address(skyExecutor), shares, abi.encode(escrow, RELEASE_TIP), abi.encode(RELAYER, address(0))
    );
    vm.prank(RELAYER);
    uint256 before = gasleft();
    sUsdsPortal.withdraw(release);
    console2.log("fork: unstake release, sUSDS to DAI through the Sky executor, gas:", before - gasleft());
    assertEq(DAI.balanceOf(escrow), assets - RELEASE_TIP);

    vm.prank(RELAYER);
    before = gasleft();
    escrowFactory.deployAndExecute(args);
    console2.log("fork: unstake run, deploy and DAI portal deposit, gas:", before - gasleft());

    assertEq(DAI.balanceOf(address(daiPortal)), assets - RELEASE_TIP - ESCROW_TIP - DAI_PORTAL_CUT);
    assertEq(DAI.balanceOf(RELAYER), RELEASE_TIP + ESCROW_TIP);
    assertEq(DAI.balanceOf(FPC_FUNDER), DAI_PORTAL_CUT);
  }

  function test_GivenSharesInAnUnstakeEscrow_WhenRun_ThenTheRealVaultRedeemsThem() external {
    _requireFork();
    SkyEscrow.Args memory args = _args(1);
    address escrow = escrowFactory.predictEscrowAddress(args);
    uint256 shares = _acquireShares(escrow, 1000e18);
    uint256 assets = SUSDS.previewRedeem(shares);

    vm.prank(RELAYER);
    uint256 before = gasleft();
    escrowFactory.deployAndExecute(args);
    console2.log("fork: unstake run that redeems shares first, gas:", before - gasleft());

    assertEq(SUSDS.balanceOf(escrow), 0);
    assertEq(DAI.balanceOf(address(daiPortal)), assets - ESCROW_TIP - DAI_PORTAL_CUT);
  }

  function _requireFork() internal {
    if (!live) {
      vm.skip(true, "MAINNET_FORK_RPC_URL is not set");
    }
  }

  function _route() internal pure returns (SkyRoute memory) {
    return SkyRoute({dai: DAI, usds: USDS, sUsds: SUSDS, daiUsds: DAI_USDS});
  }

  function _args(uint8 _escrowRoute) internal pure returns (SkyEscrow.Args memory) {
    return SkyEscrow.Args({
      route: _escrowRoute,
      recipientCommitment: RECIPIENT_COMMITMENT,
      recoveryCommitment: RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("sky-fork-salt"), address(0xA11CE)),
      relayerTip: ESCROW_TIP,
      nonce: keccak256("sky-fork-nonce")
    });
  }

  function _acquireShares(address _to, uint256 _daiAmount) internal returns (uint256 shares) {
    address buyer = makeAddr("shareBuyer");
    deal(address(DAI), buyer, _daiAmount);
    vm.startPrank(buyer);
    DAI.forceApprove(address(DAI_USDS), _daiAmount);
    DAI_USDS.daiToUsds(buyer, _daiAmount);
    USDS.forceApprove(address(SUSDS), _daiAmount);
    shares = SUSDS.deposit(_daiAmount, _to);
    vm.stopPrank();
  }
}
