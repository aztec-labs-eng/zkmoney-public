// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {MultiStepExecutor} from "@periphery/MultiStepExecutor.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";
import {MockCallTarget} from "@test/mocks/MockCallTarget.sol";

abstract contract MultiStepExecutorHelpers is OxidePortalBase {
  uint256 internal constant MAX = type(uint256).max;

  uint256 internal withdrawalCount;

  function _transfers(uint256 _amount, address _recipient)
    internal
    pure
    returns (MultiStepExecutor.Transfer[] memory transfers)
  {
    transfers = new MultiStepExecutor.Transfer[](1);
    transfers[0] = MultiStepExecutor.Transfer({amount: _amount, recipient: _recipient});
  }

  function _noTransfers() internal pure returns (MultiStepExecutor.Transfer[] memory) {
    return new MultiStepExecutor.Transfer[](0);
  }

  function _noSteps() internal pure returns (MultiStepExecutor.Step[] memory) {
    return new MultiStepExecutor.Step[](0);
  }

  function _steps(MultiStepExecutor.Step memory _step0) internal pure returns (MultiStepExecutor.Step[] memory steps) {
    steps = new MultiStepExecutor.Step[](1);
    steps[0] = _step0;
  }

  function _steps(MultiStepExecutor.Step memory _step0, MultiStepExecutor.Step memory _step1)
    internal
    pure
    returns (MultiStepExecutor.Step[] memory steps)
  {
    steps = new MultiStepExecutor.Step[](2);
    steps[0] = _step0;
    steps[1] = _step1;
  }

  function _steps(
    MultiStepExecutor.Step memory _step0,
    MultiStepExecutor.Step memory _step1,
    MultiStepExecutor.Step memory _step2
  ) internal pure returns (MultiStepExecutor.Step[] memory steps) {
    steps = new MultiStepExecutor.Step[](3);
    steps[0] = _step0;
    steps[1] = _step1;
    steps[2] = _step2;
  }

  function _steps(
    MultiStepExecutor.Step memory _step0,
    MultiStepExecutor.Step memory _step1,
    MultiStepExecutor.Step memory _step2,
    MultiStepExecutor.Step memory _step3
  ) internal pure returns (MultiStepExecutor.Step[] memory steps) {
    steps = new MultiStepExecutor.Step[](4);
    steps[0] = _step0;
    steps[1] = _step1;
    steps[2] = _step2;
    steps[3] = _step3;
  }

  function _payload(
    uint256 _relayerTip,
    bytes32 _recoveryCommitment,
    address _remainderRecipient,
    MultiStepExecutor.Transfer[] memory _transferList,
    MultiStepExecutor.Step[] memory _stepList
  ) internal pure returns (MultiStepExecutor.UserPayload memory) {
    return MultiStepExecutor.UserPayload({
      relayerTip: _relayerTip,
      recoveryCommitment: _recoveryCommitment,
      remainderRecipient: _remainderRecipient,
      transfers: _transferList,
      steps: _stepList
    });
  }

  function _withdrawArgsFor(
    OxidePortal _portal,
    address _executor,
    uint256 _amount,
    uint256 _proverTip,
    bytes memory _userPayload,
    bytes memory _relayerPayload
  ) internal returns (IOxidePortal.WithdrawArgs memory args) {
    bytes32 withdrawalId = keccak256(abi.encode("multi-step-withdrawal", withdrawalCount++));
    IOxidePortal.WithdrawContent memory content = IOxidePortal.WithdrawContent({
      executor: _executor,
      userPayloadHash: Hash.sha256ToField(_userPayload),
      amount: _amount,
      proverTip: _proverTip,
      randomness: uint256(withdrawalId)
    });
    DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
      sender: DataStructures.L2Actor({actor: L2_TOKEN, version: ROLLUP_VERSION}),
      recipient: DataStructures.L1Actor({actor: address(_portal), chainId: block.chainid}),
      content: Hash.sha256ToField(
        abi.encodeWithSignature(
          "withdraw(address,bytes32,uint256,uint256,uint256)",
          content.executor,
          content.userPayloadHash,
          content.amount,
          content.proverTip,
          content.randomness
        )
      )
    });
    bytes32 digest = _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, withdrawalId, Hash.sha256ToField(message));
    args = IOxidePortal.WithdrawArgs({
      content: content,
      userPayload: _userPayload,
      relayerPayload: _relayerPayload,
      epochNumber: 2,
      numCheckpointsInEpoch: 1,
      leafIndex: 0,
      path: _dummyPath(),
      checkpointNumber: DEFAULT_CHECKPOINT_NUMBER,
      withdrawalId: withdrawalId,
      teeSignature: _signTee(TEST_TEE_PK, digest)
    });
  }
}

