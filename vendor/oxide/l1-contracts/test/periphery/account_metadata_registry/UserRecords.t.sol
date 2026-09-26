// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistriesTestBase} from "@test/periphery/registries/RegistriesTestBase.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {Errors} from "@periphery/Errors.sol";

contract AccountMetadataRegistryConstructionTest is RegistriesTestBase {
  function test_constructorWiresNameRegistry() public view {
    assertEq(address(metadataRegistry.NAME_REGISTRY()), address(nameRegistry));
  }

  function test_constructorRevertsOnZeroNameRegistry() public {
    vm.expectRevert(Errors.AccountMetadataRegistry__ZeroNameRegistry.selector);
    new AccountMetadataRegistry(INameRegistry(address(0)));
  }
}

contract SetRecordTest is RegistriesTestBase {
  function _assertStored(address user, AccountMetadataRegistry.UserRecord memory expected) internal view {
    AccountMetadataRegistry.UserRecord memory stored = metadataRegistry.getUserRecord(user);
    assertEq(stored.l2Address, expected.l2Address);
    assertEq(stored.rollupVersion, expected.rollupVersion);
    assertEq(stored.publicKey.x, expected.publicKey.x);
    assertEq(stored.publicKey.y, expected.publicKey.y);
    assertEq(stored.resolverOperator, expected.resolverOperator);
  }

  function test_userWritesOwnRecordAndEmits() public {
    AccountMetadataRegistry.UserRecord memory record = _recordFixture();
    vm.expectEmit(address(metadataRegistry));
    emit AccountMetadataRegistry.UserRecordUpdated(userAddr, record);
    vm.prank(userAddr);
    metadataRegistry.setUserRecord(userAddr, record);

    _assertStored(userAddr, record);
    assertTrue(metadataRegistry.hasUserRecord(userAddr));
  }

  function test_controllerWritesRecordForUser() public {
    _setUserRecord(userAddr, _recordFixture());
    _assertStored(userAddr, _recordFixture());
  }

  function test_strangerCannotWriteForUser() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__Unauthorized.selector, userAddr2, userAddr));
    vm.prank(userAddr2);
    metadataRegistry.setUserRecord(userAddr, _recordFixture());
  }

  function test_registryOwnerCannotWriteForUser() public {
    vm.expectRevert(
      abi.encodeWithSelector(Errors.AccountMetadataRegistry__Unauthorized.selector, registryOwner, userAddr)
    );
    vm.prank(registryOwner);
    metadataRegistry.setUserRecord(userAddr, _recordFixture());
  }

  function test_userWithoutNameCanWrite() public {
    assertEq(nameRegistry.nameOf(userAddr), bytes32(0));
    vm.prank(userAddr);
    metadataRegistry.setUserRecord(userAddr, _recordFixture());
    assertTrue(metadataRegistry.hasUserRecord(userAddr));
  }

  function test_hasRecordFalseByDefault() public {
    assertFalse(metadataRegistry.hasUserRecord(userAddr));
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__UserRecordNotFound.selector, userAddr));
    metadataRegistry.getUserRecord(userAddr);
  }

  function test_overwritesExistingRecord() public {
    _setUserRecord(userAddr, _recordFixture());
    AccountMetadataRegistry.UserRecord memory next = _recordFixture2();
    next.publicKey = AccountMetadataRegistry.K1Point(G_X, G_Y);
    vm.prank(userAddr);
    metadataRegistry.setUserRecord(userAddr, next);
    _assertStored(userAddr, next);
  }

  function test_revertsOnOffCurvePublicKey() public {
    AccountMetadataRegistry.UserRecord memory record = _recordFixture();
    record.publicKey = AccountMetadataRegistry.K1Point(5, G_Y);
    vm.expectRevert(Errors.AccountMetadataRegistry__InvalidPublicKey.selector);
    vm.prank(userAddr);
    metadataRegistry.setUserRecord(userAddr, record);
  }

  function test_revertsOnZeroPublicKey() public {
    AccountMetadataRegistry.UserRecord memory record = _recordFixture();
    record.publicKey = AccountMetadataRegistry.K1Point(0, 0);
    vm.expectRevert(Errors.AccountMetadataRegistry__InvalidPublicKey.selector);
    vm.prank(userAddr);
    metadataRegistry.setUserRecord(userAddr, record);
  }

  function test_controllerFollowsNameRegistryPointer() public {
    address next = makeAddr("nextController");
    vm.prank(registryOwner);
    nameRegistry.updateRegistrationController(next);

    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.AccountMetadataRegistry__Unauthorized.selector, registrationControllerAddr, userAddr
      )
    );
    vm.prank(registrationControllerAddr);
    metadataRegistry.setUserRecord(userAddr, _recordFixture());

    vm.prank(next);
    metadataRegistry.setUserRecord(userAddr, _recordFixture());
    assertTrue(metadataRegistry.hasUserRecord(userAddr));
  }
}

