// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {SIPABase} from "@periphery/SIPABase.sol";
import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {RegistriesTestBase} from "@test/periphery/registries/RegistriesTestBase.sol";
import {Errors} from "@periphery/Errors.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {ForwardingTableFixture, DEPOSIT_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {Clones} from "@oz/proxy/Clones.sol";
import {ForwardingTable} from "@periphery/ForwardingTable.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";

contract SIPAFactoryTest is RegistriesTestBase {
  function testFuzz_deployMatchesPredictionAndWiresImmutables(
    bytes32 intentHash,
    bytes32 recoveryCommitment,
    uint256 rollupVersion,
    bool resweepable
  ) public {
    recoveryCommitment = bytes32(uint256(recoveryCommitment) >> (256 - RecoveryCommitmentLib.L2_FIELD_SAFE_BITS));
    address impl = address(depositSIPAImplementation);

    address predicted =
      sipaFactory.predictSIPA(impl, intentHash, recoveryCommitment, rollupVersion, resweepable, forwardingTable);
    address deployed =
      sipaFactory.deploySIPA(impl, intentHash, recoveryCommitment, rollupVersion, resweepable, forwardingTable);

    assertEq(deployed, predicted);
    assertGt(deployed.code.length, 0);

    SIPABase sipa = SIPABase(deployed);
    assertEq(sipa.intentHash(), intentHash);
    assertEq(sipa.recoveryCommitment(), recoveryCommitment);
    assertEq(sipa.rollupVersion(), rollupVersion);
    assertEq(sipa.resweepable(), resweepable);
    assertEq(address(sipa.forwardingTable()), address(forwardingTable));
    (IOxidePortal portal_, uint256 sweepTip,) = sipa.route(address(mockUnderlying));
    assertEq(address(portal_), address(mockPortal), "the portal is the table's row");
    assertEq(sweepTip, DEPOSIT_SWEEP_TIP, "the tip is the table's row");
  }

  function test_recoveryCommitmentLargerThanAFieldReverts() public {
    address impl = address(depositSIPAImplementation);
    bytes32 large = bytes32(uint256(1) << RecoveryCommitmentLib.L2_FIELD_SAFE_BITS);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPAFactory__RecoveryCommitmentTooLarge.selector, large));
    sipaFactory.predictSIPA(impl, keccak256("intent"), large, ROLLUP_VERSION, true, forwardingTable);
    vm.expectRevert(abi.encodeWithSelector(Errors.SIPAFactory__RecoveryCommitmentTooLarge.selector, large));
    sipaFactory.deploySIPA(impl, keccak256("intent"), large, ROLLUP_VERSION, true, forwardingTable);
  }

  function test_deployTwiceWithSameParamsReverts() public {
    address impl = address(depositSIPAImplementation);
    bytes32 intentHash = keccak256("intent");
    bytes32 recovery = RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0));

    sipaFactory.deploySIPA(impl, intentHash, recovery, ROLLUP_VERSION, true, forwardingTable);

    vm.expectRevert();
    sipaFactory.deploySIPA(impl, intentHash, recovery, ROLLUP_VERSION, true, forwardingTable);
  }

  function test_unblessedImplementationCloneFailsIsSIPA() public {
    address rogue = address(new DepositSIPA());
    address clone = sipaFactory.deploySIPA(
      rogue,
      keccak256("intent"),
      RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0)),
      ROLLUP_VERSION,
      true,
      forwardingTable
    );
    assertFalse(sipaFactory.isBlessed(clone));

    address blessed = sipaFactory.deploySIPA(
      address(depositSIPAImplementation),
      keccak256("intent"),
      RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0)),
      ROLLUP_VERSION,
      true,
      forwardingTable
    );
    assertTrue(sipaFactory.isBlessed(blessed));
  }

  function test_eachParamChangesAddress() public {
    address impl = address(depositSIPAImplementation);
    bytes32 intentHash = keccak256("intent");
    bytes32 recovery = RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0));
    address base = sipaFactory.predictSIPA(impl, intentHash, recovery, ROLLUP_VERSION, true, forwardingTable);

    assertNotEq(
      sipaFactory.predictSIPA(
        address(registrationSIPAImplementation), intentHash, recovery, ROLLUP_VERSION, true, forwardingTable
      ),
      base
    );
    assertNotEq(
      sipaFactory.predictSIPA(impl, keccak256("other"), recovery, ROLLUP_VERSION, true, forwardingTable), base
    );
    assertNotEq(
      sipaFactory.predictSIPA(impl, intentHash, bytes32(uint256(1)), ROLLUP_VERSION, true, forwardingTable), base
    );
    assertNotEq(sipaFactory.predictSIPA(impl, intentHash, recovery, ROLLUP_VERSION + 1, true, forwardingTable), base);
    assertNotEq(sipaFactory.predictSIPA(impl, intentHash, recovery, ROLLUP_VERSION, false, forwardingTable), base);
    assertNotEq(
      sipaFactory.predictSIPA(
        impl, intentHash, recovery, ROLLUP_VERSION, true, IForwardingTable(makeAddr("otherTable"))
      ),
      base
    );
  }

  function test_aBlessedImplementationCloneOnAnUnapprovedTableIsNotASIPA() public {
    IForwardingTable unapproved = IForwardingTable(makeAddr("unapprovedTable"));
    address clone = sipaFactory.deploySIPA(
      address(depositSIPAImplementation),
      keccak256("intent"),
      RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0)),
      ROLLUP_VERSION,
      true,
      unapproved
    );

    assertTrue(sipaFactory.sipaIntentOf(clone) == SIPABase.Intent.None);
    assertFalse(sipaFactory.isBlessed(clone));
  }

  function test_aCloneWithShortArgsIsNotASIPA() public {
    bytes memory shortArgs = abi.encode(keccak256("intent"), bytes32(0), ROLLUP_VERSION, true);
    address clone = Clones.cloneWithImmutableArgs(address(depositSIPAImplementation), shortArgs);

    assertTrue(sipaFactory.sipaIntentOf(clone) == SIPABase.Intent.None);
  }

  function test_aCloneThatTheFactoryDidNotDeployIsNotASIPA() public {
    bytes memory args = abi.encode(
      SIPABase.Args({
        intentHash: keccak256("intent"),
        recoveryCommitment: bytes32(0),
        rollupVersion: ROLLUP_VERSION,
        resweepable: true,
        table: forwardingTable
      })
    );
    address clone = Clones.cloneWithImmutableArgs(address(depositSIPAImplementation), args);

    assertTrue(sipaFactory.sipaIntentOf(clone) == SIPABase.Intent.None);
  }

  function test_blessImplementationEmitsTheImplementationAndItsIntent() public {
    address nextDeposit = address(new DepositSIPA());

    vm.expectEmit(address(sipaFactory));
    emit SIPAFactory.ImplementationBlessed(nextDeposit, SIPABase.Intent.Deposit);
    vm.prank(registryOwner);
    sipaFactory.blessImplementation(nextDeposit);
  }

  function test_blessTableEmitsTheTable() public {
    ForwardingTable nextTable =
      ForwardingTableFixture.deploy(registryOwner, IOxidePortal(address(mockPortal)), makeAddr("tableBeneficiary"));

    vm.expectEmit(address(sipaFactory));
    emit SIPAFactory.TableBlessed(address(nextTable));
    vm.prank(registryOwner);
    sipaFactory.blessTable(nextTable);
  }
}
