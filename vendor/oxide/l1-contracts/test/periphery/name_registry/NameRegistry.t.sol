// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistriesTestBase} from "@test/periphery/registries/RegistriesTestBase.sol";
import {NameRegistry} from "@periphery/NameRegistry.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Errors} from "@periphery/Errors.sol";

contract NameRegistryConstructionTest is RegistriesTestBase {
  function test_constructorWiresOwnerAndDomainOwner() public {
    NameRegistry fresh = new NameRegistry(registryOwner, domainOwner);
    assertEq(fresh.owner(), registryOwner);
    assertEq(fresh.domainOwner(), domainOwner);
  }

  function test_constructorLeavesPointersUnset() public {
    NameRegistry fresh = new NameRegistry(registryOwner, domainOwner);
    assertEq(fresh.accountMetadataRegistry(), address(0));
    assertEq(fresh.resolver(), address(0));
    assertEq(fresh.registrationController(), address(0));
  }
}

contract NameRegistryOwnerSettersTest is RegistriesTestBase {
  function test_updateAccountMetadataRegistrySetsAndEmits() public {
    address next = makeAddr("nextMetadataRegistry");
    vm.expectEmit(address(nameRegistry));
    emit NameRegistry.AccountMetadataRegistryUpdated(address(metadataRegistry), next);
    vm.prank(registryOwner);
    nameRegistry.updateAccountMetadataRegistry(next);
    assertEq(nameRegistry.accountMetadataRegistry(), next);
  }

  function test_updateAccountMetadataRegistryRevertsOnZero() public {
    vm.expectRevert(Errors.NameRegistry__ZeroAccountMetadataRegistry.selector);
    vm.prank(registryOwner);
    nameRegistry.updateAccountMetadataRegistry(address(0));
  }

  function test_updateAccountMetadataRegistryRevertsForNonOwner() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, domainOwner));
    vm.prank(domainOwner);
    nameRegistry.updateAccountMetadataRegistry(makeAddr("x"));
  }

  function test_updateResolverSetsAndEmits() public {
    address next = makeAddr("nextModule");
    vm.expectEmit(address(nameRegistry));
    emit NameRegistry.ResolverUpdated(address(resolver), next);
    vm.prank(registryOwner);
    nameRegistry.updateResolver(next);
    assertEq(nameRegistry.resolver(), next);
  }

  function test_updateResolverRevertsOnZero() public {
    vm.expectRevert(Errors.NameRegistry__ZeroResolver.selector);
    vm.prank(registryOwner);
    nameRegistry.updateResolver(address(0));
  }

  function test_updateResolverRevertsForNonOwner() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, domainOwner));
    vm.prank(domainOwner);
    nameRegistry.updateResolver(makeAddr("x"));
  }

  function test_updateRegistrationControllerSetsAndEmits() public {
    address next = makeAddr("nextController");
    vm.expectEmit(address(nameRegistry));
    emit NameRegistry.RegistrationControllerUpdated(registrationControllerAddr, next);
    vm.prank(registryOwner);
    nameRegistry.updateRegistrationController(next);
    assertEq(nameRegistry.registrationController(), next);
  }

  function test_updateRegistrationControllerRevertsOnZero() public {
    vm.expectRevert(Errors.NameRegistry__ZeroRegistrationController.selector);
    vm.prank(registryOwner);
    nameRegistry.updateRegistrationController(address(0));
  }

  function test_updateRegistrationControllerRevertsForNonOwner() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, userAddr));
    vm.prank(userAddr);
    nameRegistry.updateRegistrationController(makeAddr("x"));
  }

  function test_updateRegistrationControllerMovesTheGate() public {
    address next = makeAddr("nextController");
    vm.prank(registryOwner);
    nameRegistry.updateRegistrationController(next);

    DomainAuth memory auth = _domainAuth(NAME_HASH, userAddr, nextDomainNonce++, block.timestamp + 1 days);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.NameRegistry__CallerNotRegistrationController.selector, registrationControllerAddr)
    );
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, auth);

    vm.prank(next);
    nameRegistry.claimName(NAME_HASH, userAddr, auth);
    assertEq(nameRegistry.ownerOf(NAME_HASH), userAddr);
  }
}

