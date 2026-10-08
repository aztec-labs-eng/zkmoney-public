// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {RegistrationTestBase} from "./RegistrationTestBase.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {RegistrationSIPA, REGISTRATION_SWEEP_FEE} from "@periphery/RegistrationSIPA.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {INameRegistry, DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {R1Install} from "@periphery/interfaces/IRegistrationController.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Errors} from "@periphery/Errors.sol";

contract ControllerRotationTest is RegistrationTestBase {
  uint256 internal constant NEXT_MIN = 200 ether;
  uint256 internal constant NEXT_FEE = 20 ether;
  address internal nextBeneficiary = makeAddr("nextBeneficiary");

  function _rotate() internal returns (RegistrationController next) {
    sipaFactory = new SIPAFactory(OWNER);
    registrationSIPAImplementation =
      new RegistrationSIPA(IOxidePortal(address(portal)), INameRegistry(address(nameRegistry)), REGISTRATION_SWEEP_FEE);
    next = _deployController(NEXT_MIN, NEXT_FEE, nextBeneficiary);
    vm.startPrank(OWNER);
    sipaFactory.bless(address(registrationSIPAImplementation));
    nameRegistry.updateRegistrationController(address(next));
    vm.stopPrank();
  }

  function test_rotationRetiresFundedRegistrationsOfThePreviousFactory() public {
    bytes memory data = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(data, REGISTRATION_MIN + REGISTRATION_FEE);
    bytes memory consent = _consentSig(bootstrapKey, data);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);
    RegistrationController next = _rotate();

    vm.expectRevert(abi.encodeWithSelector(Errors.RegistrationController__CallerNotSIPA.selector, address(sipa)));
    _sweepRegistration(sipa, data, consent, auth, _noTerms());
    assertEq(nameRegistry.registrationController(), address(next));
    assertEq(nameRegistry.nameOf(defaultOwner), bytes32(0));
    assertEq(underlying.balanceOf(address(sipa)), REGISTRATION_MIN + REGISTRATION_FEE);
  }

  function test_claimedNameSurvivesRotationAndCannotBeReclaimed() public {
    bytes memory data = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(data, REGISTRATION_MIN + REGISTRATION_FEE);
    _sweepRegistration(
      sipa,
      data,
      _consentSig(bootstrapKey, data),
      _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days),
      _noTerms()
    );
    _rotate();
    assertEq(nameRegistry.nameOf(defaultOwner), NAME_HASH);
    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);

    uint256 otherKey = 12_345;
    address otherOwner = _ownerOf(otherKey);
    bytes memory otherData = _registrationDataFor(NEXT_FEE, nextBeneficiary, NAME_HASH, otherOwner);
    SIPABase otherSipa = _deployAndFund(otherData, NEXT_MIN + NEXT_FEE);
    bytes memory otherConsent = _consentSig(otherKey, otherData);
    DomainAuth memory otherAuth = _domainAuth(NAME_HASH, otherOwner, nextNonce++, block.timestamp + 1 days);
    R1Install memory otherR1 = _r1Install(otherKey, otherOwner);
    bytes memory proofs = _regProofs(vm.addr(otherKey), otherConsent, otherAuth, _noTerms(), otherR1);

    vm.expectRevert(Errors.NameRegistry__NameAlreadyRegistered.selector);
    otherSipa.sweep(address(underlying), relayer, otherData, proofs);
    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(address(otherSipa)), NEXT_MIN + NEXT_FEE);
  }
}
