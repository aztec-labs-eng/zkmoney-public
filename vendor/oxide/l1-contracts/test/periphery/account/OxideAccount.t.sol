// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {Account as OZAccount} from "@openzeppelin/contracts/account/Account.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {Errors} from "@periphery/Errors.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";

contract OxideAccountTest is Test {
  uint256 internal constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
  bytes1 internal constant AUTH_FLAGS_UP = WebAuthn.AUTH_DATA_FLAGS_UP;
  bytes1 internal constant AUTH_FLAGS_UP_UV = WebAuthn.AUTH_DATA_FLAGS_UP | WebAuthn.AUTH_DATA_FLAGS_UV;

  address internal constant ENTRY_POINT = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;

  OxideAccountFactory internal factory;

  address internal bootstrap;
  uint256 internal bootstrapKey;

  uint256 internal p256Key1;
  uint256 internal p256Key2;
  OxideAccount.R1Key internal r1Key1;
  OxideAccount.R1Key internal r1Key2;

  function setUp() public {
    vm.warp(1_770_000_000);
    factory = new OxideAccountFactory();
    (bootstrap, bootstrapKey) = makeAddrAndKey("bootstrap");

    p256Key1 = uint256(keccak256("p256-key-1")) % P256_N;
    p256Key2 = uint256(keccak256("p256-key-2")) % P256_N;
    r1Key1 = _r1Key(p256Key1);
    r1Key2 = _r1Key(p256Key2);
  }

  function _r1Key(uint256 privateKey) internal pure returns (OxideAccount.R1Key memory key) {
    (uint256 x, uint256 y) = vm.publicKeyP256(privateKey);
    key.qx = bytes32(x);
    key.qy = bytes32(y);
  }

  function _r1Signature(uint256 keyIndex, uint256 privateKey, bytes32 challenge, bytes1 flags)
    internal
    pure
    returns (bytes memory)
  {
    return AccountSignatures.r1(keyIndex, privateKey, challenge, flags);
  }

  function _k1Signature(uint256 privateKey, bytes32 hash) internal pure returns (bytes memory) {
    return AccountSignatures.k1(privateKey, hash);
  }

  function _deploy() internal returns (OxideAccount) {
    return OxideAccount(payable(factory.deploy(bootstrap)));
  }

  function _deployWithR1Key() internal returns (OxideAccount account) {
    account = _deploy();
    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key1, "passkey:alice");
  }

  function test_deploy_matchesPredictionAndSetsBootstrapOwner() public {
    address predicted = factory.predictAccountAddress(bootstrap);

    vm.expectEmit(address(factory));
    emit OxideAccountFactory.AccountDeployed(bootstrap, predicted);
    OxideAccount account = _deploy();

    assertEq(address(account), predicted);
    assertEq(account.bootstrapOwner(), bootstrap);
    assertEq(account.getAuthKeys().length, 0);
  }

  function test_deploy_isPermissionless() public {
    address predicted = factory.predictAccountAddress(bootstrap);
    vm.prank(makeAddr("relayer"));
    OxideAccount account = OxideAccount(payable(factory.deploy(bootstrap)));
    assertEq(address(account), predicted);
    assertEq(account.bootstrapOwner(), bootstrap);
  }

  function test_deploy_returnsExistingAccountOnRedeploy() public {
    OxideAccount account = _deploy();
    vm.recordLogs();
    assertEq(factory.deploy(bootstrap), address(account));
    assertEq(vm.getRecordedLogs().length, 0);
  }

  function test_deploy_revertsOnZeroBootstrapOwner() public {
    vm.expectRevert(Errors.OxideAccountFactory__InvalidBootstrapOwner.selector);
    factory.deploy(address(0));
  }

  function test_implementationIsNotAnAccount() public {
    OxideAccount impl = OxideAccount(payable(factory.implementation()));
    vm.expectRevert(Errors.OxideAccount__NotClone.selector);
    impl.bootstrapOwner();
  }

  function _validateAs(OxideAccount account, bytes memory signature, bytes32 userOpHash) internal returns (uint256) {
    PackedUserOperation memory op;
    op.sender = address(account);
    op.signature = signature;
    vm.prank(ENTRY_POINT);
    return account.validateUserOp(op, userOpHash, 0);
  }

  function test_validateUserOp_k1SucceedsWhileNoR1Key() public {
    OxideAccount account = _deploy();
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, _k1Signature(bootstrapKey, userOpHash), userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_SUCCESS);
  }

  function test_validateUserOp_k1FailsWithWrongSigner() public {
    OxideAccount account = _deploy();
    (, uint256 wrongKey) = makeAddrAndKey("wrong");
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, _k1Signature(wrongKey, userOpHash), userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_k1FailsOnGarbageSignature() public {
    OxideAccount account = _deploy();
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, hex"deadbeef", userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_k1FailsOnZeroBootstrapClone() public {
    OxideAccount account =
      OxideAccount(payable(Clones.cloneWithImmutableArgs(factory.implementation(), abi.encode(address(0)))));
    assertEq(account.bootstrapOwner(), address(0));

    bytes32 userOpHash = keccak256("op");
    assertEq(_validateAs(account, hex"deadbeef", userOpHash), ERC4337Utils.SIG_VALIDATION_FAILED);
    assertEq(_validateAs(account, new bytes(65), userOpHash), ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_k1FailsOnceR1KeyExists() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, _k1Signature(bootstrapKey, userOpHash), userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_r1SucceedsWithHeldKey() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, _r1Signature(0, p256Key1, userOpHash, AUTH_FLAGS_UP_UV), userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_SUCCESS);
  }

  function test_validateUserOp_r1FailsWithoutUserVerification() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, _r1Signature(0, p256Key1, userOpHash, AUTH_FLAGS_UP), userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_r1FailsWithWrongKey() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, _r1Signature(0, p256Key2, userOpHash, AUTH_FLAGS_UP_UV), userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_r1FailsOnOutOfBoundsKeyIndex() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, _r1Signature(5, p256Key1, userOpHash, AUTH_FLAGS_UP_UV), userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_r1FailsBeforeAnyKeyRegistered() public {
    OxideAccount account = _deploy();
    bytes32 userOpHash = keccak256("op");
    uint256 result = _validateAs(account, _r1Signature(0, p256Key1, userOpHash, AUTH_FLAGS_UP_UV), userOpHash);
    assertEq(result, ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_revertsForNonEntryPoint() public {
    OxideAccount account = _deployWithR1Key();
    PackedUserOperation memory op;
    op.sender = address(account);
    op.signature = _r1Signature(0, p256Key1, keccak256("op"), AUTH_FLAGS_UP_UV);
    vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
    account.validateUserOp(op, keccak256("op"), 0);
  }

  bytes4 internal constant ERC1271_VALID = 0x1626ba7e;
  bytes4 internal constant ERC1271_INVALID = 0xffffffff;
  bytes4 internal constant ERC7739_SUPPORTED = 0x77390001;
  bytes32 internal constant ERC7739_DETECTION_HASH = 0x7739773977397739773977397739773977397739773977397739773977397739;

  bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

  function _domainSeparator(string memory name, address verifyingContract) internal view returns (bytes32) {
    return keccak256(
      abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), block.chainid, verifyingContract)
    );
  }

  function _personalSignDigest(OxideAccount account, bytes32 hash) internal view returns (bytes32) {
    return AccountSignatures.personalSignDigest(address(account), hash);
  }

  function test_isValidSignature_k1SucceedsWhileNoR1Key() public {
    OxideAccount account = _deploy();
    bytes32 hash = keccak256("message");
    bytes memory sig = _k1Signature(bootstrapKey, _personalSignDigest(account, hash));
    assertEq(account.isValidSignature(hash, sig), ERC1271_VALID);
  }

  function test_isValidSignature_k1FailsWithWrongSigner() public {
    OxideAccount account = _deploy();
    (, uint256 wrongKey) = makeAddrAndKey("wrong");
    bytes32 hash = keccak256("message");
    bytes memory sig = _k1Signature(wrongKey, _personalSignDigest(account, hash));
    assertEq(account.isValidSignature(hash, sig), ERC1271_INVALID);
  }

  function test_isValidSignature_k1FailsOnceR1KeyExists() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 hash = keccak256("message");
    bytes memory sig = _k1Signature(bootstrapKey, _personalSignDigest(account, hash));
    assertEq(account.isValidSignature(hash, sig), ERC1271_INVALID);
  }

  function test_isValidSignature_r1SucceedsWithHeldKey() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 hash = keccak256("message");
    bytes memory sig = _r1Signature(0, p256Key1, _personalSignDigest(account, hash), AUTH_FLAGS_UP_UV);
    assertEq(account.isValidSignature(hash, sig), ERC1271_VALID);
  }

  function test_isValidSignature_r1FailsWithoutUserVerification() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 hash = keccak256("message");
    bytes memory sig = _r1Signature(0, p256Key1, _personalSignDigest(account, hash), AUTH_FLAGS_UP);
    assertEq(account.isValidSignature(hash, sig), ERC1271_INVALID);
  }

  function test_isValidSignature_r1FailsWithWrongKey() public {
    OxideAccount account = _deployWithR1Key();
    bytes32 hash = keccak256("message");
    bytes memory sig = _r1Signature(0, p256Key2, _personalSignDigest(account, hash), AUTH_FLAGS_UP_UV);
    assertEq(account.isValidSignature(hash, sig), ERC1271_INVALID);
  }

  function test_isValidSignature_r1SucceedsWithTypedDataSignEnvelope() public {
    OxideAccount account = _deployWithR1Key();

    bytes32 appSeparator = _domainSeparator("App", address(0xA99));
    string memory contentsDescr = "Order(uint256 amount)";
    bytes32 contentsHash = keccak256(abi.encode(keccak256(bytes(contentsDescr)), uint256(42)));
    bytes32 hash = keccak256(abi.encodePacked("\x19\x01", appSeparator, contentsHash));

    bytes32 typedDataSignTypehash = keccak256(
      abi.encodePacked(
        "TypedDataSign(Order contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)",
        contentsDescr
      )
    );
    bytes32 structHash = keccak256(
      abi.encode(
        typedDataSignTypehash,
        contentsHash,
        keccak256("OxideAccount"),
        keccak256("1"),
        block.chainid,
        address(account),
        bytes32(0)
      )
    );
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", appSeparator, structHash));

    bytes memory sig = abi.encodePacked(
      _r1Signature(0, p256Key1, digest, AUTH_FLAGS_UP_UV),
      appSeparator,
      contentsHash,
      contentsDescr,
      uint16(bytes(contentsDescr).length)
    );
    assertEq(account.isValidSignature(hash, sig), ERC1271_VALID);
  }

  function test_isValidSignature_failsOnGarbageSignature() public {
    OxideAccount account = _deployWithR1Key();
    assertEq(account.isValidSignature(keccak256("message"), hex"deadbeef"), ERC1271_INVALID);
  }

  function test_isValidSignature_advertisesErc7739Support() public {
    OxideAccount account = _deployWithR1Key();
    assertEq(account.isValidSignature(ERC7739_DETECTION_HASH, ""), ERC7739_SUPPORTED);
  }

  function test_isValidSignature_acceptedSignatureDoesNotValidateUserOp() public {
    bytes32 hash = keccak256("message");

    OxideAccount account = _deploy();
    bytes memory k1Sig = _k1Signature(bootstrapKey, _personalSignDigest(account, hash));
    assertEq(account.isValidSignature(hash, k1Sig), ERC1271_VALID);
    assertEq(_validateAs(account, k1Sig, hash), ERC4337Utils.SIG_VALIDATION_FAILED);

    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key1, "passkey:alice");
    bytes memory r1Sig = _r1Signature(0, p256Key1, _personalSignDigest(account, hash), AUTH_FLAGS_UP_UV);
    assertEq(account.isValidSignature(hash, r1Sig), ERC1271_VALID);
    assertEq(_validateAs(account, r1Sig, hash), ERC4337Utils.SIG_VALIDATION_FAILED);
  }

  function test_validateUserOp_acceptedSignatureDoesNotValidateErc1271() public {
    bytes32 userOpHash = keccak256("op");

    OxideAccount account = _deploy();
    bytes memory k1Sig = _k1Signature(bootstrapKey, userOpHash);
    assertEq(_validateAs(account, k1Sig, userOpHash), ERC4337Utils.SIG_VALIDATION_SUCCESS);
    assertEq(account.isValidSignature(userOpHash, k1Sig), ERC1271_INVALID);

    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key1, "passkey:alice");
    bytes memory r1Sig = _r1Signature(0, p256Key1, userOpHash, AUTH_FLAGS_UP_UV);
    assertEq(_validateAs(account, r1Sig, userOpHash), ERC4337Utils.SIG_VALIDATION_SUCCESS);
    assertEq(account.isValidSignature(userOpHash, r1Sig), ERC1271_INVALID);
  }

  function test_addAuthKey_firstKeyRetiresBootstrap() public {
    OxideAccount account = _deploy();

    vm.expectEmit(address(account));
    emit OxideAccount.AuthKeyAdded(0, r1Key1, "passkey:alice");
    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key1, "passkey:alice");

    assertEq(account.getAuthKeys().length, 1);
    bytes32 userOpHash = keccak256("op");
    assertEq(
      _validateAs(account, _r1Signature(0, p256Key1, userOpHash, AUTH_FLAGS_UP_UV), userOpHash),
      ERC4337Utils.SIG_VALIDATION_SUCCESS
    );
    assertEq(
      _validateAs(account, _k1Signature(bootstrapKey, userOpHash), userOpHash), ERC4337Utils.SIG_VALIDATION_FAILED
    );
  }

  function test_addAuthKey_appendsAndNewKeyValidates() public {
    OxideAccount account = _deployWithR1Key();

    vm.expectEmit(address(account));
    emit OxideAccount.AuthKeyAdded(1, r1Key2, "passkey:backup");
    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key2, "passkey:backup");

    assertEq(account.getAuthKeys().length, 2);
    bytes32 userOpHash = keccak256("op");
    assertEq(
      _validateAs(account, _r1Signature(1, p256Key2, userOpHash, AUTH_FLAGS_UP_UV), userOpHash),
      ERC4337Utils.SIG_VALIDATION_SUCCESS
    );
  }

  function test_addAuthKey_revertsForUnauthorizedCaller() public {
    OxideAccount account = _deploy();
    vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
    account.addAuthKey(r1Key1, "");
  }

  function test_addAuthKey_revertsOnInvalidR1Key() public {
    OxideAccount account = _deploy();
    OxideAccount.R1Key memory badKey = OxideAccount.R1Key({qx: bytes32(uint256(1)), qy: bytes32(uint256(1))});
    vm.prank(ENTRY_POINT);
    vm.expectRevert(Errors.OxideAccount__InvalidR1Key.selector);
    account.addAuthKey(badKey, "");
  }

  function test_removeAuthKey_cannotRemoveLast() public {
    OxideAccount account = _deployWithR1Key();
    vm.prank(ENTRY_POINT);
    vm.expectRevert(Errors.OxideAccount__CannotRemoveLastKey.selector);
    account.removeAuthKey(0, r1Key1);
  }

  function test_removeAuthKey_removesAndKeyStopsValidating() public {
    OxideAccount account = _deployWithR1Key();
    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key2, "passkey:backup");

    vm.expectEmit(address(account));
    emit OxideAccount.AuthKeyRemoved(1, r1Key2);
    vm.prank(ENTRY_POINT);
    account.removeAuthKey(1, r1Key2);

    assertEq(account.getAuthKeys().length, 1);
    bytes32 userOpHash = keccak256("op");
    assertEq(
      _validateAs(account, _r1Signature(1, p256Key2, userOpHash, AUTH_FLAGS_UP_UV), userOpHash),
      ERC4337Utils.SIG_VALIDATION_FAILED
    );
  }

  function test_removeAuthKey_revertsOnIndexOutOfBounds() public {
    OxideAccount account = _deployWithR1Key();
    vm.prank(ENTRY_POINT);
    vm.expectRevert(Errors.OxideAccount__AuthKeyIndexOutOfBounds.selector);
    account.removeAuthKey(5, r1Key1);
  }

  function test_removeAuthKey_revertsOnKeyMismatch() public {
    OxideAccount account = _deployWithR1Key();
    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key2, "passkey:backup");

    vm.prank(ENTRY_POINT);
    vm.expectRevert(Errors.OxideAccount__AuthKeyMismatch.selector);
    account.removeAuthKey(0, r1Key2);
  }

  function test_authKeyCount_tracksAddsAndRemoves() public {
    OxideAccount account = _deploy();
    assertEq(account.authKeyCount(), 0);

    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key1, "passkey:alice");
    assertEq(account.authKeyCount(), 1);

    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key2, "passkey:backup");
    assertEq(account.authKeyCount(), 2);

    vm.prank(ENTRY_POINT);
    account.removeAuthKey(0, r1Key1);
    assertEq(account.authKeyCount(), 1);
  }

  function test_getAuthKey_returnsTheEntryAtIndex() public {
    OxideAccount account = _deployWithR1Key();
    vm.prank(ENTRY_POINT);
    account.addAuthKey(r1Key2, "passkey:backup");

    OxideAccount.AuthKeyEntry memory entry = account.getAuthKey(1);
    assertEq(entry.key.qx, r1Key2.qx);
    assertEq(entry.key.qy, r1Key2.qy);
    assertEq(entry.metadata, "passkey:backup");
  }

  function test_getAuthKey_revertsOnIndexOutOfBounds() public {
    OxideAccount account = _deployWithR1Key();
    vm.expectRevert(Errors.OxideAccount__AuthKeyIndexOutOfBounds.selector);
    account.getAuthKey(1);
  }

  function test_setData_storesAndEmits() public {
    OxideAccount account = _deploy();
    bytes32 key = keccak256("xmtp");

    vm.expectEmit(address(account));
    emit OxideAccount.DataChanged(key, "alice.xmtp");
    vm.prank(ENTRY_POINT);
    account.setData(key, "alice.xmtp");

    assertEq(account.getData(key), "alice.xmtp");
  }

  function test_setData_overwrites() public {
    OxideAccount account = _deploy();
    bytes32 key = keccak256("xmtp");
    vm.prank(ENTRY_POINT);
    account.setData(key, "alice.xmtp");
    vm.prank(ENTRY_POINT);
    account.setData(key, "");
    assertEq(account.getData(key), "");
  }

  function test_setData_revertsForUnauthorizedCaller() public {
    OxideAccount account = _deploy();
    vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, address(this)));
    account.setData(keccak256("xmtp"), "alice.xmtp");
  }

  function test_getData_emptyByDefault() public {
    OxideAccount account = _deploy();
    assertEq(account.getData(keccak256("unset")), "");
  }
}