contract DomainOwnerRotationTest is RegistriesTestBase {
  address internal newDomainOwner;
  uint256 internal newDomainOwnerKey;

  function setUp() public override {
    super.setUp();
    (newDomainOwner, newDomainOwnerKey) = makeAddrAndKey("newDomainOwner");
  }

  function _rotate() internal {
    vm.prank(registryOwner);
    nameRegistry.updateDomainOwner(newDomainOwner);
  }

  function test_updateDomainOwnerChangesSignerAndEmits() public {
    vm.expectEmit(address(nameRegistry));
    emit NameRegistry.DomainOwnerUpdated(domainOwner, newDomainOwner);
    _rotate();
    assertEq(nameRegistry.domainOwner(), newDomainOwner);
  }

  function test_updateDomainOwnerRevertsForDomainOwner() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, domainOwner));
    vm.prank(domainOwner);
    nameRegistry.updateDomainOwner(newDomainOwner);
  }

  function test_updateDomainOwnerRevertsForStranger() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newDomainOwner));
    vm.prank(newDomainOwner);
    nameRegistry.updateDomainOwner(newDomainOwner);
  }

  function test_previousSignerAuthsStopValidatingAfterRotation() public {
    _rotate();
    DomainAuth memory staleAuth = _domainAuth(NAME_HASH, userAddr, nextDomainNonce++, block.timestamp + 1 days);
    vm.expectRevert(Errors.NameRegistry__InvalidDomainSignature.selector);
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, staleAuth);
  }

  function test_newSignerAuthorizesClaimsAfterRotation() public {
    _rotate();
    DomainAuth memory auth =
      _domainAuthSignedBy(newDomainOwnerKey, NAME_HASH, userAddr, nextDomainNonce++, block.timestamp + 1 days);
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, auth);
    assertEq(nameRegistry.ownerOf(NAME_HASH), userAddr);
  }
}

contract ClaimForTest is RegistriesTestBase {
  function _claim(bytes32 nameHash, address owner, DomainAuth memory domainAuth) internal {
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(nameHash, owner, domainAuth);
  }

  function test_revertsForNonControllerCaller() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.NameRegistry__CallerNotRegistrationController.selector, userAddr));
    vm.prank(userAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, _emptyDomainAuth());
  }

  function test_revertsForRegistryOwnerCaller() public {
    vm.expectRevert(
      abi.encodeWithSelector(Errors.NameRegistry__CallerNotRegistrationController.selector, registryOwner)
    );
    vm.prank(registryOwner);
    nameRegistry.claimName(NAME_HASH, userAddr, _emptyDomainAuth());
  }

  function test_storesBothMappings() public {
    _claimName(NAME_HASH, userAddr);
    assertEq(nameRegistry.ownerOf(NAME_HASH), userAddr);
    assertEq(nameRegistry.nameOf(userAddr), NAME_HASH);
  }

  function test_emitsNameClaimed() public {
    DomainAuth memory domainAuth = _domainAuth(NAME_HASH, userAddr, nextDomainNonce, block.timestamp + 1 days);
    vm.expectEmit(address(nameRegistry));
    emit NameRegistry.NameClaimed(userAddr, NAME_HASH, domainAuth.nonce, domainAuth.deadline, domainAuth.signature);
    _claim(NAME_HASH, userAddr, domainAuth);
  }

  function test_burnsDomainOwnerNonce() public {
    uint256 nonce = 42;
    assertFalse(nameRegistry.usedDomainOwnerNonces(nonce));
    _claim(NAME_HASH, userAddr, _domainAuth(NAME_HASH, userAddr, nonce, block.timestamp + 1 days));
    assertTrue(nameRegistry.usedDomainOwnerNonces(nonce));
  }

  function test_revertsOnEmptyNameHash() public {
    vm.expectRevert(Errors.NameRegistry__EmptyNameHash.selector);
    _claim(bytes32(0), userAddr, _emptyDomainAuth());
  }

  function test_revertsWhenOwnerAlreadyHasName() public {
    _claimName(NAME_HASH, userAddr);
    vm.expectRevert(Errors.NameRegistry__OwnerAlreadyHasName.selector);
    _claim(NAME_HASH_2, userAddr, _domainAuth(NAME_HASH_2, userAddr, 1, block.timestamp + 1 days));
  }

  function test_revertsOnDuplicateNameHash() public {
    _claimName(NAME_HASH, userAddr);
    vm.expectRevert(Errors.NameRegistry__NameAlreadyRegistered.selector);
    _claim(NAME_HASH, userAddr2, _domainAuth(NAME_HASH, userAddr2, 1, block.timestamp + 1 days));
  }

  function test_revertsWhenAuthBoundToDifferentAddress() public {
    DomainAuth memory domainAuth = _domainAuth(NAME_HASH, userAddr, 1, block.timestamp + 1 days);
    vm.expectRevert(Errors.NameRegistry__InvalidDomainSignature.selector);
    _claim(NAME_HASH, userAddr2, domainAuth);
  }

  function test_revertsOnExpiredDomainAuth() public {
    DomainAuth memory domainAuth = _domainAuth(NAME_HASH, userAddr, 1, block.timestamp - 1);
    vm.expectRevert(Errors.NameRegistry__DomainAuthExpired.selector);
    _claim(NAME_HASH, userAddr, domainAuth);
  }

  function test_revertsOnReusedDomainNonce() public {
    uint256 nonce = 7;
    _claim(NAME_HASH, userAddr, _domainAuth(NAME_HASH, userAddr, nonce, block.timestamp + 1 days));
    vm.expectRevert(Errors.NameRegistry__DomainNonceAlreadyUsed.selector);
    _claim(NAME_HASH_2, userAddr2, _domainAuth(NAME_HASH_2, userAddr2, nonce, block.timestamp + 1 days));
  }

  function test_revertsOnDomainAuthFromWrongSigner() public {
    (, uint256 malloryKey) = makeAddrAndKey("mallory");
    DomainAuth memory domainAuth = _domainAuthSignedBy(malloryKey, NAME_HASH, userAddr, 1, block.timestamp + 1 days);
    vm.expectRevert(Errors.NameRegistry__InvalidDomainSignature.selector);
    _claim(NAME_HASH, userAddr, domainAuth);
  }

  function test_revertsOnDomainAuthForDifferentNameHash() public {
    DomainAuth memory domainAuth = _domainAuth(NAME_HASH_2, userAddr, 1, block.timestamp + 1 days);
    vm.expectRevert(Errors.NameRegistry__InvalidDomainSignature.selector);
    _claim(NAME_HASH, userAddr, domainAuth);
  }
}

