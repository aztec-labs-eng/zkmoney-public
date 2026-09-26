// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {SIPABase} from "@periphery/SIPABase.sol";
import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {RegistriesTestBase} from "@test/periphery/registries/RegistriesTestBase.sol";
import {Errors} from "@periphery/Errors.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";

contract SIPAFactoryTest is RegistriesTestBase {
  function testFuzz_deployMatchesPredictionAndWiresImmutables(
    bytes32 intentHash,
    bytes32 recoveryCommitment,
    uint256 rollupVersion,
    bool resweepable
  ) public {
    recoveryCommitment = bytes32(uint256(recoveryCommitment) >> (256 - RecoveryCommitmentLib.L2_FIELD_SAFE_BITS));
    address impl = address(depositSIPAImplementation);

    address predicted = sipaFactory.predictSIPA(impl, intentHash, recoveryCommitment, rollupVersion, resweepable);
    address deployed = sipaFactory.deploySIPA(impl, intentHash, recoveryCommitment, rollupVersion, resweepable);

    assertEq(deployed, predicted);
    assertGt(deployed.code.length, 0);

    SIPABase sipa = SIPABase(deployed);
    assertEq(sipa.intentHash(), intentHash);
    assertEq(sipa.recoveryCommitment(), recoveryCommitment);
    assertEq(sipa.rollupVersion(), rollupVersion);
    assertEq(sipa.resweepable(), resweepable);
    assertEq(address(sipa.portal()), address(mockPortal), "the portal is the implementation's, not an argument");
    assertEq(sipa.depositFee(), DEPOSIT_FEE, "the fee is the implementation's, not an argument");
  }

  function test_recoveryCommitmentLargerThanAFieldReverts() public {
    address impl = address(depositSIPAImplementation);
    bytes32 large = bytes32(uint256(1) << RecoveryCommitmentLib.L2_FIELD_SAFE_BITS);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPAFactory__RecoveryCommitmentTooLarge.selector, large));
    sipaFactory.predictSIPA(impl, keccak256("intent"), large, ROLLUP_VERSION, true);
    vm.expectRevert(abi.encodeWithSelector(Errors.SIPAFactory__RecoveryCommitmentTooLarge.selector, large));
    sipaFactory.deploySIPA(impl, keccak256("intent"), large, ROLLUP_VERSION, true);
  }

  function test_deployTwiceWithSameParamsReverts() public {
    address impl = address(depositSIPAImplementation);
    bytes32 intentHash = keccak256("intent");
    bytes32 recovery = RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0));

    sipaFactory.deploySIPA(impl, intentHash, recovery, ROLLUP_VERSION, true);

    vm.expectRevert();
    sipaFactory.deploySIPA(impl, intentHash, recovery, ROLLUP_VERSION, true);
  }

  function test_unblessedImplementationCloneFailsIsSIPA() public {
    address rogue = address(new DepositSIPA(IOxidePortal(address(mockPortal)), DEPOSIT_FEE));
    address clone = sipaFactory.deploySIPA(
      rogue,
      keccak256("intent"),
      RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0)),
      ROLLUP_VERSION,
      true
    );
    assertFalse(sipaFactory.isBlessed(clone));

    address blessed = sipaFactory.deploySIPA(
      address(depositSIPAImplementation),
      keccak256("intent"),
      RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0)),
      ROLLUP_VERSION,
      true
    );
    assertTrue(sipaFactory.isBlessed(blessed));
  }

  function test_eachParamChangesAddress() public {
    address impl = address(depositSIPAImplementation);
    bytes32 intentHash = keccak256("intent");
    bytes32 recovery = RecoveryCommitmentLib.deriveRecoveryCommitment(keccak256("recovery"), address(0));
    address base = sipaFactory.predictSIPA(impl, intentHash, recovery, ROLLUP_VERSION, true);

    assertNotEq(
      sipaFactory.predictSIPA(address(registrationSIPAImplementation), intentHash, recovery, ROLLUP_VERSION, true), base
    );
    assertNotEq(sipaFactory.predictSIPA(impl, keccak256("other"), recovery, ROLLUP_VERSION, true), base);
    assertNotEq(sipaFactory.predictSIPA(impl, intentHash, bytes32(uint256(1)), ROLLUP_VERSION, true), base);
    assertNotEq(sipaFactory.predictSIPA(impl, intentHash, recovery, ROLLUP_VERSION + 1, true), base);
    assertNotEq(sipaFactory.predictSIPA(impl, intentHash, recovery, ROLLUP_VERSION, false), base);
  }
}
