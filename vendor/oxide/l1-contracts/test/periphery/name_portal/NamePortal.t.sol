// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistrationTestBase} from "@test/periphery/registration/RegistrationTestBase.sol";
import {NamePortal} from "@periphery/NamePortal.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {Errors} from "@periphery/Errors.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

contract NamePortalTest is RegistrationTestBase {
  uint256 internal constant DEPOSIT = 100 ether;

  function _deadline() internal view returns (uint256) {
    return block.timestamp + 1 days;
  }

  function _sweep(bytes memory registrationData) internal {
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());
  }

  function _expectedContent(address user, bytes32 nameHash) internal pure returns (bytes32) {
    return Hash.sha256ToField(abi.encodeWithSignature("name_ownership_verified(address,bytes32)", user, nameHash));
  }

  function _assertNotification(uint256 callIndex, bytes32 l2Recipient, uint256 rollupVersion) internal view {
    (bytes32 actor, uint256 version, bytes32 content, bytes32 secretHash) = inbox.calls(callIndex);
    assertEq(actor, l2Recipient);
    assertEq(version, rollupVersion);
    assertEq(content, _expectedContent(defaultOwner, NAME_HASH));
    assertEq(secretHash, OxideConstants.PORTAL_CONSTANT_SECRET_HASH);
  }

  function test_registrationNotifiesRecipientBeforeBridging() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());
    inbox.primeNext(bytes32(uint256(0xF00D)), 3);

    vm.expectEmit(true, true, true, true, address(namePortal));
    emit NamePortal.NameNotified(
      defaultOwner, NAME_HASH, NAME_PORTAL_RECIPIENT, ROLLUP_VERSION, bytes32(uint256(0xF00D)), 3
    );
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    assertEq(inbox.callCount(), 2);
    _assertNotification(0, NAME_PORTAL_RECIPIENT, ROLLUP_VERSION);
  }

  function test_notificationTargetsRecordRollupVersion() external {
    uint256 otherVersion = ROLLUP_VERSION + 1;
    registry.setRollup(otherVersion, registry.getRollup(ROLLUP_VERSION));
    bytes memory registrationData = _registrationDataFull(
      NAME_HASH,
      defaultOwner,
      AccountMetadataRegistry.K1Point(G_X, G_Y),
      L2_ADDRESS,
      resolverOperatorAddr,
      otherVersion,
      REGISTRATION_FEE,
      FEE_BENEFICIARY,
      NAME_PORTAL_RECIPIENT
    );

    _sweep(registrationData);

    _assertNotification(0, NAME_PORTAL_RECIPIENT, otherVersion);
  }

  function test_zeroRecipientSkipsNotification() external {
    bytes memory registrationData = _registrationDataFull(
      NAME_HASH,
      defaultOwner,
      AccountMetadataRegistry.K1Point(G_X, G_Y),
      L2_ADDRESS,
      resolverOperatorAddr,
      ROLLUP_VERSION,
      REGISTRATION_FEE,
      FEE_BENEFICIARY,
      bytes32(0)
    );

    _sweep(registrationData);

    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(inbox.callCount(), 1);
  }

  function test_failedNotificationRevertsRegistration() external {
    bytes memory registrationData = _registrationDataFull(
      NAME_HASH,
      defaultOwner,
      AccountMetadataRegistry.K1Point(G_X, G_Y),
      L2_ADDRESS,
      resolverOperatorAddr,
      ROLLUP_VERSION + 99,
      REGISTRATION_FEE,
      FEE_BENEFICIARY,
      NAME_PORTAL_RECIPIENT
    );
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(bytes("MockRegistry: unknown version"));
    _sweepRegistration(sipa, registrationData, consent, auth, _noTerms());

    assertEq(nameRegistry.ownerOf(NAME_HASH), address(0));
    assertEq(underlying.balanceOf(address(sipa)), DEPOSIT);
  }

  function test_swappedRecipientOnFundedSIPAReverts() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, DEPOSIT);
    bytes memory swapped = _registrationDataFull(
      NAME_HASH,
      defaultOwner,
      AccountMetadataRegistry.K1Point(G_X, G_Y),
      L2_ADDRESS,
      resolverOperatorAddr,
      ROLLUP_VERSION,
      REGISTRATION_FEE,
      FEE_BENEFICIARY,
      keccak256("attacker-recipient")
    );
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, _deadline());

    vm.expectRevert(Errors.SIPA__IntentDataMismatch.selector);
    _sweepRegistration(sipa, swapped, consent, auth, _noTerms());
  }

  function test_notifyIsPermissionless() external {
    _sweep(_registrationData(NAME_HASH, defaultOwner));
    bytes32 recipient = keccak256("second-recipient");

    vm.prank(makeAddr("anyone"));
    namePortal.notify(defaultOwner, recipient, ROLLUP_VERSION);

    assertEq(inbox.callCount(), 3);
    _assertNotification(2, recipient, ROLLUP_VERSION);
  }

  function test_notifyUnregisteredUserReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Errors.NamePortal__NameNotFound.selector, defaultOwner));
    namePortal.notify(defaultOwner, NAME_PORTAL_RECIPIENT, ROLLUP_VERSION);
  }

  function test_notifyZeroRecipientReverts() external {
    vm.expectRevert(Errors.NamePortal__ZeroRecipient.selector);
    namePortal.notify(defaultOwner, bytes32(0), ROLLUP_VERSION);
  }

  function test_constructorRejectsZeroAddresses() external {
    vm.expectRevert(Errors.NamePortal__ZeroNameRegistry.selector);
    new NamePortal(INameRegistry(address(0)), IRegistry(address(registry)));
    vm.expectRevert(Errors.NamePortal__ZeroAztecRegistry.selector);
    new NamePortal(INameRegistry(address(nameRegistry)), IRegistry(address(0)));
  }
}
