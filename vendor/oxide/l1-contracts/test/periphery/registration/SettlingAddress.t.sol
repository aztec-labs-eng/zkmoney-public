// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistrationTestBase} from "./RegistrationTestBase.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {Errors} from "@periphery/Errors.sol";

contract SettlingAddressTest is RegistrationTestBase {
  uint256 internal constant DEPOSIT = 100 ether;

  address internal attacker = makeAddr("attacker");

  function _deadline() internal view returns (uint256) {
    return block.timestamp + 1 days;
  }

  function _parallelSIPA(bytes memory registrationData, bytes32 recovery, bool resweepable)
    internal
    returns (SIPABase sipa)
  {
    sipa = SIPABase(
      sipaFactory.deploySIPA(
        address(registrationSIPAImplementation), keccak256(registrationData), recovery, ROLLUP_VERSION, resweepable
      )
    );
    assertTrue(sipaFactory.isBlessed(address(sipa)), "provenance admits it; only the consent does not");
    underlying.mint(address(sipa), REGISTRATION_MIN + REGISTRATION_FEE);
  }

  function test_aParallelSIPAOverTheSameIntentCannotSettle() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase victim = _deployAndFund(registrationData, DEPOSIT);
    SIPABase parallel = _parallelSIPA(registrationData, _recoveryCommitment("attackerRecovery"), true);
    assertNotEq(address(parallel), address(victim));

    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    uint256 nonce = nextNonce++;
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nonce, _deadline());

    vm.prank(attacker);
    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    parallel.sweep(address(underlying), attacker, registrationData, _regProofs(consent, auth, _noTerms()));

    assertEq(nameRegistry.ownerOf(NAME_HASH), address(0));
    assertFalse(nameRegistry.usedDomainOwnerNonces(nonce));
    _sweepRegistration(victim, registrationData, consent, auth, _noTerms());
    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(address(victim)), 0);
  }

  function test_aParallelSIPADifferingOnlyInResweepableCannotSettle() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase victim = _deployAndFund(registrationData, DEPOSIT);
    SIPABase parallel = _parallelSIPA(registrationData, regRecovery, false);
    assertNotEq(address(parallel), address(victim));
    assertEq(parallel.recoveryCommitment(), victim.recoveryCommitment());
    assertEq(parallel.intentHash(), victim.intentHash());

    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.prank(attacker);
    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    parallel.sweep(address(underlying), attacker, registrationData, _regProofs(consent, auth, _noTerms()));
  }

  function test_reEncodedRoutingOnTheAttackersOwnSIPACannotSettle() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);

    bytes memory reRouted = _registrationDataRouted(
      NAME_HASH,
      defaultOwner,
      REGISTRATION_FEE,
      FEE_BENEFICIARY,
      keccak256("attacker-l2-recipient"),
      keccak256("attacker-portal-recipient")
    );
    assertNotEq(keccak256(reRouted), keccak256(registrationData));

    SIPABase reRoutedSipa = _parallelSIPA(reRouted, _recoveryCommitment("attackerRecovery"), true);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.prank(attacker);
    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    reRoutedSipa.sweep(address(underlying), attacker, reRouted, _regProofs(consent, auth, _noTerms()));
  }

  function test_reEncodedRoutingCannotSettleEvenWhenItPostsTheWholeFloor() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    bytes memory reRouted = _registrationDataRouted(
      NAME_HASH, defaultOwner, REGISTRATION_FEE, FEE_BENEFICIARY, keccak256("attacker-l2-recipient"), bytes32(0)
    );

    SIPABase reRoutedSipa = SIPABase(
      sipaFactory.deploySIPA(
        address(registrationSIPAImplementation),
        keccak256(reRouted),
        _recoveryCommitment("attackerRecovery"),
        ROLLUP_VERSION,
        true
      )
    );
    underlying.mint(address(reRoutedSipa), DEPOSIT);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.prank(attacker);
    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    reRoutedSipa.sweep(address(underlying), attacker, reRouted, _regProofs(consent, auth, _noTerms()));
  }

  function test_reEncodedBeneficiaryCannotDivertTheFeeToAnotherAllowlistedFunder() external {
    address rival = makeAddr("rivalFunder");
    vm.prank(regDomainOwner);
    registrationController.addBeneficiary(rival);

    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);

    bytes memory diverted = _registrationDataRouted(
      NAME_HASH, defaultOwner, REGISTRATION_FEE, rival, RECIPIENT_COMMITMENT, NAME_PORTAL_RECIPIENT
    );
    assertTrue(registrationController.isBeneficiary(rival));
    assertNotEq(keccak256(diverted), keccak256(registrationData));

    SIPABase divertedSipa = _parallelSIPA(diverted, _recoveryCommitment("rivalRecovery"), true);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.prank(rival);
    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    divertedSipa.sweep(address(underlying), rival, diverted, _regProofs(consent, auth, _noTerms()));

    assertEq(underlying.balanceOf(rival), 0, "no fee was diverted");

    underlying.mint(address(divertedSipa), REGISTRATION_MIN + REGISTRATION_FEE);
    bytes memory forDiverted = _consentSigAt(bootstrapKey, diverted, address(divertedSipa));
    vm.prank(rival);
    divertedSipa.sweep(address(underlying), rival, diverted, _regProofs(forDiverted, auth, _noTerms()));
    assertEq(underlying.balanceOf(rival), REGISTRATION_FEE);
  }

  function test_consentThatDoesNotNameTheSIPAReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    (bytes memory recordData,,,) = abi.decode(registrationData, (bytes, uint256, bytes32, bytes32));

    bytes32 unbound = keccak256(abi.encode(recordData, block.chainid, nameRegistry.accountMetadataRegistry()));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(bootstrapKey, unbound);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    _sweepRegistration(sipa, registrationData, abi.encodePacked(r, s, v), auth, _noTerms());
  }

  function test_aConsentIsUsableAtExactlyOneAddress() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase first = _deployAndFund(registrationData, DEPOSIT);
    SIPABase second = _parallelSIPA(registrationData, _recoveryCommitment("secondRecovery"), true);
    underlying.mint(address(second), DEPOSIT);

    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    bytes memory forFirst = _consentSig(bootstrapKey, registrationData);
    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    _sweepRegistration(second, registrationData, forFirst, auth, _noTerms());

    bytes memory forSecond = _consentSigAt(bootstrapKey, registrationData, address(second));
    second.sweep(address(underlying), relayer, registrationData, _regProofs(forSecond, auth, _noTerms()));
    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(address(second)), 0);
    assertEq(underlying.balanceOf(address(first)), DEPOSIT);
  }

  function test_theRecordAloneDoesNotDetermineTheDigest() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    bytes memory a = _consentSigAt(bootstrapKey, registrationData, makeAddr("sipaA"));
    bytes memory b = _consentSigAt(bootstrapKey, registrationData, makeAddr("sipaB"));
    assertNotEq(keccak256(a), keccak256(b));
  }
}