abstract contract MultiStepExecutorTestBase is MultiStepExecutorHelpers {
  uint256 internal constant AMOUNT = 2500e18;
  uint256 internal constant TIP = 25e18;
  uint256 internal constant FEE = 3e18;
  uint256 internal constant NET = AMOUNT - FEE - TIP;

  bytes32 internal constant RECOVERY_SALT = keccak256("recovery-salt");
  uint256 internal constant PASSKEY_INDEX = 0;

  TestERC20 internal dai;
  MockCallTarget internal callTarget;

  MultiStepExecutor internal executor;

  OxideAccount internal recoveryAccount;
  uint256 internal passkey;

  address internal relayer = makeAddr("relayer");
  address internal feeBeneficiary = makeAddr("fee-beneficiary");
  address internal alice = makeAddr("alice");
  address internal bob = makeAddr("bob");

  function setUp() public virtual override {
    super.setUp();
    _registerSigner();

    dai = underlying;
    callTarget = new MockCallTarget();

    executor = new MultiStepExecutor(address(portal), FEE, feeBeneficiary);

    OxideAccountFactory recoveryAccountFactory = new OxideAccountFactory();
    recoveryAccount = OxideAccount(payable(recoveryAccountFactory.deploy(makeAddr("bootstrap"))));
    passkey = uint256(keccak256("passkey")) % AccountSignatures.P256_N;
    (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
    vm.prank(address(recoveryAccount.entryPoint()));
    recoveryAccount.addAuthKey(OxideAccount.R1Key({qx: bytes32(qx), qy: bytes32(qy)}), "passkey:recovery");
  }

  function _commitment() internal view returns (bytes32) {
    return RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, address(recoveryAccount));
  }

  function _plainPayload(address _recipient) internal view returns (MultiStepExecutor.UserPayload memory) {
    return _payload(TIP, _commitment(), _recipient, _noTransfers(), _noSteps());
  }

  function _transfersPayload(MultiStepExecutor.Transfer[] memory _transferList, address _remainderRecipient)
    internal
    view
    returns (MultiStepExecutor.UserPayload memory)
  {
    return _payload(TIP, _commitment(), _remainderRecipient, _transferList, _noSteps());
  }

  function _stepsPayload(MultiStepExecutor.Step[] memory _stepList)
    internal
    view
    returns (MultiStepExecutor.UserPayload memory)
  {
    return _payload(TIP, _commitment(), address(callTarget), _noTransfers(), _stepList);
  }

  function _recoveryDigest(bytes32 _withdrawalId, address _recipient, uint256 _deadline)
    internal
    view
    returns (bytes32)
  {
    return keccak256(abi.encode(address(executor), block.chainid, _withdrawalId, _recipient, _deadline));
  }

  function _signWithPasskey(bytes32 _digest) internal view returns (bytes memory) {
    return AccountSignatures.r1(
      PASSKEY_INDEX, passkey, AccountSignatures.personalSignDigest(address(recoveryAccount), _digest)
    );
  }

  function _assertNothingSticks() internal view {
    assertEq(dai.balanceOf(address(executor)), 0, "no DAI sticks");
    assertEq(address(executor).balance, 0, "no ETH sticks");
  }

  function _withdrawArgs(uint256 _amount, uint256 _proverTip, bytes memory _userPayload, bytes memory _relayerPayload)
    internal
    returns (IOxidePortal.WithdrawArgs memory args)
  {
    args = _withdrawArgsFor(portal, address(executor), _amount, _proverTip, _userPayload, _relayerPayload);
    dai.mint(address(portal), _amount);
  }

  function _relayArgs(MultiStepExecutor.UserPayload memory _userPayload, uint256 _amount)
    internal
    returns (IOxidePortal.WithdrawArgs memory)
  {
    return _withdrawArgs(_amount, 0, abi.encode(_userPayload), abi.encodePacked(relayer));
  }

  function _relay(MultiStepExecutor.UserPayload memory _userPayload, uint256 _amount)
    internal
    returns (IOxidePortal.WithdrawArgs memory args)
  {
    args = _relayArgs(_userPayload, _amount);
    vm.prank(relayer);
    portal.withdraw(args);
  }

  function _assertRelayReverts(
    MultiStepExecutor.UserPayload memory _userPayload,
    uint256 _amount,
    bytes memory _revertData
  ) internal {
    _assertRelayReverts(_relayArgs(_userPayload, _amount), _revertData);
  }

  function _assertRelayReverts(IOxidePortal.WithdrawArgs memory _args, bytes memory _revertData) internal {
    uint256 portalBalance = dai.balanceOf(address(portal));

    vm.prank(relayer);
    vm.expectRevert(_revertData);
    portal.withdraw(_args);

    assertFalse(portal.$isWithdrawalSpent(_args.withdrawalId), "the withdrawal stays pending");
    assertEq(dai.balanceOf(address(portal)), portalBalance, "the portal keeps the funds");
  }
}