contract ChangeNameTest is RegistriesTestBase {
  bytes32 internal constant NEW_NAME_HASH = keccak256("namehash(alice2.oxide.eth)");

  function setUp() public override {
    super.setUp();
    _claimName(NAME_HASH, userAddr);
  }

  function _change(address owner, bytes32 newNameHash, DomainAuth memory domainAuth) internal {
    vm.prank(registrationControllerAddr);
    nameRegistry.changeName(owner, newNameHash, domainAuth);
  }

  function test_revertsForNonControllerCaller() public {
    DomainAuth memory domainAuth = _domainAuth(NEW_NAME_HASH, userAddr, 1, block.timestamp + 1 days);
    vm.expectRevert(abi.encodeWithSelector(Errors.NameRegistry__CallerNotRegistrationController.selector, userAddr));
    vm.prank(userAddr);
    nameRegistry.changeName(userAddr, NEW_NAME_HASH, domainAuth);
  }

  function test_movesMappingsAndFreesOldName() public {
    DomainAuth memory domainAuth = _domainAuth(NEW_NAME_HASH, userAddr, 1, block.timestamp + 1 days);

    vm.expectEmit(address(nameRegistry));
    emit NameRegistry.NameClaimed(userAddr, NEW_NAME_HASH, domainAuth.nonce, domainAuth.deadline, domainAuth.signature);
    vm.expectEmit(address(nameRegistry));
    emit NameRegistry.NameChanged(userAddr, NAME_HASH, NEW_NAME_HASH);
    _change(userAddr, NEW_NAME_HASH, domainAuth);

    assertEq(nameRegistry.nameOf(userAddr), NEW_NAME_HASH);
    assertEq(nameRegistry.ownerOf(NEW_NAME_HASH), userAddr);
    assertEq(nameRegistry.ownerOf(NAME_HASH), address(0));
    assertTrue(nameRegistry.usedDomainOwnerNonces(1));

    _claimName(NAME_HASH, userAddr2);
    assertEq(nameRegistry.ownerOf(NAME_HASH), userAddr2);
  }

  function test_revertsWhenOwnerHasNoName() public {
    vm.expectRevert(Errors.NameRegistry__NameNotFound.selector);
    _change(userAddr2, NEW_NAME_HASH, _domainAuth(NEW_NAME_HASH, userAddr2, 1, block.timestamp + 1 days));
  }

  function test_revertsOnEmptyNameHash() public {
    vm.expectRevert(Errors.NameRegistry__EmptyNameHash.selector);
    _change(userAddr, bytes32(0), _emptyDomainAuth());
  }

  function test_revertsOnTakenNameHash() public {
    _claimName(NAME_HASH_2, userAddr2);
    vm.expectRevert(Errors.NameRegistry__NameAlreadyRegistered.selector);
    _change(userAddr, NAME_HASH_2, _emptyDomainAuth());
  }

  function test_revertsOnOwnCurrentNameHash() public {
    vm.expectRevert(Errors.NameRegistry__NameAlreadyRegistered.selector);
    _change(userAddr, NAME_HASH, _emptyDomainAuth());
  }

  function test_revertsOnExpiredDomainAuth() public {
    vm.expectRevert(Errors.NameRegistry__DomainAuthExpired.selector);
    _change(userAddr, NEW_NAME_HASH, _domainAuth(NEW_NAME_HASH, userAddr, 1, block.timestamp - 1));
  }

  function test_revertsOnReusedDomainNonce() public {
    vm.expectRevert(Errors.NameRegistry__DomainNonceAlreadyUsed.selector);
    _change(userAddr, NEW_NAME_HASH, _domainAuth(NEW_NAME_HASH, userAddr, 1000, block.timestamp + 1 days));
  }

  function test_revertsOnDomainAuthFromWrongSigner() public {
    (, uint256 malloryKey) = makeAddrAndKey("mallory");
    vm.expectRevert(Errors.NameRegistry__InvalidDomainSignature.selector);
    _change(
      userAddr, NEW_NAME_HASH, _domainAuthSignedBy(malloryKey, NEW_NAME_HASH, userAddr, 1, block.timestamp + 1 days)
    );
  }

  function test_revertsOnDomainAuthBoundToDifferentAddress() public {
    vm.expectRevert(Errors.NameRegistry__InvalidDomainSignature.selector);
    _change(userAddr, NEW_NAME_HASH, _domainAuth(NEW_NAME_HASH, userAddr2, 1, block.timestamp + 1 days));
  }
}