contract RecordUpdatesTest is RegistriesTestBase {
  function setUp() public override {
    super.setUp();
    _setUserRecord(userAddr, _recordFixture());
  }

  function test_updateL2Address_byUser() public {
    bytes32 newL2 = keccak256("alice-l2-v2");
    AccountMetadataRegistry.UserRecord memory expected = metadataRegistry.getUserRecord(userAddr);
    expected.l2Address = newL2;
    expected.rollupVersion = ROLLUP_VERSION + 1;

    vm.expectEmit(address(metadataRegistry));
    emit AccountMetadataRegistry.UserRecordUpdated(userAddr, expected);
    vm.prank(userAddr);
    metadataRegistry.updateL2Address(userAddr, newL2, ROLLUP_VERSION + 1);

    AccountMetadataRegistry.UserRecord memory stored = metadataRegistry.getUserRecord(userAddr);
    assertEq(stored.l2Address, newL2);
    assertEq(stored.rollupVersion, ROLLUP_VERSION + 1);
  }

  function test_updateL2Address_byController() public {
    vm.prank(registrationControllerAddr);
    metadataRegistry.updateL2Address(userAddr, keccak256("x"), 1);
    assertEq(metadataRegistry.getUserRecord(userAddr).rollupVersion, 1);
  }

  function test_updateL2Address_revertsForStranger() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__Unauthorized.selector, userAddr2, userAddr));
    vm.prank(userAddr2);
    metadataRegistry.updateL2Address(userAddr, keccak256("x"), 1);
  }

  function test_updateL2Address_revertsWithoutRecord() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__UserRecordNotFound.selector, userAddr2));
    vm.prank(userAddr2);
    metadataRegistry.updateL2Address(userAddr2, keccak256("x"), 1);
  }

  function test_updatePublicKey_byUser() public {
    AccountMetadataRegistry.K1Point memory newKey = AccountMetadataRegistry.K1Point(G_X, G_Y);
    AccountMetadataRegistry.UserRecord memory expected = metadataRegistry.getUserRecord(userAddr);
    expected.publicKey = newKey;

    vm.expectEmit(address(metadataRegistry));
    emit AccountMetadataRegistry.UserRecordUpdated(userAddr, expected);
    vm.prank(userAddr);
    metadataRegistry.updatePublicKey(userAddr, newKey);

    assertEq(metadataRegistry.getUserRecord(userAddr).publicKey.x, G_X);
    assertEq(metadataRegistry.getUserRecord(userAddr).publicKey.y, G_Y);
  }

  function test_updatePublicKey_revertsForStranger() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__Unauthorized.selector, userAddr2, userAddr));
    vm.prank(userAddr2);
    metadataRegistry.updatePublicKey(userAddr, AccountMetadataRegistry.K1Point(G_X, G_Y));
  }

  function test_updatePublicKey_revertsWithoutRecord() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__UserRecordNotFound.selector, userAddr2));
    vm.prank(userAddr2);
    metadataRegistry.updatePublicKey(userAddr2, AccountMetadataRegistry.K1Point(G_X, G_Y));
  }

  function _expectInvalidKey(uint256 x, uint256 y) internal {
    vm.prank(userAddr);
    vm.expectRevert(Errors.AccountMetadataRegistry__InvalidPublicKey.selector);
    metadataRegistry.updatePublicKey(userAddr, AccountMetadataRegistry.K1Point(x, y));
  }

  function test_updatePublicKey_revertsOnZeroX() public {
    _expectInvalidKey(0, G_Y);
  }

  function test_updatePublicKey_revertsOnXAtGroupOrder() public {
    _expectInvalidKey(SECP256K1_N, G_Y);
  }

  function test_updatePublicKey_revertsOnOffCurveX() public {
    _expectInvalidKey(5, G_Y);
  }

  function test_updatePublicKey_revertsOnYAtFieldOrder() public {
    _expectInvalidKey(G_X, SECP256K1_P);
  }

  function test_updatePublicKey_revertsOnMismatchedY() public {
    _expectInvalidKey(G_X, USER_PUBLIC_KEY_Y);
  }

  function test_updateUserResolverOperator_byUser() public {
    address next = makeAddr("newResolverOperator");
    AccountMetadataRegistry.UserRecord memory expected = metadataRegistry.getUserRecord(userAddr);
    expected.resolverOperator = next;

    vm.expectEmit(address(metadataRegistry));
    emit AccountMetadataRegistry.UserRecordUpdated(userAddr, expected);
    vm.prank(userAddr);
    metadataRegistry.updateUserResolverOperator(userAddr, next);

    assertEq(metadataRegistry.getUserRecord(userAddr).resolverOperator, next);
  }

  function test_updateUserResolverOperator_revertsForStranger() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__Unauthorized.selector, userAddr2, userAddr));
    vm.prank(userAddr2);
    metadataRegistry.updateUserResolverOperator(userAddr, makeAddr("x"));
  }

  function test_updateUserResolverOperator_revertsWithoutRecord() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__UserRecordNotFound.selector, userAddr2));
    vm.prank(userAddr2);
    metadataRegistry.updateUserResolverOperator(userAddr2, makeAddr("x"));
  }
}
