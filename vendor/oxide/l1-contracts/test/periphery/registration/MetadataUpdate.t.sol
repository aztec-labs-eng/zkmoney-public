// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {RegistrationTestBase} from "./RegistrationTestBase.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {MetadataUpdateIntent} from "@periphery/interfaces/IAccountMetadataController.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {Errors} from "@periphery/Errors.sol";
import {INamePortal} from "@periphery/interfaces/INamePortal.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";

contract MetadataUpdateCaller is SIPABase {
  constructor(IOxidePortal portal_) SIPABase(portal_, 1) {}

  function INTENT() external pure override returns (Intent) {
    return Intent.UpdateMetadata;
  }

  function applyUpdate(RegistrationController controller, bytes calldata data, bytes calldata signature) external {
    controller.updateUser(data, signature);
  }

  function _execute(address token, bytes calldata, bytes calldata) internal pure override returns (Routing memory) {
    return Routing(token, address(0), 0, bytes32(0));
  }
}

contract MetadataUpdateTest is RegistrationTestBase {
  MetadataUpdateCaller internal updateImplementation;
  AccountMetadataRegistry internal destination;
  OxideAccount internal account;

  function setUp() public override {
    super.setUp();
    account = OxideAccount(payable(accountFactory.deploy(bootstrap)));
    destination = AccountMetadataRegistry(nameRegistry.accountMetadataRegistry());
    updateImplementation = new MetadataUpdateCaller(IOxidePortal(address(portal)));
    vm.prank(OWNER);
    sipaFactory.bless(address(updateImplementation));
    vm.prank(address(registrationController));
    nameRegistry.claimName(
      NAME_HASH, defaultOwner, _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days)
    );
  }

  function _intent() internal view returns (MetadataUpdateIntent memory) {
    return MetadataUpdateIntent({
      owner: defaultOwner,
      metadataRegistry: address(destination),
      metadata: abi.encode(
        _record(AccountMetadataRegistry.K1Point(G_X, G_Y), L2_ADDRESS, resolverOperatorAddr, ROLLUP_VERSION)
      ),
      expectedStateHash: registrationController.metadataStateHash(defaultOwner),
      rollupVersion: ROLLUP_VERSION,
      namePortal: address(namePortal),
      namePortalRecipient: NAME_PORTAL_RECIPIENT,
      recipientCommitment: RECIPIENT_COMMITMENT
    });
  }

  function _caller(bytes memory data, bool resweepable) internal returns (MetadataUpdateCaller) {
    return MetadataUpdateCaller(
      sipaFactory.deploySIPA(address(updateImplementation), keccak256(data), regRecovery, ROLLUP_VERSION, resweepable)
    );
  }

  function _challenge(bytes memory data, address caller) internal view returns (bytes32) {
    return AccountSignatures.personalSignDigest(defaultOwner, registrationController.metadataUpdateDigest(data, caller));
  }

  function _signature(bytes memory data, address caller) internal view returns (bytes memory) {
    return AccountSignatures.k1(bootstrapKey, _challenge(data, caller));
  }

  function _prepareUpdate(MetadataUpdateIntent memory intent)
    internal
    returns (bytes memory data, MetadataUpdateCaller caller, bytes memory signature)
  {
    data = abi.encode(intent);
    caller = _caller(data, false);
    signature = _signature(data, address(caller));
  }

  function _apply(MetadataUpdateIntent memory intent) internal {
    (bytes memory data, MetadataUpdateCaller caller, bytes memory signature) = _prepareUpdate(intent);
    caller.applyUpdate(registrationController, data, signature);
  }

  function _expectUpdateRevert(MetadataUpdateIntent memory intent, bytes4 error) internal {
    (bytes memory data, MetadataUpdateCaller caller, bytes memory signature) = _prepareUpdate(intent);
    vm.expectRevert(error);
    caller.applyUpdate(registrationController, data, signature);
  }

  function test_insertMissingRecord() public {
    assertFalse(destination.hasUserRecord(defaultOwner));
    _apply(_intent());
    assertEq(destination.getUserRecord(defaultOwner).l2Address, L2_ADDRESS);
    assertEq(registrationController.metadataStateHash(defaultOwner), keccak256(_intent().metadata));
  }

  function test_updateNotifiesRequestedRecipientAndRollupVersion() public {
    MetadataUpdateIntent memory intent = _intent();
    intent.namePortalRecipient = bytes32(uint256(123));
    _apply(intent);

    assertEq(inbox.callCount(), 1);
    (bytes32 actor, uint256 version, bytes32 content, bytes32 secretHash) = inbox.calls(0);
    assertEq(actor, intent.namePortalRecipient);
    assertEq(version, intent.rollupVersion);
    assertEq(
      content,
      Hash.sha256ToField(abi.encodeWithSignature("name_ownership_verified(address,bytes32)", defaultOwner, NAME_HASH))
    );
    assertEq(secretHash, OxideConstants.PORTAL_CONSTANT_SECRET_HASH);
    assertEq(abi.encode(destination.getUserRecord(defaultOwner)), intent.metadata);
  }

  function test_withoutNotification() public {
    MetadataUpdateIntent memory intent = _intent();
    intent.namePortal = address(0);
    intent.namePortalRecipient = bytes32(0);
    vm.expectCall(address(namePortal), abi.encodeWithSelector(INamePortal.notify.selector), uint64(0));
    _apply(intent);

    assertEq(inbox.callCount(), 0);
    assertEq(abi.encode(destination.getUserRecord(defaultOwner)), intent.metadata);
  }

  function test_notificationFailureRollsBackMetadata() public {
    (bytes memory data, MetadataUpdateCaller caller, bytes memory signature) = _prepareUpdate(_intent());
    vm.mockCallRevert(address(namePortal), abi.encodeWithSelector(INamePortal.notify.selector), hex"1234");
    vm.expectRevert(bytes(hex"1234"));
    caller.applyUpdate(registrationController, data, signature);
    assertFalse(destination.hasUserRecord(defaultOwner));
    assertEq(inbox.callCount(), 0);
  }

  function test_updateExistingRecord() public {
    _apply(_intent());
    MetadataUpdateIntent memory intent = _intent();
    intent.metadata = abi.encode(
      _record(AccountMetadataRegistry.K1Point(G_X, G_Y), bytes32(uint256(123)), resolverOperatorAddr, ROLLUP_VERSION)
    );
    _apply(intent);
    assertEq(destination.getUserRecord(defaultOwner).l2Address, bytes32(uint256(123)));
  }

  function test_rejectUpdateAfterRecordChanges() public {
    _apply(_intent());
    MetadataUpdateIntent memory intent = _intent();
    intent.metadata = abi.encode(
      _record(AccountMetadataRegistry.K1Point(G_X, G_Y), bytes32(uint256(123)), resolverOperatorAddr, ROLLUP_VERSION)
    );
    (bytes memory data, MetadataUpdateCaller caller, bytes memory signature) = _prepareUpdate(intent);

    vm.prank(defaultOwner);
    destination.updateL2Address(defaultOwner, bytes32(uint256(456)), ROLLUP_VERSION);

    vm.expectRevert(Errors.MetadataUpdate__StaleRecord.selector);
    caller.applyUpdate(registrationController, data, signature);
    assertEq(destination.getUserRecord(defaultOwner).l2Address, bytes32(uint256(456)));
  }

  function test_rejectUpdateAfterRegistryReplacement() public {
    (bytes memory data, MetadataUpdateCaller caller, bytes memory signature) = _prepareUpdate(_intent());

    AccountMetadataRegistry replacement = new AccountMetadataRegistry(nameRegistry);
    vm.prank(OWNER);
    nameRegistry.updateAccountMetadataRegistry(address(replacement));

    vm.expectRevert(Errors.MetadataUpdate__WrongRegistry.selector);
    caller.applyUpdate(registrationController, data, signature);
    assertFalse(destination.hasUserRecord(defaultOwner));
    assertFalse(replacement.hasUserRecord(defaultOwner));
  }

  function test_rejectDifferentPortal() public {
    MetadataUpdateIntent memory intent = _intent();
    intent.namePortal = address(0x123);
    _expectUpdateRevert(intent, Errors.MetadataUpdate__WrongNamePortal.selector);
  }

  function test_rejectResweepable() public {
    bytes memory data = abi.encode(_intent());
    MetadataUpdateCaller caller = _caller(data, true);
    bytes memory sig = _signature(data, address(caller));
    vm.expectRevert(Errors.MetadataUpdate__Resweepable.selector);
    caller.applyUpdate(registrationController, data, sig);
  }

  function test_rejectConsentForOtherClone() public {
    bytes memory data = abi.encode(_intent());
    MetadataUpdateCaller caller = _caller(data, false);
    bytes memory sig = _signature(data, address(0x123));
    vm.expectRevert(Errors.MetadataUpdate__InvalidConsent.selector);
    caller.applyUpdate(registrationController, data, sig);
  }

  function test_rejectUncommittedData() public {
    MetadataUpdateIntent memory intent = _intent();
    MetadataUpdateCaller caller = _caller(abi.encode(intent), false);
    intent.recipientCommitment = bytes32(uint256(1));
    bytes memory data = abi.encode(intent);
    bytes memory sig = _signature(data, address(caller));
    vm.expectRevert(Errors.SIPA__IntentDataMismatch.selector);
    caller.applyUpdate(registrationController, data, sig);
  }

  function test_rejectUnauthorizedCaller() public {
    bytes memory data = abi.encode(_intent());
    vm.expectRevert(abi.encodeWithSelector(Errors.RegistrationController__CallerNotSIPA.selector, address(this)));
    registrationController.updateUser(data, "");
  }

  function test_rejectConsentOnOtherChain() public {
    (bytes memory data, MetadataUpdateCaller caller, bytes memory signature) = _prepareUpdate(_intent());
    vm.chainId(block.chainid + 1);
    vm.expectRevert(Errors.MetadataUpdate__InvalidConsent.selector);
    caller.applyUpdate(registrationController, data, signature);
  }

  function test_rejectSipaVersionMismatch() public {
    MetadataUpdateIntent memory intent = _intent();
    bytes memory data = abi.encode(intent);
    MetadataUpdateCaller caller = MetadataUpdateCaller(
      sipaFactory.deploySIPA(address(updateImplementation), keccak256(data), regRecovery, ROLLUP_VERSION + 1, false)
    );
    bytes memory signature = _signature(data, address(caller));
    vm.expectRevert(Errors.SIPA__RollupVersionMismatch.selector);
    caller.applyUpdate(registrationController, data, signature);
  }

  function test_rejectRecordVersionMismatch() public {
    MetadataUpdateIntent memory intent = _intent();
    intent.metadata = abi.encode(
      _record(AccountMetadataRegistry.K1Point(G_X, G_Y), L2_ADDRESS, resolverOperatorAddr, ROLLUP_VERSION + 1)
    );
    _expectUpdateRevert(intent, Errors.SIPA__RollupVersionMismatch.selector);
  }

  function test_rejectUnnamedOwner() public {
    MetadataUpdateIntent memory intent = _intent();
    intent.owner = address(0x123);
    bytes memory data = abi.encode(intent);
    MetadataUpdateCaller caller = _caller(data, false);
    vm.expectRevert(abi.encodeWithSelector(Errors.NamePortal__NameNotFound.selector, intent.owner));
    caller.applyUpdate(registrationController, data, "");
  }

  function _installPasskey(uint256 key) internal {
    (uint256 x, uint256 y) = vm.publicKeyP256(key);
    vm.prank(address(account));
    account.addAuthKey(OxideAccount.R1Key(bytes32(x), bytes32(y)), "");
  }

  function test_rejectRetiredBootstrap() public {
    _installPasskey(12_345);
    _expectUpdateRevert(_intent(), Errors.MetadataUpdate__InvalidConsent.selector);
  }

  function test_acceptInstalledPasskey() public {
    _installPasskey(12_345);
    bytes memory data = abi.encode(_intent());
    MetadataUpdateCaller caller = _caller(data, false);
    caller.applyUpdate(registrationController, data, AccountSignatures.r1(0, 12_345, _challenge(data, address(caller))));
    assertTrue(destination.hasUserRecord(defaultOwner));
  }

  function test_rejectUnregisteredPasskey() public {
    _installPasskey(12_345);
    bytes memory data = abi.encode(_intent());
    MetadataUpdateCaller caller = _caller(data, false);
    bytes memory signature = AccountSignatures.r1(0, 67_890, _challenge(data, address(caller)));

    vm.expectRevert(Errors.MetadataUpdate__InvalidConsent.selector);
    caller.applyUpdate(registrationController, data, signature);
    assertFalse(destination.hasUserRecord(defaultOwner));
  }
}