contract DisabledDomainOwnerTest is RegistriesTestBase {
  function setUp() public override {
    super.setUp();
    vm.prank(registryOwner);
    nameRegistry.updateDomainOwner(address(0));
  }

  function test_claimForAcceptsEmptyAuth() public {
    DomainAuth memory empty;
    vm.expectEmit(address(nameRegistry));
    emit NameRegistry.NameClaimed(userAddr, NAME_HASH, 0, 0, "");
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, empty);
    assertEq(nameRegistry.ownerOf(NAME_HASH), userAddr);
  }

  function test_claimForAcceptsExpiredAuthAndGarbageSignature() public {
    DomainAuth memory garbage = DomainAuth({nonce: 5, deadline: block.timestamp - 1, signature: hex"deadbeef"});
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, garbage);
    assertEq(nameRegistry.ownerOf(NAME_HASH), userAddr);
  }

  function test_claimForDoesNotBurnNonce() public {
    DomainAuth memory auth = DomainAuth({nonce: 5, deadline: block.timestamp + 1, signature: ""});
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, auth);
    assertFalse(nameRegistry.usedDomainOwnerNonces(5));

    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH_2, userAddr2, auth);
    assertEq(nameRegistry.ownerOf(NAME_HASH_2), userAddr2);
  }

  function test_changeNameAcceptsEmptyAuth() public {
    DomainAuth memory empty;
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, empty);
    vm.prank(registrationControllerAddr);
    nameRegistry.changeName(userAddr, NAME_HASH_2, empty);
    assertEq(nameRegistry.nameOf(userAddr), NAME_HASH_2);
    assertEq(nameRegistry.ownerOf(NAME_HASH), address(0));
  }

  function test_collisionChecksStillApply() public {
    DomainAuth memory empty;
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, empty);
    vm.expectRevert(Errors.NameRegistry__NameAlreadyRegistered.selector);
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr2, empty);
  }

  function test_controllerGateStillApplies() public {
    DomainAuth memory empty;
    vm.expectRevert(abi.encodeWithSelector(Errors.NameRegistry__CallerNotRegistrationController.selector, userAddr));
    vm.prank(userAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, empty);
  }

  function test_verificationResumesWhenDomainOwnerIsSet() public {
    vm.prank(registryOwner);
    nameRegistry.updateDomainOwner(domainOwner);
    DomainAuth memory empty;
    vm.expectRevert(Errors.NameRegistry__DomainAuthExpired.selector);
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(NAME_HASH, userAddr, empty);
  }
}
