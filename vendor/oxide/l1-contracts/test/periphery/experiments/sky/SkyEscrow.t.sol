// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors as CoreErrors} from "@core/lib/Errors.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {SkyEscrow} from "@periphery/experiments/sky/SkyEscrow.sol";
import {SkyEscrowFactory} from "@periphery/experiments/sky/SkyEscrowFactory.sol";
import {SkyWithdrawalExecutor} from "@periphery/experiments/sky/SkyWithdrawalExecutor.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {SkyErrors} from "@periphery/experiments/sky/SkyErrors.sol";
import {SkyRoute} from "@periphery/experiments/sky/SkyTypes.sol";
import {ISUsds} from "@periphery/experiments/sky/interfaces/ISUsds.sol";
import {SkyTestBase, MockERC1271Account} from "@test/periphery/experiments/sky/SkyTestBase.sol";
import {MockDaiUsds} from "@test/periphery/experiments/sky/mocks/MockDaiUsds.sol";

contract SkyEscrowTest is SkyTestBase {
  bytes32 internal constant RECIPIENT_COMMITMENT = keccak256("sky-recipient-commitment");
  bytes32 internal constant RECOVERY_SALT = keccak256("sky-recovery-salt");
  bytes32 internal constant ESCROW_NONCE = keccak256("sky-escrow-nonce");
  bytes32 internal constant REQUEST_NONCE = keccak256("sky-request-nonce");
  uint256 internal constant ESCROW_TIP = 2e18;
  uint256 internal constant OWNER_KEY = 0xB0B;
  uint256 internal constant CAPPED_GLOBAL_LIMIT = 100e18;

  address internal escrowOwner;
  address internal target = makeAddr("recoveryTarget");

  event EscrowExecuted(address indexed escrow, address tipRecipient);
  event EscrowRecovered(address indexed token, address indexed target, uint256 amount);

  function setUp() public override {
    super.setUp();
    escrowOwner = vm.addr(OWNER_KEY);
  }

  function test_GivenTheFactory_ThenItNamesTheImplementationAndItsWiring() external view {
    SkyEscrow implementation = SkyEscrow(escrowFactory.IMPLEMENTATION());
    assertEq(implementation.FACTORY(), address(escrowFactory));
    assertEq(address(implementation.DAI()), address(dai));
    assertEq(address(implementation.USDS()), address(usds));
    assertEq(address(implementation.SUSDS()), address(sUsds));
    assertEq(address(implementation.DAI_USDS()), address(converter));
    assertEq(address(implementation.DAI_PORTAL()), address(portal));
    assertEq(address(implementation.SUSDS_PORTAL()), address(sUsdsPortal));
    assertEq(address(implementation.SKY_EXECUTOR()), address(skyExecutor));
    assertEq(implementation.REFERRAL_CODE(), 2014);
    assertEq(address(escrowFactory.DAI_PORTAL()), address(portal));
    assertEq(address(escrowFactory.SUSDS_PORTAL()), address(sUsdsPortal));
    assertEq(address(escrowFactory.SKY_EXECUTOR()), address(skyExecutor));
  }

  function test_GivenSwappedPortals_WhenTheFactoryIsBuilt_ThenReverts() external {
    vm.expectRevert(SkyErrors.SkyEscrow__DaiPortalUnderlyingMismatch.selector);
    new SkyEscrowFactory(_skyRoute(), sUsdsPortal, portal, skyExecutor);
  }

  function test_GivenAnExecutorOfAnotherPortal_WhenTheFactoryIsBuilt_ThenReverts() external {
    SkyWithdrawalExecutor other = new SkyWithdrawalExecutor(_newPortal(address(sUsds), 0), _skyRoute());
    vm.expectRevert(SkyErrors.SkyEscrow__ExecutorPortalMismatch.selector);
    new SkyEscrowFactory(_skyRoute(), portal, sUsdsPortal, other);
  }

  function test_GivenAnExecutorThatPaysAnotherToken_WhenTheFactoryIsBuilt_ThenReverts() external {
    SkyRoute memory otherRoute = _skyRoute();
    otherRoute.dai = IERC20(makeAddr("otherDai"));
    SkyWithdrawalExecutor other = new SkyWithdrawalExecutor(sUsdsPortal, otherRoute);
    vm.expectRevert(SkyErrors.SkyEscrow__ExecutorAssetMismatch.selector);
    new SkyEscrowFactory(_skyRoute(), portal, sUsdsPortal, other);
  }

  function test_GivenAStake_WhenTheReleaseAndTheRunLand_ThenTheSharesAreDepositedIntoTheSUsdsPortal() external {
    sUsds.setPricePerShare(1.25e18);
    SkyEscrow.Args memory args = _args(0);
    address escrow = escrowFactory.predictEscrowAddress(args);
    uint256 amount = 100e18;
    uint256 releaseTip = 1e18;
    dai.mint(address(portal), amount);

    vm.prank(RELAYER);
    portal.withdraw(_daiWithdrawArgs(amount, abi.encode(escrow, releaseTip), abi.encode(RELAYER, address(0))));

    uint256 escrowed = amount - DAI_PORTAL_CUT - releaseTip;
    assertEq(dai.balanceOf(escrow), escrowed, "the release pays the escrow in dai");
    assertEq(dai.balanceOf(FPC_FUNDER), DAI_PORTAL_CUT, "the DAI portal takes its withdrawal cut");
    assertEq(escrow.code.length, 0, "the escrow is not deployed yet");

    uint256 expectedShares = sUsds.convertToShares(escrowed - ESCROW_TIP);
    vm.expectEmit(true, true, false, true, address(sUsds));
    emit ISUsds.Referral(2014, escrow, escrowed - ESCROW_TIP, expectedShares);
    vm.expectEmit(true, false, false, false, address(sUsdsPortal));
    emit Deposit(RECIPIENT_COMMITMENT, expectedShares, bytes32(0), 0);
    vm.expectEmit(true, false, false, true, address(escrowFactory));
    emit EscrowExecuted(escrow, RELAYER);
    vm.prank(RELAYER);
    assertEq(escrowFactory.deployAndExecute(args), escrow);

    assertEq(sUsds.balanceOf(address(sUsdsPortal)), expectedShares, "the sUSDS portal escrows the shares");
    assertEq(dai.balanceOf(RELAYER), releaseTip + ESCROW_TIP, "the relayer gets both tips in dai");
    assertEq(dai.balanceOf(escrow), 0, "the run empties the escrow");
    assertEq(sUsds.balanceOf(escrow), 0);
    assertEq(usds.balanceOf(escrow), 0);
    assertEq(dai.balanceOf(FPC_FUNDER), DAI_PORTAL_CUT, "the sUSDS portal takes no deposit cut");
  }

  function test_GivenAnUnstake_WhenTheReleaseAndTheRunLand_ThenTheDaiIsDepositedIntoTheDaiPortal() external {
    sUsds.setPricePerShare(1.25e18);
    SkyEscrow.Args memory args = _args(1);
    address escrow = escrowFactory.predictEscrowAddress(args);
    uint256 shares = 80e18;
    uint256 releaseTip = 1e18;
    _fundSUsdsPortal(shares);

    vm.prank(RELAYER);
    sUsdsPortal.withdraw(_skyWithdrawArgs(shares, abi.encode(escrow, releaseTip), abi.encode(RELAYER, address(0))));

    uint256 escrowed = 100e18 - releaseTip;
    assertEq(dai.balanceOf(escrow), escrowed, "the Sky executor pays the escrow in dai");

    uint256 portalBefore = dai.balanceOf(address(portal));
    vm.expectEmit(true, false, false, false, address(portal));
    emit Deposit(RECIPIENT_COMMITMENT, escrowed - ESCROW_TIP - DAI_PORTAL_CUT, bytes32(0), 0);
    vm.prank(RELAYER);
    escrowFactory.deployAndExecute(args);

    assertEq(dai.balanceOf(RELAYER), releaseTip + ESCROW_TIP);
    assertEq(dai.balanceOf(FPC_FUNDER), DAI_PORTAL_CUT, "the DAI portal takes its deposit cut");
    assertEq(
      dai.balanceOf(address(portal)) - portalBefore, escrowed - ESCROW_TIP - DAI_PORTAL_CUT, "the DAI portal escrows"
    );
    assertEq(dai.balanceOf(escrow), 0);
  }

  function test_GivenAnEmptyEscrow_WhenRun_ThenNothingHappens() external {
    SkyEscrow.Args memory args = _args(0);
    address escrow = escrowFactory.predictEscrowAddress(args);
    dai.mint(escrow, ESCROW_TIP);

    vm.prank(RELAYER);
    assertEq(escrowFactory.deployAndExecute(args), escrow);

    assertEq(escrow.code.length, 0, "an escrow with nothing to move is not deployed");
    assertEq(dai.balanceOf(escrow), ESCROW_TIP);
    assertEq(dai.balanceOf(RELAYER), 0);
  }

  function test_GivenAStakeEscrowThatHoldsOnlyShares_WhenRun_ThenNothingHappens() external {
    SkyEscrow.Args memory args = _args(0);
    address escrow = escrowFactory.predictEscrowAddress(args);
    _mintShares(escrow, 10e18);

    escrowFactory.deployAndExecute(args);
    assertEq(escrow.code.length, 0, "shares count as something to move only on the unstake route");
  }

  function test_GivenACallerThatIsNotTheFactory_WhenItRunsAnEscrow_ThenReverts() external {
    SkyEscrow escrow = _deployFunded(_args(0), 10e18);
    vm.prank(RELAYER);
    vm.expectRevert(EscrowBase.EscrowBase__NotFactory.selector);
    escrow.execute(RELAYER);
  }

  function test_GivenAnUnknownRoute_WhenRun_ThenReverts() external {
    SkyEscrow.Args memory args = _args(2);
    dai.mint(escrowFactory.predictEscrowAddress(args), 10e18);
    vm.expectRevert(abi.encodeWithSelector(SkyErrors.SkyEscrow__UnknownRoute.selector, uint8(2)));
    escrowFactory.deployAndExecute(args);
  }

  function test_GivenTheImplementation_WhenItsArgumentsAreRead_ThenReverts() external {
    SkyEscrow implementation = SkyEscrow(escrowFactory.IMPLEMENTATION());
    vm.expectRevert(EscrowBase.EscrowBase__NotClone.selector);
    implementation.route();
  }

  function test_GivenTheArguments_ThenTheCloneReportsThem() external {
    SkyEscrow.Args memory args = _args(1);
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(args));
    assertEq(escrow.route(), 1);
    assertEq(escrow.recipientCommitment(), RECIPIENT_COMMITMENT);
    assertEq(escrow.recoveryCommitment(), args.recoveryCommitment);
    assertEq(escrow.relayerTip(), ESCROW_TIP);
    assertEq(escrow.nonce(), ESCROW_NONCE);
    assertEq(escrowFactory.deploy(args), address(escrow), "a second deploy is a no-op");
  }

  function test_GivenAnEoaOwner_WhenItSignsARecovery_ThenTheBalanceGoesToTheTarget() external {
    SkyEscrow escrow = _deployFunded(_args(0), 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));

    vm.prank(RELAYER);
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);

    assertEq(dai.balanceOf(target), 10e18);
    assertEq(dai.balanceOf(address(escrow)), 0);
    assertTrue(escrow.usedNonces(REQUEST_NONCE));
  }

  function test_GivenAContractOwner_WhenItSignsARecovery_ThenTheBalanceGoesToTheTarget() external {
    uint256 signerKey = 0x5161;
    MockERC1271Account account = new MockERC1271Account(vm.addr(signerKey));
    SkyEscrow.Args memory args = _args(0);
    args.recoveryCommitment = RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account));
    SkyEscrow escrow = _deployFunded(args, 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _rawSign(signerKey, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));

    escrow.recoverERC20(RECOVERY_SALT, address(account), signature, target, address(dai), REQUEST_NONCE, deadline);

    assertEq(dai.balanceOf(target), 10e18);
  }

  function test_GivenAContractOwner_WhenAnotherKeySigns_ThenReverts() external {
    MockERC1271Account account = new MockERC1271Account(vm.addr(0x5161));
    SkyEscrow.Args memory args = _args(0);
    args.recoveryCommitment = RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account));
    SkyEscrow escrow = _deployFunded(args, 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _rawSign(0x5162, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.recoverERC20(RECOVERY_SALT, address(account), signature, target, address(dai), REQUEST_NONCE, deadline);
  }

  function test_GivenTheWrongSigner_WhenARecoveryIsSubmitted_ThenReverts() external {
    SkyEscrow escrow = _deployFunded(_args(0), 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(0xBAD, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);
  }

  function test_GivenAnAccountThatIsNotCommitted_WhenARecoveryIsSubmitted_ThenReverts() external {
    SkyEscrow escrow = _deployFunded(_args(0), 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    address other = vm.addr(0xBAD);
    bytes memory signature =
      _eoaSign(0xBAD, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__RecoveryCommitmentMismatch.selector);
    escrow.recoverERC20(RECOVERY_SALT, other, signature, target, address(dai), REQUEST_NONCE, deadline);
  }

  function test_GivenAChangedTarget_WhenARecoveryIsSubmitted_ThenReverts() external {
    SkyEscrow escrow = _deployFunded(_args(0), 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, RELAYER, address(dai), REQUEST_NONCE, deadline);
  }

  function test_GivenAUsedNonce_WhenARecoveryIsSubmitted_ThenReverts() external {
    SkyEscrow escrow = _deployFunded(_args(0), 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);

    dai.mint(address(escrow), 5e18);
    vm.expectRevert(EscrowBase.EscrowBase__NonceAlreadyUsed.selector);
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);
  }

  function test_GivenAPassedDeadline_WhenARecoveryIsSubmitted_ThenReverts() external {
    SkyEscrow escrow = _deployFunded(_args(0), 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));
    vm.warp(deadline + 1);

    vm.expectRevert(abi.encodeWithSelector(EscrowBase.EscrowBase__RecoveryExpired.selector, deadline));
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);
  }

  function test_GivenAnEmptyBalance_WhenARecoveryIsSubmitted_ThenReverts() external {
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(_args(0)));
    vm.expectRevert(EscrowBase.EscrowBase__EmptyBalance.selector);
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, "", target, address(dai), REQUEST_NONCE, block.timestamp);
  }

  function test_GivenForcedEth_WhenTheOwnerSignsAnEthRecovery_ThenTheEthGoesToTheTarget() external {
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(_args(1)));
    vm.deal(address(escrow), 1 ether);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature = _eoaSign(OWNER_KEY, _recoverETHDigest(address(escrow), target, REQUEST_NONCE, deadline));

    vm.expectEmit(true, true, false, true, address(escrow));
    emit EscrowRecovered(address(0), target, 1 ether);
    vm.prank(RELAYER);
    escrow.recoverETH(RECOVERY_SALT, escrowOwner, signature, target, REQUEST_NONCE, deadline);

    assertEq(target.balance, 1 ether);
    assertEq(address(escrow).balance, 0);
    assertTrue(escrow.usedNonces(REQUEST_NONCE));
  }

  function test_GivenNoEth_WhenAnEthRecoveryIsSubmitted_ThenReverts() external {
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(_args(1)));
    vm.expectRevert(EscrowBase.EscrowBase__EmptyBalance.selector);
    escrow.recoverETH(RECOVERY_SALT, escrowOwner, "", target, REQUEST_NONCE, block.timestamp);
  }

  function test_GivenATokenRecoverySignature_WhenUsedToRecoverEth_ThenReverts() external {
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(_args(1)));
    vm.deal(address(escrow), 1 ether);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(0), REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.recoverETH(RECOVERY_SALT, escrowOwner, signature, target, REQUEST_NONCE, deadline);
  }

  function test_GivenAnEthRecoverySignature_WhenUsedToRecoverATokenOrWithdrawInShares_ThenReverts() external {
    SkyEscrow escrow = _deployFunded(_args(1), 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature = _eoaSign(OWNER_KEY, _recoverETHDigest(address(escrow), target, REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);

    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory withdrawal =
      _skyWithdrawArgs(10e18, abi.encode(address(escrow), 0), abi.encode(address(0), address(0)));
    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.withdrawInShares(withdrawal, RECOVERY_SALT, escrowOwner, signature, REQUEST_NONCE, deadline);
  }

  function test_GivenATargetThatRefusesEth_WhenAnEthRecoveryIsSubmitted_ThenReverts() external {
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(_args(1)));
    vm.deal(address(escrow), 1 ether);
    address refusing = address(escrowFactory);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature = _eoaSign(OWNER_KEY, _recoverETHDigest(address(escrow), refusing, REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__EthTransferFailed.selector);
    escrow.recoverETH(RECOVERY_SALT, escrowOwner, signature, refusing, REQUEST_NONCE, deadline);
    assertFalse(escrow.usedNonces(REQUEST_NONCE), "a failed recovery does not spend the nonce");
  }

  function test_GivenAWithdrawInSharesSignature_WhenUsedAsARecovery_ThenReverts() external {
    SkyEscrow escrow = _deployFunded(_args(1), 10e18);
    uint256 deadline = block.timestamp + 1 hours;
    bytes32 withdrawalId = bytes32(uint256(uint160(target)));
    bytes memory signature = _eoaSign(OWNER_KEY, escrow.withdrawInSharesDigest(withdrawalId, REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);
  }

  function test_GivenARecoverySignature_WhenUsedToWithdrawInShares_ThenReverts() external {
    SkyEscrow.Args memory args = _args(1);
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(args));
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory withdrawal =
      _skyWithdrawArgs(10e18, abi.encode(address(escrow), 0), abi.encode(address(0), address(0)));
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(sUsds), REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.withdrawInShares(withdrawal, RECOVERY_SALT, escrowOwner, signature, REQUEST_NONCE, deadline);
  }

  function test_GivenAWithdrawInSharesSignatureForAnotherWithdrawal_WhenSubmitted_ThenReverts() external {
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(_args(1)));
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory withdrawal =
      _skyWithdrawArgs(10e18, abi.encode(address(escrow), 0), abi.encode(address(0), address(0)));
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, escrow.withdrawInSharesDigest(keccak256("another"), REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.withdrawInShares(withdrawal, RECOVERY_SALT, escrowOwner, signature, REQUEST_NONCE, deadline);
  }

  function test_GivenAPausedSky_WhenTheOwnerSettlesInSharesAndSkyRecovers_ThenAnUnstakeRunRedeemsTheShares() external {
    sUsds.setPricePerShare(1.25e18);
    SkyEscrow.Args memory args = _args(1);
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(args));
    uint256 shares = 80e18;
    _fundSUsdsPortal(shares);
    IOxidePortal.WithdrawArgs memory withdrawal =
      _skyWithdrawArgs(shares, abi.encode(address(escrow), 1e18), abi.encode(RELAYER, address(0)));

    converter.setBroken(true);
    vm.expectRevert(MockDaiUsds.MockDaiUsds__Paused.selector);
    sUsdsPortal.withdraw(withdrawal);

    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, escrow.withdrawInSharesDigest(withdrawal.withdrawalId, REQUEST_NONCE, deadline));
    vm.prank(RELAYER);
    escrow.withdrawInShares(withdrawal, RECOVERY_SALT, escrowOwner, signature, REQUEST_NONCE, deadline);

    assertEq(sUsds.balanceOf(address(escrow)), shares, "the escrow holds the shares");
    assertEq(dai.balanceOf(RELAYER), 0, "a settlement in shares pays no release tip");
    assertTrue(sUsdsPortal.$isWithdrawalSpent(withdrawal.withdrawalId));

    converter.setBroken(false);
    uint256 portalBefore = dai.balanceOf(address(portal));
    vm.prank(RELAYER);
    escrowFactory.deployAndExecute(args);

    assertEq(sUsds.balanceOf(address(escrow)), 0, "the run redeems the shares");
    assertEq(dai.balanceOf(RELAYER), ESCROW_TIP);
    assertEq(dai.balanceOf(address(portal)) - portalBefore, 100e18 - ESCROW_TIP - DAI_PORTAL_CUT);
  }

  function test_GivenAFrozenDestination_WhenAStakeRuns_ThenItRevertsAndTheOwnerRecovers() external {
    SkyEscrow.Args memory args = _args(0);
    address escrow = escrowFactory.predictEscrowAddress(args);
    dai.mint(escrow, 50e18);
    vm.prank(OWNER);
    sUsdsPortal.freeze();

    vm.expectRevert(CoreErrors.OxidePortal__FrozenPortal.selector);
    escrowFactory.deployAndExecute(args);
    assertEq(dai.balanceOf(escrow), 50e18, "the funds stay in the escrow");

    escrowFactory.deploy(args);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature = _eoaSign(
      OWNER_KEY, _recoverERC20Digest(address(SkyEscrow(escrow)), target, address(dai), REQUEST_NONCE, deadline)
    );
    SkyEscrow(escrow).recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);

    assertEq(dai.balanceOf(target), 50e18);
  }

  function test_GivenAnUnstakeUnderTheDaiPortalCut_WhenRun_ThenReverts() external {
    SkyEscrow.Args memory args = _args(1);
    dai.mint(escrowFactory.predictEscrowAddress(args), ESCROW_TIP + DAI_PORTAL_CUT);

    vm.expectRevert(CoreErrors.OxidePortal__AmountNotAboveFpcFundingCut.selector);
    escrowFactory.deployAndExecute(args);
  }

  function test_GivenBothRoutes_ThenTheRunGasIsMeasured() external {
    SkyEscrow.Args memory stake = _args(0);
    dai.mint(escrowFactory.predictEscrowAddress(stake), 100e18);
    vm.prank(RELAYER);
    uint256 before = gasleft();
    escrowFactory.deployAndExecute(stake);
    uint256 stakeGas = before - gasleft();

    SkyEscrow.Args memory unstake = _args(1);
    dai.mint(escrowFactory.predictEscrowAddress(unstake), 100e18);
    vm.prank(RELAYER);
    before = gasleft();
    escrowFactory.deployAndExecute(unstake);
    uint256 unstakeGas = before - gasleft();

    console2.log("mocks: SkyEscrowFactory.deployAndExecute, stake route, gas:", stakeGas);
    console2.log("mocks: SkyEscrowFactory.deployAndExecute, unstake route, gas:", unstakeGas);
  }

  function test_GivenAFrozenDaiPortal_WhenAnUnstakeRuns_ThenItRevertsAndTheOwnerRecovers() external {
    SkyEscrow.Args memory args = _args(1);
    address escrow = escrowFactory.predictEscrowAddress(args);
    dai.mint(escrow, 50e18);
    vm.prank(OWNER);
    portal.freeze();

    vm.prank(RELAYER);
    vm.expectRevert(CoreErrors.OxidePortal__FrozenPortal.selector);
    escrowFactory.deployAndExecute(args);
    assertEq(dai.balanceOf(escrow), 50e18, "the funds stay in the escrow");
    assertEq(dai.balanceOf(RELAYER), 0, "no tip is paid");

    _recoverDai(escrowFactory, args, 50e18);
  }

  function test_GivenAnUninitializedDaiPortal_WhenAnUnstakeRuns_ThenItRevertsAndTheOwnerRecovers() external {
    OxidePortal uninitialized = _newPortal(address(dai), DAI_PORTAL_CUT);
    SkyEscrowFactory factory = new SkyEscrowFactory(_skyRoute(), uninitialized, sUsdsPortal, skyExecutor);
    SkyEscrow.Args memory args = _args(1);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, 50e18);

    vm.prank(RELAYER);
    vm.expectRevert(CoreErrors.OxidePortal__Uninitialized.selector);
    factory.deployAndExecute(args);
    assertEq(dai.balanceOf(escrow), 50e18, "the funds stay in the escrow");

    _recoverDai(factory, args, 50e18);
  }

  function test_GivenAFullSUsdsPortalBucket_WhenAStakeRuns_ThenItRevertsUntilTheBucketRefills() external {
    OxidePortal cappedSUsdsPortal = _cappedPortal(address(sUsds), 0, bytes32(uint256(0xCA95)));
    SkyWithdrawalExecutor cappedExecutor = new SkyWithdrawalExecutor(cappedSUsdsPortal, _skyRoute());
    SkyEscrowFactory factory = new SkyEscrowFactory(_skyRoute(), portal, cappedSUsdsPortal, cappedExecutor);
    uint256 filled = _mintShares(address(this), 90e18);
    sUsds.approve(address(cappedSUsdsPortal), filled);
    cappedSUsdsPortal.deposit(keccak256("another-user"), filled);
    assertEq(cappedSUsdsPortal.getCurrentAvailable(), 10e18, "the bucket is nearly full");

    SkyEscrow.Args memory args = _args(0);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, 50e18);

    vm.prank(RELAYER);
    vm.expectRevert(CoreErrors.Caps__GlobalLimitSurpassed.selector);
    factory.deployAndExecute(args);
    assertEq(dai.balanceOf(escrow), 50e18, "the funds stay in the escrow as dai");
    assertEq(sUsds.balanceOf(escrow), 0);

    vm.warp(block.timestamp + 40);
    vm.prank(RELAYER);
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), 0, "the run succeeds after the bucket refills");
    assertEq(sUsds.balanceOf(address(cappedSUsdsPortal)), filled + 48e18);
    assertEq(dai.balanceOf(RELAYER), ESCROW_TIP);
  }

  function test_GivenAFullDaiPortalBucket_WhenAnUnstakeRuns_ThenItRevertsUntilTheBucketRefills() external {
    OxidePortal cappedDaiPortal = _cappedPortal(address(dai), DAI_PORTAL_CUT, bytes32(uint256(0xCADA1)));
    SkyEscrowFactory factory = new SkyEscrowFactory(_skyRoute(), cappedDaiPortal, sUsdsPortal, skyExecutor);
    dai.mint(address(this), 90e18);
    dai.approve(address(cappedDaiPortal), 90e18);
    cappedDaiPortal.deposit(keccak256("another-user"), 90e18);
    assertEq(cappedDaiPortal.getCurrentAvailable(), 10.5e18, "the bucket is nearly full");

    SkyEscrow.Args memory args = _args(1);
    address escrow = factory.predictEscrowAddress(args);
    dai.mint(escrow, 50e18);

    vm.prank(RELAYER);
    vm.expectRevert(CoreErrors.Caps__GlobalLimitSurpassed.selector);
    factory.deployAndExecute(args);
    assertEq(dai.balanceOf(escrow), 50e18, "the funds stay in the escrow");

    vm.warp(block.timestamp + 40);
    uint256 portalBefore = dai.balanceOf(address(cappedDaiPortal));
    vm.prank(RELAYER);
    factory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), 0, "the run succeeds after the bucket refills");
    assertEq(dai.balanceOf(address(cappedDaiPortal)) - portalBefore, 48e18 - DAI_PORTAL_CUT);
    assertEq(dai.balanceOf(RELAYER), ESCROW_TIP);
  }

  function test_GivenAStakeThatMintsZeroShares_WhenRun_ThenItRevertsAndTheOwnerRecovers() external {
    sUsds.setPricePerShare(1.25e18);
    SkyEscrow.Args memory args = _args(0);
    address escrow = escrowFactory.predictEscrowAddress(args);
    dai.mint(escrow, ESCROW_TIP + 1);
    assertEq(sUsds.convertToShares(1), 0, "one wei of dai mints no share");

    vm.prank(RELAYER);
    vm.expectRevert(CoreErrors.OxidePortal__AmountNotAboveFpcFundingCut.selector);
    escrowFactory.deployAndExecute(args);
    assertEq(dai.balanceOf(escrow), ESCROW_TIP + 1, "the funds stay in the escrow");
    assertEq(dai.balanceOf(RELAYER), 0);

    _recoverDai(escrowFactory, args, ESCROW_TIP + 1);
  }

  function test_GivenAContractOwner_WhenItSignsAWithdrawInShares_ThenTheEscrowHoldsTheShares() external {
    uint256 signerKey = 0x5161;
    MockERC1271Account account = new MockERC1271Account(vm.addr(signerKey));
    SkyEscrow.Args memory args = _args(1);
    args.recoveryCommitment = RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account));
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(args));
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory withdrawal =
      _skyWithdrawArgs(10e18, abi.encode(address(escrow), 0), abi.encode(address(0), address(0)));
    converter.setBroken(true);
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _rawSign(signerKey, escrow.withdrawInSharesDigest(withdrawal.withdrawalId, REQUEST_NONCE, deadline));

    vm.prank(RELAYER);
    escrow.withdrawInShares(withdrawal, RECOVERY_SALT, address(account), signature, REQUEST_NONCE, deadline);

    assertTrue(sUsdsPortal.$isWithdrawalSpent(withdrawal.withdrawalId));
    assertEq(sUsds.balanceOf(address(escrow)), 10e18);
    assertTrue(escrow.usedNonces(REQUEST_NONCE));
  }

  function test_GivenAContractOwner_WhenAnotherKeySignsAWithdrawInShares_ThenReverts() external {
    MockERC1271Account account = new MockERC1271Account(vm.addr(0x5161));
    SkyEscrow.Args memory args = _args(1);
    args.recoveryCommitment = RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account));
    SkyEscrow escrow = SkyEscrow(escrowFactory.deploy(args));
    _fundSUsdsPortal(10e18);
    IOxidePortal.WithdrawArgs memory withdrawal =
      _skyWithdrawArgs(10e18, abi.encode(address(escrow), 0), abi.encode(address(0), address(0)));
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _rawSign(0x5162, escrow.withdrawInSharesDigest(withdrawal.withdrawalId, REQUEST_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    escrow.withdrawInShares(withdrawal, RECOVERY_SALT, address(account), signature, REQUEST_NONCE, deadline);

    assertFalse(sUsdsPortal.$isWithdrawalSpent(withdrawal.withdrawalId));
    assertEq(sUsds.balanceOf(address(escrow)), 0);
    assertFalse(escrow.usedNonces(REQUEST_NONCE));
  }

  function test_GivenANonceSpentByATokenRecovery_WhenReusedByAnEthRecoveryOrAWithdrawInShares_ThenReverts() external {
    (SkyEscrow escrow, IOxidePortal.WithdrawArgs memory withdrawal, uint256 deadline) = _nonceFixture();
    escrow.recoverERC20(
      RECOVERY_SALT,
      escrowOwner,
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline)),
      target,
      address(dai),
      REQUEST_NONCE,
      deadline
    );

    _expectEthRecoveryNonceReuse(escrow, deadline);
    _expectWithdrawInSharesNonceReuse(escrow, withdrawal, deadline);
  }

  function test_GivenANonceSpentByAnEthRecovery_WhenReusedByATokenRecoveryOrAWithdrawInShares_ThenReverts() external {
    (SkyEscrow escrow, IOxidePortal.WithdrawArgs memory withdrawal, uint256 deadline) = _nonceFixture();
    escrow.recoverETH(
      RECOVERY_SALT,
      escrowOwner,
      _eoaSign(OWNER_KEY, _recoverETHDigest(address(escrow), target, REQUEST_NONCE, deadline)),
      target,
      REQUEST_NONCE,
      deadline
    );

    _expectTokenRecoveryNonceReuse(escrow, deadline);
    _expectWithdrawInSharesNonceReuse(escrow, withdrawal, deadline);
  }

  function test_GivenANonceSpentByAWithdrawInShares_WhenReusedByATokenOrAnEthRecovery_ThenReverts() external {
    (SkyEscrow escrow, IOxidePortal.WithdrawArgs memory withdrawal, uint256 deadline) = _nonceFixture();
    escrow.withdrawInShares(
      withdrawal,
      RECOVERY_SALT,
      escrowOwner,
      _eoaSign(OWNER_KEY, escrow.withdrawInSharesDigest(withdrawal.withdrawalId, REQUEST_NONCE, deadline)),
      REQUEST_NONCE,
      deadline
    );
    assertEq(sUsds.balanceOf(address(escrow)), 10e18);

    _expectTokenRecoveryNonceReuse(escrow, deadline);
    _expectEthRecoveryNonceReuse(escrow, deadline);

    bytes32 freshNonce = keccak256("sky-fresh-nonce");
    escrow.recoverERC20(
      RECOVERY_SALT,
      escrowOwner,
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(sUsds), freshNonce, deadline)),
      target,
      address(sUsds),
      freshNonce,
      deadline
    );
    assertEq(sUsds.balanceOf(target), 10e18, "a fresh nonce still recovers");
  }

  function test_GivenDustSharesInAFundedUnstakeEscrow_WhenSkyIsPaused_ThenTheRunReverts_PinsCurrentBehaviour()
    external
  {
    SkyEscrow.Args memory args = _args(1);
    address escrow = escrowFactory.predictEscrowAddress(args);
    dai.mint(escrow, 50e18);
    converter.setBroken(true);

    uint256 withoutDust = vm.snapshotState();
    vm.prank(RELAYER);
    escrowFactory.deployAndExecute(args);
    assertEq(dai.balanceOf(escrow), 0, "without dust shares, a dai-only unstake run does not need Sky");
    vm.revertToState(withoutDust);

    address griefer = makeAddr("griefer");
    _mintShares(griefer, 1);
    vm.prank(griefer);
    sUsds.transfer(escrow, 1);

    vm.prank(RELAYER);
    vm.expectRevert(MockDaiUsds.MockDaiUsds__Paused.selector);
    escrowFactory.deployAndExecute(args);
    assertEq(dai.balanceOf(escrow), 50e18, "one wei of shares blocks the run while Sky is paused");
    assertEq(sUsds.balanceOf(escrow), 1);

    uint256 beforeRecovery = vm.snapshotState();
    _recoverDai(escrowFactory, args, 50e18);
    vm.revertToState(beforeRecovery);

    converter.setBroken(false);
    uint256 portalBefore = dai.balanceOf(address(portal));
    vm.prank(RELAYER);
    escrowFactory.deployAndExecute(args);

    assertEq(dai.balanceOf(escrow), 0, "the run succeeds once Sky works again");
    assertEq(sUsds.balanceOf(escrow), 0);
    assertEq(dai.balanceOf(address(portal)) - portalBefore, 50e18 + 1 - ESCROW_TIP - DAI_PORTAL_CUT);
  }

  function _cappedPortal(address _underlying, uint256 _cut, bytes32 _l2Portal) internal returns (OxidePortal capped) {
    capped = new OxidePortal(
      OWNER,
      OxidePortal.FpcFunding({funder: FPC_FUNDER, cut: _cut}),
      certManager,
      nitroValidator,
      IERC20(_underlying),
      IRegistry(address(registry)),
      ROLLUP_VERSION,
      OxidePortal.RefundVerifiers({
        frozenNotes: IVerifier(address(frozenNotesRefundVerifier)),
        frozenDeposit: IVerifier(address(frozenDepositRefundVerifier)),
        unprocessedDeposit: IVerifier(address(unprocessedDepositRefundVerifier))
      }),
      RATE,
      CAPPED_GLOBAL_LIMIT
    );
    _initializeAndRegister(capped, _l2Portal);
  }

  function _recoverDai(SkyEscrowFactory _factory, SkyEscrow.Args memory _escrowArgs, uint256 _amount) internal {
    SkyEscrow escrow = SkyEscrow(_factory.deploy(_escrowArgs));
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory signature =
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(escrow), target, address(dai), REQUEST_NONCE, deadline));
    uint256 targetBefore = dai.balanceOf(target);

    escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, deadline);

    assertEq(dai.balanceOf(target) - targetBefore, _amount, "the owner recovers the dai");
    assertEq(dai.balanceOf(address(escrow)), 0);
  }

  function _nonceFixture()
    internal
    returns (SkyEscrow escrow, IOxidePortal.WithdrawArgs memory withdrawal, uint256 deadline)
  {
    escrow = _deployFunded(_args(1), 10e18);
    vm.deal(address(escrow), 1 ether);
    _fundSUsdsPortal(10e18);
    withdrawal = _skyWithdrawArgs(10e18, abi.encode(address(escrow), 0), abi.encode(address(0), address(0)));
    deadline = block.timestamp + 1 hours;
  }

  function _expectTokenRecoveryNonceReuse(SkyEscrow _escrow, uint256 _deadline) internal {
    dai.mint(address(_escrow), 1e18);
    bytes memory signature =
      _eoaSign(OWNER_KEY, _recoverERC20Digest(address(_escrow), target, address(dai), REQUEST_NONCE, _deadline));
    vm.expectRevert(EscrowBase.EscrowBase__NonceAlreadyUsed.selector);
    _escrow.recoverERC20(RECOVERY_SALT, escrowOwner, signature, target, address(dai), REQUEST_NONCE, _deadline);
  }

  function _expectEthRecoveryNonceReuse(SkyEscrow _escrow, uint256 _deadline) internal {
    vm.deal(address(_escrow), 1 ether);
    bytes memory signature = _eoaSign(OWNER_KEY, _recoverETHDigest(address(_escrow), target, REQUEST_NONCE, _deadline));
    vm.expectRevert(EscrowBase.EscrowBase__NonceAlreadyUsed.selector);
    _escrow.recoverETH(RECOVERY_SALT, escrowOwner, signature, target, REQUEST_NONCE, _deadline);
  }

  function _expectWithdrawInSharesNonceReuse(
    SkyEscrow _escrow,
    IOxidePortal.WithdrawArgs memory _withdrawal,
    uint256 _deadline
  ) internal {
    bytes memory signature = _eoaSign(
      OWNER_KEY, _escrow.withdrawInSharesDigest(_withdrawal.withdrawalId, REQUEST_NONCE, _deadline)
    );
    vm.expectRevert(EscrowBase.EscrowBase__NonceAlreadyUsed.selector);
    _escrow.withdrawInShares(_withdrawal, RECOVERY_SALT, escrowOwner, signature, REQUEST_NONCE, _deadline);
    assertFalse(sUsdsPortal.$isWithdrawalSpent(_withdrawal.withdrawalId), "the withdrawal stays unspent");
  }

  function _args(uint8 _route) internal view returns (SkyEscrow.Args memory) {
    return SkyEscrow.Args({
      route: _route,
      recipientCommitment: RECIPIENT_COMMITMENT,
      recoveryCommitment: RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, escrowOwner),
      relayerTip: ESCROW_TIP,
      nonce: ESCROW_NONCE
    });
  }

  function _deployFunded(SkyEscrow.Args memory _escrowArgs, uint256 _amount) internal returns (SkyEscrow escrow) {
    escrow = SkyEscrow(escrowFactory.deploy(_escrowArgs));
    dai.mint(address(escrow), _amount);
  }

  function _recoverERC20Digest(address _escrow, address _target, address _token, bytes32 _nonce, uint256 _deadline)
    internal
    view
    returns (bytes32)
  {
    return keccak256(abi.encode(_escrow, block.chainid, _target, _token, _nonce, _deadline));
  }

  function _recoverETHDigest(address _escrow, address _target, bytes32 _nonce, uint256 _deadline)
    internal
    view
    returns (bytes32)
  {
    return keccak256(abi.encode(_escrow, block.chainid, _target, _nonce, _deadline));
  }

  function _eoaSign(uint256 _key, bytes32 _digest) internal pure returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(_key, MessageHashUtils.toEthSignedMessageHash(_digest));
    return abi.encodePacked(r, s, v);
  }

  function _rawSign(uint256 _key, bytes32 _digest) internal pure returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(_key, _digest);
    return abi.encodePacked(r, s, v);
  }
}
