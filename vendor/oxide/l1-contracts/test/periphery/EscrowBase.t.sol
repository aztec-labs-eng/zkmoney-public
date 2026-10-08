// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";
import {EscrowRecoveryTestBase, NonPayableRecipient} from "@test/periphery/EscrowRecoveryTestBase.sol";

contract EscrowBaseTest is EscrowRecoveryTestBase {
  uint256 internal constant AMOUNT = 2500e18;
  bytes32 internal constant RECOVERY_NONCE = keccak256("recovery-nonce");

  TestERC20 internal token;
  TestEscrowFactory internal factory;
  address internal target = makeAddr("recovery-target");
  uint256 internal deadline;

  function setUp() public override {
    super.setUp();

    token = new TestERC20("DAI", "DAI", address(this));
    factory = new TestEscrowFactory();
    deadline = block.timestamp + 1 days;
  }

  function test_RecoveryCommitmentReadsTheCloneArgs() external {
    address escrow = _deployedEscrow(0);
    assertEq(
      TestEscrow(escrow).recoveryCommitment(),
      RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account))
    );
    assertEq(TestEscrow(escrow).FACTORY(), address(factory));
  }

  function test_ImplementationRevertsAsNotClone() external {
    TestEscrow implementation = TestEscrow(factory.IMPLEMENTATION());
    vm.expectRevert(EscrowBase.EscrowBase__NotClone.selector);
    implementation.recoveryCommitment();
  }

  function test_OnlyFactoryCanCallGuardedFunctions() external {
    address escrow = _deployedEscrow(0);
    factory.execute(escrow);

    vm.expectRevert(EscrowBase.EscrowBase__NotFactory.selector);
    TestEscrow(escrow).execute(address(this));
  }

  function test_RecoverERC20RejectsReplayedNonce() external {
    address escrow = _deployedEscrow(AMOUNT);
    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline);

    token.mint(escrow, AMOUNT);
    vm.expectRevert(EscrowBase.EscrowBase__NonceAlreadyUsed.selector);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline);
  }

  function test_RecoverERC20RejectsWrongSigner() external {
    address escrow = _deployedEscrow(AMOUNT);
    bytes memory signature = _sign(
      _p256Key("mallory"),
      keccak256(abi.encode(escrow, block.chainid, target, address(token), RECOVERY_NONCE, deadline))
    );

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline);
  }

  function test_RecoverERC20RejectsWrongSalt() external {
    address escrow = _deployedEscrow(AMOUNT);
    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);

    vm.expectRevert(EscrowBase.EscrowBase__RecoveryCommitmentMismatch.selector);
    TestEscrow(escrow)
      .recoverERC20(
        keccak256("wrong-salt"), address(account), signature, target, address(token), RECOVERY_NONCE, deadline
      );
  }

  function test_RecoverERC20RejectsAccountOutsideTheCommitment() external {
    address escrow = _deployedEscrow(AMOUNT);
    (address otherBootstrap, uint256 otherBootstrapKey) = makeAddrAndKey("other-bootstrap");
    OxideAccount other = OxideAccount(payable(accountFactory.deploy(otherBootstrap)));
    bytes32 digest = keccak256(abi.encode(escrow, block.chainid, target, address(token), RECOVERY_NONCE, deadline));
    bytes memory signature =
      AccountSignatures.k1(otherBootstrapKey, AccountSignatures.personalSignDigest(address(other), digest));

    vm.expectRevert(EscrowBase.EscrowBase__RecoveryCommitmentMismatch.selector);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(other), signature, target, address(token), RECOVERY_NONCE, deadline);
  }

  function test_RecoverERC20RejectsPasskeySignatureOverRawDigest() external {
    address escrow = _deployedEscrow(AMOUNT);
    bytes memory signature = AccountSignatures.r1(
      PASSKEY_INDEX,
      passkey,
      keccak256(abi.encode(escrow, block.chainid, target, address(token), RECOVERY_NONCE, deadline))
    );

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline);
  }

  function test_RecoverERC20RejectsSignatureForAnotherTarget() external {
    address escrow = _deployedEscrow(AMOUNT);
    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    TestEscrow(escrow)
      .recoverERC20(
        RECOVERY_SALT, address(account), signature, makeAddr("thief"), address(token), RECOVERY_NONCE, deadline
      );
  }

  function test_RecoverERC20AcceptsSignatureExactlyAtDeadline() external {
    address escrow = _deployedEscrow(AMOUNT);
    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);

    vm.warp(deadline);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline);
    assertEq(token.balanceOf(target), AMOUNT);
  }

  function test_RecoverERC20RejectsExpiredSignature() external {
    address escrow = _deployedEscrow(AMOUNT);
    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);

    vm.warp(deadline + 1);
    vm.expectRevert(abi.encodeWithSelector(EscrowBase.EscrowBase__RecoveryExpired.selector, deadline));
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline);
  }

  function test_RecoverERC20RejectsSignatureForAnotherDeadline() external {
    address escrow = _deployedEscrow(AMOUNT);
    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline + 1);
  }

  function test_RecoverERC20RevertsOnEmptyBalance() external {
    address escrow = _deployedEscrow(0);
    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);

    vm.expectRevert(EscrowBase.EscrowBase__EmptyBalance.selector);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline);
  }

  function test_RecoverETHSendsBalanceToTarget() external {
    address escrow = _deployedEscrow(0);
    vm.deal(escrow, 1 ether);

    bytes memory signature = _signRecoverETH(escrow, target, RECOVERY_NONCE, deadline);
    vm.expectEmit(true, true, true, true, escrow);
    emit EscrowBase.EscrowRecovered(address(0), target, 1 ether);
    TestEscrow(escrow).recoverETH(RECOVERY_SALT, address(account), signature, target, RECOVERY_NONCE, deadline);

    assertEq(target.balance, 1 ether);
    assertEq(escrow.balance, 0);
    assertTrue(TestEscrow(escrow).usedNonces(RECOVERY_NONCE));
  }

  function test_RecoverETHRejectsExpiredSignature() external {
    address escrow = _deployedEscrow(0);
    vm.deal(escrow, 1 ether);
    bytes memory signature = _signRecoverETH(escrow, target, RECOVERY_NONCE, deadline);

    vm.warp(deadline + 1);
    vm.expectRevert(abi.encodeWithSelector(EscrowBase.EscrowBase__RecoveryExpired.selector, deadline));
    TestEscrow(escrow).recoverETH(RECOVERY_SALT, address(account), signature, target, RECOVERY_NONCE, deadline);
  }

  function test_RecoverETHRejectsErc20Digest() external {
    address escrow = _deployedEscrow(0);
    vm.deal(escrow, 1 ether);
    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    TestEscrow(escrow).recoverETH(RECOVERY_SALT, address(account), signature, target, RECOVERY_NONCE, deadline);
  }

  function test_RecoverETHRevertsWhenTargetRejectsEth() external {
    address escrow = _deployedEscrow(0);
    vm.deal(escrow, 1 ether);
    address rejecting = address(new NonPayableRecipient());
    bytes memory signature = _signRecoverETH(escrow, rejecting, RECOVERY_NONCE, deadline);

    vm.expectRevert(EscrowBase.EscrowBase__EthTransferFailed.selector);
    TestEscrow(escrow).recoverETH(RECOVERY_SALT, address(account), signature, rejecting, RECOVERY_NONCE, deadline);
  }

  function test_RecoveryNonceIsSharedAcrossTokenAndEth() external {
    address escrow = _deployedEscrow(AMOUNT);
    vm.deal(escrow, 1 ether);
    TestEscrow(escrow)
      .recoverETH(
        RECOVERY_SALT,
        address(account),
        _signRecoverETH(escrow, target, RECOVERY_NONCE, deadline),
        target,
        RECOVERY_NONCE,
        deadline
      );

    bytes memory signature = _signRecoverERC20(escrow, target, address(token), RECOVERY_NONCE, deadline);
    vm.expectRevert(EscrowBase.EscrowBase__NonceAlreadyUsed.selector);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, address(account), signature, target, address(token), RECOVERY_NONCE, deadline);
  }

  function test_RecoverERC20AcceptsEoaPersonalSignSignature() external {
    (address eoa, uint256 eoaKey) = makeAddrAndKey("eoa-recovery");
    address escrow = _deployedEoaEscrow(eoa, AMOUNT);
    bytes32 digest = keccak256(abi.encode(escrow, block.chainid, target, address(token), RECOVERY_NONCE, deadline));

    vm.prank(makeAddr("anyone"));
    TestEscrow(escrow)
      .recoverERC20(
        RECOVERY_SALT,
        eoa,
        _signEoa(eoaKey, MessageHashUtils.toEthSignedMessageHash(digest)),
        target,
        address(token),
        RECOVERY_NONCE,
        deadline
      );

    assertEq(token.balanceOf(target), AMOUNT);
    assertTrue(TestEscrow(escrow).usedNonces(RECOVERY_NONCE));
  }

  function test_RecoverETHAcceptsEoaPersonalSignSignature() external {
    (address eoa, uint256 eoaKey) = makeAddrAndKey("eoa-recovery");
    address escrow = _deployedEoaEscrow(eoa, 0);
    vm.deal(escrow, 1 ether);
    bytes32 digest = keccak256(abi.encode(escrow, block.chainid, target, RECOVERY_NONCE, deadline));

    TestEscrow(escrow)
      .recoverETH(
        RECOVERY_SALT,
        eoa,
        _signEoa(eoaKey, MessageHashUtils.toEthSignedMessageHash(digest)),
        target,
        RECOVERY_NONCE,
        deadline
      );

    assertEq(target.balance, 1 ether);
  }

  function test_RecoverERC20RejectsEoaSignatureOverRawDigest() external {
    (address eoa, uint256 eoaKey) = makeAddrAndKey("eoa-recovery");
    address escrow = _deployedEoaEscrow(eoa, AMOUNT);
    bytes32 digest = keccak256(abi.encode(escrow, block.chainid, target, address(token), RECOVERY_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    TestEscrow(escrow)
      .recoverERC20(RECOVERY_SALT, eoa, _signEoa(eoaKey, digest), target, address(token), RECOVERY_NONCE, deadline);
  }

  function test_RecoverERC20RejectsEoaSignatureFromAnotherKey() external {
    (address eoa,) = makeAddrAndKey("eoa-recovery");
    (, uint256 malloryKey) = makeAddrAndKey("mallory");
    address escrow = _deployedEoaEscrow(eoa, AMOUNT);
    bytes32 digest = keccak256(abi.encode(escrow, block.chainid, target, address(token), RECOVERY_NONCE, deadline));

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    TestEscrow(escrow)
      .recoverERC20(
        RECOVERY_SALT,
        eoa,
        _signEoa(malloryKey, MessageHashUtils.toEthSignedMessageHash(digest)),
        target,
        address(token),
        RECOVERY_NONCE,
        deadline
      );
  }

  function test_RecoverERC20RejectsMalformedEoaSignature() external {
    (address eoa,) = makeAddrAndKey("eoa-recovery");
    address escrow = _deployedEoaEscrow(eoa, AMOUNT);

    vm.expectRevert(EscrowBase.EscrowBase__InvalidSignature.selector);
    TestEscrow(escrow).recoverERC20(RECOVERY_SALT, eoa, hex"1234", target, address(token), RECOVERY_NONCE, deadline);
  }

  function _deployedEoaEscrow(address _eoa, uint256 _balance) internal returns (address escrow) {
    TestEscrow.Args memory args = _args();
    args.recoveryCommitment = RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, _eoa);
    escrow = factory.deploy(args);
    if (_balance > 0) {
      token.mint(escrow, _balance);
    }
  }

  function _signEoa(uint256 _key, bytes32 _hash) internal pure returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(_key, _hash);
    return abi.encodePacked(r, s, v);
  }

  function _args() internal view returns (TestEscrow.Args memory) {
    return TestEscrow.Args({
      recoveryCommitment: RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(account))
    });
  }

  function _deployedEscrow(uint256 _balance) internal returns (address escrow) {
    escrow = factory.deploy(_args());
    if (_balance > 0) {
      token.mint(escrow, _balance);
    }
  }
}

contract TestEscrow is EscrowBase {
  struct Args {
    bytes32 recoveryCommitment;
  }

  function execute(address) external override onlyFactory {}

  function _recoveryCommitment() internal view override returns (bytes32) {
    return abi.decode(_cloneArgs(), (Args)).recoveryCommitment;
  }
}

contract TestEscrowFactory {
  address public immutable IMPLEMENTATION = address(new TestEscrow());

  function deploy(TestEscrow.Args memory _args) external returns (address) {
    return Clones.cloneDeterministicWithImmutableArgs(IMPLEMENTATION, abi.encode(_args), bytes32(0));
  }

  function execute(address _escrow) external {
    TestEscrow(_escrow).execute(msg.sender);
  }
}
