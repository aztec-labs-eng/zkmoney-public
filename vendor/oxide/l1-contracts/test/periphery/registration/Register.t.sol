// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistrationTestBase} from "./RegistrationTestBase.sol";
import {NameRegistry} from "@periphery/NameRegistry.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {SignedTerms, R1Install} from "@periphery/interfaces/IRegistrationController.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {REGISTRATION_SWEEP_FEE} from "@periphery/RegistrationSIPA.sol";
import {Errors} from "@periphery/Errors.sol";

contract RegisterTest is RegistrationTestBase {
  uint256 internal constant DEPOSIT = 100 ether;

  function _deadline() internal view returns (uint256) {
    return block.timestamp + 1 days;
  }

  function _sweepDefault() internal returns (SIPABase sipa, bytes memory registrationData) {
    registrationData = _registrationData(NAME_HASH, defaultOwner);
    sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_registersWritesNameAndRecordPaysOneFeeAndBridges() external {
    uint256 portalBefore = underlying.balanceOf(address(portal));

    (SIPABase sipa,) = _sweepDefault();

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(nameRegistry.nameOf(defaultOwner), NAME_HASH);
    AccountMetadataRegistry.UserRecord memory r = metadataRegistry.getUserRecord(defaultOwner);
    assertEq(r.l2Address, L2_ADDRESS);
    assertEq(r.rollupVersion, ROLLUP_VERSION);
    assertEq(r.publicKey.x, G_X);
    assertEq(r.publicKey.y, G_Y);
    assertEq(r.resolverOperator, resolverOperatorAddr);

    assertEq(underlying.balanceOf(FEE_BENEFICIARY), REGISTRATION_FUNDER_CUT, "the funder takes the fee's remainder");
    assertEq(underlying.balanceOf(relayer), REGISTRATION_SWEEP_FEE, "the relayer's cut comes out of the same fee");
    assertEq(
      underlying.balanceOf(FEE_BENEFICIARY) + underlying.balanceOf(relayer),
      REGISTRATION_FEE,
      "the two shares are the whole fee and nothing more"
    );
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - REGISTRATION_FEE);
    assertEq(underlying.balanceOf(address(sipa)), 0);
  }

  function test_registerInstallsTheR1KeyWithoutEthOnTheAccount() external {
    _sweepDefault();

    OxideAccount.AuthKeyEntry[] memory keys = OxideAccount(payable(defaultOwner)).getAuthKeys();
    assertEq(keys.length, 1);
    assertEq(keys[0].key.qx, r1Key.qx);
    assertEq(keys[0].key.qy, r1Key.qy);
    assertEq(keys[0].metadata, "");
    assertEq(entryPoint.getNonce(defaultOwner, 0), 1);
    assertEq(defaultOwner.balance, 0);
    assertEq(entryPoint.balanceOf(defaultOwner), 0);
  }

  function test_registerInstallsTheR1KeyWithMetadata() external {
    bytes memory metadata = new bytes(1024);
    for (uint256 i = 0; i < metadata.length; i++) {
      metadata[i] = bytes1(uint8(i));
    }
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    _sweepRegistration(
      sipa, registrationData, consent, auth, _noTerms(), _r1InstallWith(bootstrapKey, defaultOwner, r1Key, metadata)
    );

    OxideAccount.AuthKeyEntry[] memory keys = OxideAccount(payable(defaultOwner)).getAuthKeys();
    assertEq(keys.length, 1);
    assertEq(keys[0].metadata, metadata);
  }

  function _accountWithPasskey() internal returns (uint256 passkey) {
    accountFactory.deploy(bootstrap);
    passkey = uint256(keccak256("installed")) % P256_N;
    vm.prank(address(entryPoint));
    OxideAccount(payable(defaultOwner)).addAuthKey(_r1KeyOf(passkey), "");
  }

  function test_registerSkipsTheInstallWhenTheAccountHoldsAKey() external {
    uint256 passkey = _accountWithPasskey();
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _r1ConsentSig(0, passkey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    OxideAccount.AuthKeyEntry[] memory keys = OxideAccount(payable(defaultOwner)).getAuthKeys();
    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(keys.length, 1);
    assertEq(keys[0].key.qx, _r1KeyOf(passkey).qx);
    assertEq(entryPoint.getNonce(defaultOwner, 0), 0);
  }

  function test_consentByTheRetiredBootstrapKeyReverts() external {
    _accountWithPasskey();
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
    assertEq(nameRegistry.ownerOf(NAME_HASH), address(0));
  }

  function test_consentByAnUninstalledPasskeyReverts() external {
    _accountWithPasskey();
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _r1ConsentSig(0, uint256(keccak256("uninstalled")) % P256_N, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_consentOverTheBareDigestReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _bareConsentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_registerWithAnInvalidR1KeyReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    OxideAccount.R1Key memory offCurve = OxideAccount.R1Key({qx: bytes32(uint256(1)), qy: bytes32(uint256(1))});
    R1Install memory r1 = _r1InstallWith(bootstrapKey, defaultOwner, offCurve, "");

    vm.expectRevert(Errors.RegistrationController__R1KeyNotInstalled.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms(), r1);
  }

  function test_registerWithAnR1InstallSignedByAnotherKeyReverts() external {
    (, uint256 attackerKey) = makeAddrAndKey("attacker");
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    R1Install memory r1 = _r1Install(attackerKey, defaultOwner);

    vm.expectPartialRevert(IEntryPoint.FailedOp.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms(), r1);
  }

  function test_bridgesRemainderToRecipientCommitment() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectEmit(true, false, false, false, address(portal));
    emit Deposit(RECIPIENT_COMMITMENT, 0, 0, 0);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_registerEmitsNameClaimed() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    uint256 nonce = nextNonce++;
    uint256 deadline = _deadline();
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nonce, deadline);

    vm.expectEmit(true, true, true, false, address(nameRegistry));
    emit NameRegistry.NameClaimed(defaultOwner, NAME_HASH, nonce, deadline, auth.signature);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_registerWritesIntoCurrentMetadataRegistry() external {
    AccountMetadataRegistry fresh = new AccountMetadataRegistry(nameRegistry);
    vm.prank(OWNER);
    nameRegistry.updateAccountMetadataRegistry(address(fresh));

    _sweepDefault();

    assertTrue(fresh.hasUserRecord(defaultOwner));
    assertFalse(metadataRegistry.hasUserRecord(defaultOwner));
  }

  function test_frontRunnerCannotBrickRegistration() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);

    (, uint256 attackerKey) = makeAddrAndKey("frontRunner");
    bytes memory forged = _consentSig(attackerKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    vm.expectRevert();
    _sweepRegistration(sipa, registrationData, forged, auth, _noTerms());

    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory realAuth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    _sweepRegistration(sipa, registrationData, consent, realAuth, _noTerms());
    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
  }

  function test_depositIntentDoesNotRegister() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase deposit = SIPABase(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(registrationData),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true
      )
    );
    underlying.mint(address(deposit), DEPOSIT);

    deposit.sweep(address(underlying), relayer, registrationData, "");
    assertEq(nameRegistry.ownerOf(NAME_HASH), address(0));
    assertFalse(metadataRegistry.hasUserRecord(defaultOwner));
  }

  function test_swappedRoutingKeysOnFundedSIPARevert() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);

    bytes memory swapped = _registrationDataFull(
      NAME_HASH,
      defaultOwner,
      AccountMetadataRegistry.K1Point(G_X, G_Y),
      keccak256("attacker-l2"),
      resolverOperatorAddr,
      ROLLUP_VERSION,
      REGISTRATION_FEE,
      FEE_BENEFICIARY,
      NAME_PORTAL_RECIPIENT
    );
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(Errors.SIPA__IntentDataMismatch.selector);
    _sweepRegistration(sipa, swapped, consent, auth, _noTerms());
  }

  function test_swappedRoutingKeysOnAttackerSIPAFailConsent() external {
    bytes memory swapped = _registrationDataFull(
      NAME_HASH,
      defaultOwner,
      AccountMetadataRegistry.K1Point(G_X, G_Y),
      keccak256("attacker-l2"),
      resolverOperatorAddr,
      ROLLUP_VERSION,
      REGISTRATION_FEE,
      FEE_BENEFICIARY,
      NAME_PORTAL_RECIPIENT
    );
    SIPABase attackerSipa = _deployAndFund(swapped, DEPOSIT);

    bytes memory original = _registrationData(NAME_HASH, defaultOwner);
    assertNotEq(address(attackerSipa), address(_deployRegistrationSIPA(original)), "swapped record is a different SIPA");

    bytes memory victimConsent = _consentSig(bootstrapKey, original);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert();
    _sweepRegistration(attackerSipa, swapped, victimConsent, auth, _noTerms());
  }

  function test_consentByWrongKeyReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    (, uint256 attackerKey) = makeAddrAndKey("attacker");
    bytes memory forged = _consentSig(attackerKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    _sweepRegistration(sipa, registrationData, forged, auth, _noTerms());
  }

  function test_consentWithAnotherAccountsBootstrapReverts() external {
    (address otherBootstrap, uint256 otherBootstrapKey) = makeAddrAndKey("otherBootstrap");
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(otherBootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    bytes memory proofs = _regProofs(otherBootstrap, consent, auth, _noTerms(), defaultR1Install);

    vm.expectPartialRevert(Errors.RegistrationController__AccountMismatch.selector);
    sipa.sweep(address(underlying), relayer, registrationData, proofs);
  }

  function test_consentBoundToOtherMetadataRegistryReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent =
      _consentSigFor(bootstrapKey, registrationData, makeAddr("otherMetadataRegistry"), address(sipa));
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_wrongFeeTokenReverts() external {
    TestERC20 other = new TestERC20("Other", "OTH", address(this));
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployRegistrationSIPA(registrationData);
    other.mint(address(sipa), DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.RegistrationController__FeeTokenMismatch.selector, address(other), address(underlying)
      )
    );
    sipa.sweep(address(other), relayer, registrationData, _regProofs(consent, auth, _noTerms()));
  }

  function test_claimForDifferentNameReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(keccak256("other.oxide.eth"), defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(Errors.NameRegistry__InvalidDomainSignature.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_sameNameByDifferentOwnerReverts() external {
    _sweepDefault();

    (address bootstrap2, uint256 bootstrapKey2) = makeAddrAndKey("bootstrap2");
    address owner2 = accountFactory.predictAccountAddress(bootstrap2);
    bytes memory data2 = _registrationData(NAME_HASH, owner2);
    SIPABase sipa2 = _deployAndFund(data2, DEPOSIT);
    bytes memory consent2 = _consentSig(bootstrapKey2, data2);
    DomainAuth memory auth2 = _domainAuth(NAME_HASH, owner2, nextNonce++, _deadline());
    bytes memory proofs2 = _regProofs(bootstrap2, consent2, auth2, _noTerms(), _r1Install(bootstrapKey2, owner2));

    vm.expectRevert(Errors.NameRegistry__NameAlreadyRegistered.selector);
    sipa2.sweep(address(underlying), relayer, data2, proofs2);
  }

  function test_sameOwnerTwiceReverts() external {
    _sweepDefault();

    bytes32 name2 = keccak256("second.oxide.eth");
    bytes memory data2 = _registrationData(name2, defaultOwner);
    SIPABase sipa2 = _deployAndFund(data2, DEPOSIT);
    bytes memory consent2 = _r1ConsentSig(0, r1PrivateKey, data2);
    DomainAuth memory auth2 = _domainAuth(name2, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(Errors.NameRegistry__OwnerAlreadyHasName.selector);
    _sweepRegistration(sipa2, data2, consent2, auth2, _noTerms());
  }

  function test_belowFloorReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    uint256 amount = REGISTRATION_MIN + REGISTRATION_FEE - 1;
    SIPABase sipa = _deployAndFund(registrationData, amount);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.RegistrationController__BalanceBelowFloor.selector, amount, REGISTRATION_MIN + REGISTRATION_FEE
      )
    );
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_atTheFloorExactlyTheFloorBridges() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, REGISTRATION_MIN + REGISTRATION_FEE);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    uint256 portalBefore = underlying.balanceOf(address(portal));

    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, REGISTRATION_MIN);
  }

  function test_signedFullyWaivedTermsFloorAtTheRelayerFee() external {
    bytes memory registrationData =
      _registrationDataFor(REGISTRATION_SWEEP_FEE, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms =
      _signedTerms(NAME_HASH, defaultOwner, REGISTRATION_SWEEP_FEE, REGISTRATION_MIN, nextNonce++, _deadline());

    uint256 portalBefore = underlying.balanceOf(address(portal));
    _sweepRegistration(sipa, registrationData, consent, auth, terms);

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), 0, "a waived share pays the funder nothing");
    assertEq(underlying.balanceOf(relayer), REGISTRATION_SWEEP_FEE, "the relayer is still paid");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - REGISTRATION_SWEEP_FEE);
  }

  function test_signedTermsBelowTheRelayerFeeRevert() external {
    uint256 waived = REGISTRATION_SWEEP_FEE - 1;
    bytes memory registrationData = _registrationDataFor(waived, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms = _signedTerms(NAME_HASH, defaultOwner, waived, REGISTRATION_MIN, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(Errors.RegistrationController__FeeBelowRelayerFee.selector, waived, REGISTRATION_SWEEP_FEE)
    );
    _sweepRegistration(sipa, registrationData, consent, auth, terms);
  }

  function test_immutableScheduleBelowTheRelayerFeeReverts() external {
    uint256 tooLow = REGISTRATION_SWEEP_FEE - 1;
    _setController(address(_deployController(REGISTRATION_MIN, tooLow, FEE_BENEFICIARY)));

    bytes memory registrationData = _registrationDataFor(tooLow, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(Errors.RegistrationController__FeeBelowRelayerFee.selector, tooLow, REGISTRATION_SWEEP_FEE)
    );
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_signedReducedTermsRegisterBelowImmutableFloor() external {
    bytes memory registrationData =
      _registrationDataFor(REGISTRATION_SWEEP_FEE, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    uint256 amount = 4 ether;
    SIPABase sipa = _deployAndFund(registrationData, amount);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms =
      _signedTerms(NAME_HASH, defaultOwner, REGISTRATION_SWEEP_FEE, 0, nextNonce++, _deadline());

    uint256 portalBefore = underlying.balanceOf(address(portal));
    _sweepRegistration(sipa, registrationData, consent, auth, terms);

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), 0);
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, amount - REGISTRATION_SWEEP_FEE);
  }

  function test_signedLowerFloorAdmitsBalanceBetweenFloors() external {
    uint256 signedFee = 3.5 ether;
    uint256 signedMin = 5 ether;
    uint256 amount = 9 ether;
    assertLt(amount, REGISTRATION_MIN + REGISTRATION_FEE);

    bytes memory registrationData = _registrationDataFor(signedFee, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, amount);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms = _signedTerms(NAME_HASH, defaultOwner, signedFee, signedMin, nextNonce++, _deadline());

    _sweepRegistration(sipa, registrationData, consent, auth, terms);

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), signedFee - REGISTRATION_SWEEP_FEE);
  }

  function test_signedHigherFloorRejectsBalanceBetweenFloors() external {
    uint256 signedFee = 2 * REGISTRATION_FEE;
    uint256 signedMin = 2 * REGISTRATION_MIN;
    uint256 amount = REGISTRATION_MIN + REGISTRATION_FEE;

    bytes memory registrationData = _registrationDataFor(signedFee, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, amount);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms = _signedTerms(NAME_HASH, defaultOwner, signedFee, signedMin, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(Errors.RegistrationController__BalanceBelowFloor.selector, amount, signedMin + signedFee)
    );
    _sweepRegistration(sipa, registrationData, consent, auth, terms);
  }

  function test_signedHigherFeeIsPaid() external {
    uint256 signedFee = 2 * REGISTRATION_FEE;

    bytes memory registrationData = _registrationDataFor(signedFee, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms =
      _signedTerms(NAME_HASH, defaultOwner, signedFee, REGISTRATION_MIN, nextNonce++, _deadline());

    uint256 portalBefore = underlying.balanceOf(address(portal));
    _sweepRegistration(sipa, registrationData, consent, auth, terms);

    assertEq(underlying.balanceOf(FEE_BENEFICIARY), signedFee - REGISTRATION_SWEEP_FEE);
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - signedFee);
  }

  function test_signedTermsStillEnforceSignedMinDeposit() external {
    bytes memory registrationData =
      _registrationDataFor(REGISTRATION_SWEEP_FEE, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    uint256 amount = REGISTRATION_MIN + REGISTRATION_SWEEP_FEE - 1;
    SIPABase sipa = _deployAndFund(registrationData, amount);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms =
      _signedTerms(NAME_HASH, defaultOwner, REGISTRATION_SWEEP_FEE, REGISTRATION_MIN, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.RegistrationController__BalanceBelowFloor.selector, amount, REGISTRATION_MIN + REGISTRATION_SWEEP_FEE
      )
    );
    _sweepRegistration(sipa, registrationData, consent, auth, terms);
  }

  function test_signedTermsEmitTermsApplied() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    uint256 termsNonce = nextNonce++;
    uint256 termsDeadline = _deadline();
    SignedTerms memory terms =
      _signedTerms(NAME_HASH, defaultOwner, REGISTRATION_FEE, REGISTRATION_MIN, termsNonce, termsDeadline);

    vm.expectEmit(true, true, false, true, address(registrationController));
    emit RegistrationController.TermsApplied(
      defaultOwner, NAME_HASH, REGISTRATION_FEE, REGISTRATION_MIN, termsNonce, termsDeadline
    );
    _sweepRegistration(sipa, registrationData, consent, auth, terms);
  }

  function test_forgedTermsRevert() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    (, uint256 attackerKey) = makeAddrAndKey("termsForger");
    SignedTerms memory terms =
      _signedTermsSignedBy(attackerKey, NAME_HASH, defaultOwner, 0, 0, nextNonce++, _deadline());

    vm.expectRevert(Errors.RegistrationController__InvalidTermsSignature.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, terms);
  }

  function test_expiredTermsRevert() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms = _signedTerms(NAME_HASH, defaultOwner, 0, 0, nextNonce++, block.timestamp - 1);

    vm.expectRevert(Errors.RegistrationController__TermsExpired.selector);
    _sweepRegistration(sipa, registrationData, consent, auth, terms);
  }

  function test_replayedTermsNonceReverts() external {
    uint256 termsNonce = nextNonce++;

    {
      bytes memory data1 = _registrationDataFor(REGISTRATION_SWEEP_FEE, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
      SIPABase sipa1 = _deployAndFund(data1, DEPOSIT);
      _sweepRegistration(
        sipa1,
        data1,
        _consentSig(bootstrapKey, data1),
        _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline()),
        _signedTerms(NAME_HASH, defaultOwner, REGISTRATION_SWEEP_FEE, 0, termsNonce, _deadline())
      );
    }

    (address bootstrap2, uint256 bootstrapKey2) = makeAddrAndKey("bootstrap2");
    address owner2 = _ownerOf(bootstrapKey2);
    bytes32 name2 = keccak256("bob.oxide.eth");
    bytes memory data2 = _registrationDataFor(REGISTRATION_SWEEP_FEE, FEE_BENEFICIARY, name2, owner2);
    SIPABase sipa2 = _deployAndFund(data2, DEPOSIT);
    SignedTerms memory replayTerms = _signedTerms(name2, owner2, REGISTRATION_SWEEP_FEE, 0, termsNonce, _deadline());
    bytes memory consent2 = _consentSig(bootstrapKey2, data2);
    DomainAuth memory auth2 = _domainAuth(name2, owner2, nextNonce++, _deadline());
    bytes memory proofs2 = _regProofs(bootstrap2, consent2, auth2, replayTerms, _r1Install(bootstrapKey2, owner2));

    vm.expectRevert(Errors.RegistrationController__TermsNonceAlreadyUsed.selector);
    sipa2.sweep(address(underlying), relayer, data2, proofs2);
  }

  function test_signedTermsFeeRoutesToSelectedBeneficiary() external {
    address funder2 = makeAddr("funder2");
    vm.prank(regDomainOwner);
    registrationController.addBeneficiary(funder2);

    bytes memory registrationData = _registrationDataFor(REGISTRATION_FEE, funder2, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms =
      _signedTerms(NAME_HASH, defaultOwner, REGISTRATION_FEE, REGISTRATION_MIN, nextNonce++, _deadline());

    _sweepRegistration(sipa, registrationData, consent, auth, terms);

    assertEq(underlying.balanceOf(funder2), REGISTRATION_FUNDER_CUT);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), 0);
  }

  function test_mismatchedRegistrationDataReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory other = _registrationData(keccak256("different"), defaultOwner);
    bytes memory consent = _consentSig(bootstrapKey, other);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(Errors.SIPA__IntentDataMismatch.selector);
    _sweepRegistration(sipa, other, consent, auth, _noTerms());
  }

  function test_deploysOwnerAccountAtRegistration() external {
    assertEq(defaultOwner.code.length, 0, "owner account not deployed yet");

    _sweepDefault();

    assertGt(defaultOwner.code.length, 0, "owner account deployed at registration");
    assertEq(defaultOwner, accountFactory.predictAccountAddress(bootstrap));
  }

  function test_predeployedOwnerAccountIsNoOp() external {
    accountFactory.deploy(bootstrap);
    bytes32 codeHashBefore = defaultOwner.codehash;

    _sweepDefault();

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(defaultOwner.codehash, codeHashBefore, "account not redeployed");
  }

  function test_feeRoutesToSelectedBeneficiary() external {
    address funder2 = makeAddr("funder2");
    vm.prank(regDomainOwner);
    registrationController.addBeneficiary(funder2);

    bytes memory registrationData = _registrationDataFor(REGISTRATION_FEE, funder2, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    assertEq(underlying.balanceOf(funder2), REGISTRATION_FUNDER_CUT);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), 0);
  }

  function test_unallowlistedBeneficiaryReverts() external {
    address stranger = makeAddr("stranger");
    bytes memory registrationData = _registrationDataFor(REGISTRATION_FEE, stranger, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(abi.encodeWithSelector(Errors.RegistrationController__BeneficiaryNotAllowlisted.selector, stranger));
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_swappedBeneficiaryOnFundedSIPAReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);

    address funder2 = makeAddr("funder2");
    vm.prank(regDomainOwner);
    registrationController.addBeneficiary(funder2);
    bytes memory swapped = _registrationDataFor(REGISTRATION_FEE, funder2, NAME_HASH, defaultOwner);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(Errors.SIPA__IntentDataMismatch.selector);
    _sweepRegistration(sipa, swapped, consent, auth, _noTerms());
  }

  function test_committedFeeBelowScheduleReverts() external {
    uint256 committed = REGISTRATION_FEE - 1;
    bytes memory registrationData = _registrationDataFor(committed, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(Errors.RegistrationController__FeeMismatch.selector, committed, REGISTRATION_FEE)
    );
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_committedFeeAboveScheduleReverts() external {
    uint256 committed = REGISTRATION_FEE + 1;
    bytes memory registrationData = _registrationDataFor(committed, FEE_BENEFICIARY, NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(Errors.RegistrationController__FeeMismatch.selector, committed, REGISTRATION_FEE)
    );
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function test_committedFeeMustMatchSignedTerms() external {
    uint256 termsFee = 2 * REGISTRATION_FEE;
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    SignedTerms memory terms =
      _signedTerms(NAME_HASH, defaultOwner, termsFee, REGISTRATION_MIN, nextNonce++, _deadline());

    vm.expectRevert(
      abi.encodeWithSelector(Errors.RegistrationController__FeeMismatch.selector, REGISTRATION_FEE, termsFee)
    );
    _sweepRegistration(sipa, registrationData, consent, auth, terms);
  }

  function test_swappedControllerCannotRaiseTheFee() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    uint256 higher = 3 * REGISTRATION_FEE;
    _setController(address(_deployController(REGISTRATION_MIN, higher, FEE_BENEFICIARY)));

    vm.expectRevert(
      abi.encodeWithSelector(Errors.RegistrationController__FeeMismatch.selector, REGISTRATION_FEE, higher)
    );
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    assertEq(underlying.balanceOf(address(sipa)), DEPOSIT, "the deposit stays put");
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), 0);
    assertEq(nameRegistry.ownerOf(NAME_HASH), address(0));
  }

  function test_swappedControllerCannotRedirectTheFee() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    address funder2 = makeAddr("funder2");
    _setController(address(_deployController(REGISTRATION_MIN, REGISTRATION_FEE, funder2)));

    vm.expectRevert(
      abi.encodeWithSelector(Errors.RegistrationController__BeneficiaryNotAllowlisted.selector, FEE_BENEFICIARY)
    );
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    assertEq(underlying.balanceOf(address(sipa)), DEPOSIT, "the deposit stays put");
    assertEq(underlying.balanceOf(funder2), 0);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), 0);
  }

  function test_swappedControllerWithSameScheduleSettlesAtTheCommittedFee() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    uint256 portalBefore = underlying.balanceOf(address(portal));

    RegistrationController next = _deployController(REGISTRATION_MIN, REGISTRATION_FEE, FEE_BENEFICIARY);
    _setController(address(next));
    assertEq(nameRegistry.registrationController(), address(next));

    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), REGISTRATION_FUNDER_CUT);
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - REGISTRATION_FEE);
    assertEq(underlying.balanceOf(address(sipa)), 0);
  }

  function test_addBeneficiaryOnlyDomainOwner() external {
    vm.expectRevert(Errors.RegistrationController__NotDomainOwner.selector);
    registrationController.addBeneficiary(makeAddr("funder2"));
  }
}

contract RegisterFpcCutTest is RegistrationTestBase {
  uint256 internal constant CUT = 10e16;

  function setUp() public override {
    fpcFundingCut = CUT;
    super.setUp();
  }

  function test_atTheFloorTheCreditIsTheFloorLessTheFpcCut() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, REGISTRATION_MIN + REGISTRATION_FEE);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);
    uint256 portalBefore = underlying.balanceOf(address(portal));
    inbox.primeNext(bytes32(uint256(0x1234)), 42);

    vm.expectEmit(true, true, true, true, address(portal));
    emit Deposit(RECIPIENT_COMMITMENT, REGISTRATION_MIN - CUT, bytes32(uint256(0x1234)), 42);
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    assertEq(underlying.balanceOf(relayer), REGISTRATION_SWEEP_FEE, "0.5 of the 5 is the relayer's");
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), REGISTRATION_FUNDER_CUT, "4.5 of the 5 is the funder's");
    assertEq(underlying.balanceOf(FPC_FUNDER), CUT, "the portal takes its cut out of the bridged floor");
    assertEq(
      underlying.balanceOf(address(portal)) - portalBefore,
      REGISTRATION_MIN - CUT,
      "9.90 of the 15 deposited is what the registrant is credited"
    );
  }
}
