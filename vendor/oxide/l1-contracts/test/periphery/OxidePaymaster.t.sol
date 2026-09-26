// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {OxidePaymaster} from "@periphery/OxidePaymaster.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract OxidePaymasterTest is Test {
  uint128 internal constant VALIDATION_GAS = 50_000;
  uint128 internal constant POSTOP_GAS = 10_000;
  uint48 internal constant VALID_UNTIL = 2_000_000_000;
  uint48 internal constant VALID_AFTER = 1_000_000_000;

  EntryPoint internal entryPoint;
  OxidePaymaster internal paymaster;

  address internal signer;
  uint256 internal signerPk;
  address internal bundler;

  function setUp() public {
    (signer, signerPk) = makeAddrAndKey("sponsor");
    bundler = makeAddr("bundler");
    entryPoint = new EntryPoint();
    paymaster = new OxidePaymaster(IEntryPoint(address(entryPoint)), signer, bundler);
  }

  function test_constructorBindsSigner() public view {
    assertEq(paymaster.signer(), signer);
    assertEq(address(paymaster.entryPoint()), address(entryPoint));
    assertTrue(paymaster.$allowedBundler(bundler), "constructor must seed the bundler");
  }

  function test_getHashIsDeterministic() public view {
    PackedUserOperation memory op = _baseOp();
    op.paymasterAndData = _header();
    assertEq(paymaster.getHash(op, VALID_UNTIL, VALID_AFTER), paymaster.getHash(op, VALID_UNTIL, VALID_AFTER));
  }

  function test_getHashExcludesAccountAndPaymasterSignatures() public view {
    PackedUserOperation memory op = _baseOp();
    op.paymasterAndData = _header();
    bytes32 base = paymaster.getHash(op, VALID_UNTIL, VALID_AFTER);

    op.signature = hex"deadbeef";
    assertEq(paymaster.getHash(op, VALID_UNTIL, VALID_AFTER), base, "account signature must not bind");

    op.paymasterAndData = bytes.concat(_header(), abi.encodePacked(VALID_UNTIL, VALID_AFTER, _dummySig()));
    assertEq(paymaster.getHash(op, VALID_UNTIL, VALID_AFTER), base, "paymaster data body must not bind");
  }

  function test_getHashBindsEveryCommittedField() public view {
    PackedUserOperation memory op = _baseOp();
    op.paymasterAndData = _header();
    bytes32 base = paymaster.getHash(op, VALID_UNTIL, VALID_AFTER);

    PackedUserOperation memory m = _baseOp();
    m.paymasterAndData = _header();

    m.sender = address(0xBEEF);
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER) != base, "sender");
    m.sender = op.sender;

    m.nonce = op.nonce + 1;
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER) != base, "nonce");
    m.nonce = op.nonce;

    m.initCode = hex"01";
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER) != base, "initCode");
    m.initCode = op.initCode;

    m.callData = hex"02";
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER) != base, "callData");
    m.callData = op.callData;

    m.accountGasLimits = bytes32(uint256(1));
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER) != base, "accountGasLimits");
    m.accountGasLimits = op.accountGasLimits;

    m.preVerificationGas = op.preVerificationGas + 1;
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER) != base, "preVerificationGas");
    m.preVerificationGas = op.preVerificationGas;

    m.gasFees = bytes32(uint256(1));
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER) != base, "gasFees");
    m.gasFees = op.gasFees;

    m.paymasterAndData = abi.encodePacked(address(paymaster), VALIDATION_GAS + 1, POSTOP_GAS);
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER) != base, "paymaster gas header");
    m.paymasterAndData = _header();

    assertTrue(paymaster.getHash(m, VALID_UNTIL + 1, VALID_AFTER) != base, "validUntil");
    assertTrue(paymaster.getHash(m, VALID_UNTIL, VALID_AFTER + 1) != base, "validAfter");
  }

  function test_getHashBindsPaymasterAndChain() public {
    PackedUserOperation memory op = _baseOp();
    op.paymasterAndData = _header();
    bytes32 here = paymaster.getHash(op, VALID_UNTIL, VALID_AFTER);

    OxidePaymaster other = new OxidePaymaster(IEntryPoint(address(entryPoint)), signer, bundler);
    op.paymasterAndData = abi.encodePacked(address(other), VALIDATION_GAS, POSTOP_GAS);
    assertTrue(other.getHash(op, VALID_UNTIL, VALID_AFTER) != here, "must bind paymaster address");

    op.paymasterAndData = _header();
    uint256 hashChainA = uint256(paymaster.getHash(op, VALID_UNTIL, VALID_AFTER));
    vm.chainId(block.chainid + 1);
    assertTrue(uint256(paymaster.getHash(op, VALID_UNTIL, VALID_AFTER)) != hashChainA, "must bind chainid");
  }

  function test_validateAcceptsValidSponsorSignature() public {
    PackedUserOperation memory op = _signedOp(signerPk, VALID_UNTIL, VALID_AFTER);

    (bytes memory context, uint256 validationData) = _validate(op);

    assertEq(context.length, 0);
    (bool sigFailed, uint48 until, uint48 aft) = _decode(validationData);
    assertFalse(sigFailed, "valid signature must pass");
    assertEq(until, VALID_UNTIL);
    assertEq(aft, VALID_AFTER);
  }

  function test_validateRejectsWrongSigner() public {
    (, uint256 attackerPk) = makeAddrAndKey("attacker");
    PackedUserOperation memory op = _signedOp(attackerPk, VALID_UNTIL, VALID_AFTER);

    (, uint256 validationData) = _validate(op);
    (bool sigFailed,,) = _decode(validationData);
    assertTrue(sigFailed, "signature from non-sponsor must fail");
  }

  function test_validateRejectsTamperedValidityWindow() public {
    PackedUserOperation memory op = _signedOp(signerPk, VALID_UNTIL, VALID_AFTER);
    bytes memory pd = op.paymasterAndData;
    bytes memory sig = new bytes(65);
    for (uint256 i = 0; i < 65; i++) {
      sig[i] = pd[64 + i];
    }
    op.paymasterAndData = bytes.concat(_header(), abi.encodePacked(VALID_UNTIL + 1, VALID_AFTER, sig));

    (, uint256 validationData) = _validate(op);
    (bool sigFailed,,) = _decode(validationData);
    assertTrue(sigFailed, "tampered window must fail");
  }

  function test_validateRejectsTamperedGasHeader() public {
    PackedUserOperation memory op = _signedOp(signerPk, VALID_UNTIL, VALID_AFTER);
    bytes memory tail = new bytes(op.paymasterAndData.length - 52);
    for (uint256 i = 0; i < tail.length; i++) {
      tail[i] = op.paymasterAndData[52 + i];
    }
    op.paymasterAndData = bytes.concat(abi.encodePacked(address(paymaster), VALIDATION_GAS + 1, POSTOP_GAS), tail);

    (, uint256 validationData) = _validate(op);
    (bool sigFailed,,) = _decode(validationData);
    assertTrue(sigFailed, "tampered gas header must fail");
  }

  function test_validateRevertsWhenCallerIsNotEntryPoint() public {
    PackedUserOperation memory op = _signedOp(signerPk, VALID_UNTIL, VALID_AFTER);
    vm.expectRevert("Sender not EntryPoint");
    paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
  }

  function test_validateRejectsDisallowedBundler() public {
    PackedUserOperation memory op = _signedOp(signerPk, VALID_UNTIL, VALID_AFTER);

    (, uint256 validationData) = _validateFrom(op, makeAddr("sniper"));
    (bool sigFailed,,) = _decode(validationData);
    assertTrue(sigFailed, "op from a non-allowed origin must fail");

    vm.prank(paymaster.owner());
    paymaster.setBundlerAllowed(makeAddr("sniper"), true);
    (, validationData) = _validateFrom(op, makeAddr("sniper"));
    (sigFailed,,) = _decode(validationData);
    assertFalse(sigFailed, "op must pass once the origin is allowed");
  }

  function test_setBundlerAllowedTogglesAndEmits() public {
    address newBundler = makeAddr("newBundler");
    vm.expectEmit(true, false, false, true, address(paymaster));
    emit OxidePaymaster.BundlerAllowed(newBundler, true);
    vm.prank(paymaster.owner());
    paymaster.setBundlerAllowed(newBundler, true);
    assertTrue(paymaster.$allowedBundler(newBundler));

    vm.prank(paymaster.owner());
    paymaster.setBundlerAllowed(newBundler, false);
    assertFalse(paymaster.$allowedBundler(newBundler));
  }

  function test_setBundlerAllowedOnlyOwner() public {
    address stranger = makeAddr("stranger");
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
    vm.prank(stranger);
    paymaster.setBundlerAllowed(stranger, true);
  }

  function test_depositCreditsEntryPointBalance() public {
    assertEq(entryPoint.balanceOf(address(paymaster)), 0);
    paymaster.deposit{value: 1 ether}();
    assertEq(entryPoint.balanceOf(address(paymaster)), 1 ether);
  }

  function _baseOp() internal pure returns (PackedUserOperation memory) {
    return PackedUserOperation({
      sender: address(0xA11CE),
      nonce: 7,
      initCode: hex"",
      callData: hex"abcd",
      accountGasLimits: bytes32(uint256(0x1234)),
      preVerificationGas: 21_000,
      gasFees: bytes32(uint256(0x5678)),
      paymasterAndData: hex"",
      signature: hex""
    });
  }

  function _header() internal view returns (bytes memory) {
    return abi.encodePacked(address(paymaster), VALIDATION_GAS, POSTOP_GAS);
  }

  function _dummySig() internal pure returns (bytes memory) {
    return new bytes(65);
  }

  function _signedOp(uint256 pk, uint48 validUntil, uint48 validAfter)
    internal
    view
    returns (PackedUserOperation memory op)
  {
    op = _baseOp();
    op.paymasterAndData = _header();
    bytes32 digest = MessageHashUtils.toEthSignedMessageHash(paymaster.getHash(op, validUntil, validAfter));
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
    op.paymasterAndData = bytes.concat(_header(), abi.encodePacked(validUntil, validAfter, abi.encodePacked(r, s, v)));
  }

  function _validate(PackedUserOperation memory op) internal returns (bytes memory, uint256) {
    return _validateFrom(op, bundler);
  }

  function _validateFrom(PackedUserOperation memory op, address origin) internal returns (bytes memory, uint256) {
    vm.prank(address(entryPoint), origin);
    return paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
  }

  function _decode(uint256 validationData)
    internal
    pure
    returns (bool sigFailed, uint48 validUntil, uint48 validAfter)
  {
    sigFailed = (validationData & type(uint160).max) != 0;
    validUntil = uint48(validationData >> 160);
    validAfter = uint48(validationData >> 208);
  }
}
