// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {UserOpSIPA, UserOpIntent, UserOpCondition} from "@periphery/UserOpSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {INamePortal} from "@periphery/interfaces/INamePortal.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {StablecoinMocks} from "@test/helpers/StablecoinMocks.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {Errors} from "@periphery/Errors.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";
import {ForwardingTableFixture, USER_OP_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {console2} from "forge-std/console2.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {
  ERC7579Utils,
  Mode,
  ModeSelector,
  ModePayload
} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

abstract contract UserOpSIPAFixture is SweepGasFixture {
  uint256 internal constant CURRENT_PASSKEY = 12_345;
  uint256 internal constant NEW_PASSKEY = 67_890;
  bytes32 internal constant NEW_L2_ADDRESS = bytes32(uint256(0xB0B));
  bytes1 internal constant PASSKEY_METADATA_VERSION = 0x01;
  string internal constant CREDENTIAL_ID_TAG = "oxide.passkey.credential-id.v1";
  bytes internal constant CREDENTIAL_ID = hex"0102030405060708090a0b0c0d0e0f1011121314";
  bytes internal constant ENCRYPTED_WALLET_KEY =
    hex"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d";
  uint256 internal constant VERIFICATION_GAS = 400_000;
  uint256 internal constant CALL_GAS = 400_000;

  UserOpSIPA internal userOpImplementation;
  AccountMetadataRegistry internal destination;
  OxideAccount internal account;

  function setUp() public virtual override {
    super.setUp();
    account = OxideAccount(payable(accountFactory.deploy(bootstrap)));
    destination = AccountMetadataRegistry(nameRegistry.accountMetadataRegistry());
    userOpImplementation = new UserOpSIPA();
    vm.prank(OWNER);
    sipaFactory.blessImplementation(address(userOpImplementation));
    vm.prank(address(registrationController));
    nameRegistry.claimName(
      NAME_HASH, defaultOwner, _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days)
    );
    vm.startPrank(address(account));
    account.addAuthKey(_passkey(CURRENT_PASSKEY), "");
    destination.setUserRecord(address(account), _currentRecord());
    vm.stopPrank();
  }

  function _passkey(uint256 privateKey) internal pure returns (OxideAccount.R1Key memory) {
    (uint256 x, uint256 y) = vm.publicKeyP256(privateKey);
    return OxideAccount.R1Key(bytes32(x), bytes32(y));
  }

  function _currentRecord() internal view returns (AccountMetadataRegistry.UserRecord memory) {
    return _record(AccountMetadataRegistry.K1Point(G_X, G_Y), L2_ADDRESS, resolverOperatorAddr, ROLLUP_VERSION);
  }

  function _newRecord() internal view returns (AccountMetadataRegistry.UserRecord memory) {
    return _record(AccountMetadataRegistry.K1Point(G_X, G_Y), NEW_L2_ADDRESS, resolverOperatorAddr, ROLLUP_VERSION);
  }

  function _addPasskeyBatch() internal view returns (Execution[] memory batch) {
    batch = new Execution[](3);
    batch[0] = _selfCall(abi.encodeCall(OxideAccount.addAuthKey, (_passkey(NEW_PASSKEY), _passkeyMetadata())));
    batch[1] = Execution(
      address(destination), 0, abi.encodeCall(AccountMetadataRegistry.setUserRecord, (address(account), _newRecord()))
    );
    batch[2] = Execution(
      address(namePortal),
      0,
      abi.encodeCall(INamePortal.notify, (address(account), NAME_PORTAL_RECIPIENT, ROLLUP_VERSION))
    );
  }

  function _replacePasskeyBatch() internal view returns (Execution[] memory batch) {
    Execution[] memory add = _addPasskeyBatch();
    batch = new Execution[](add.length + 1);
    for (uint256 i = 0; i < add.length; i++) {
      batch[i] = add[i];
    }
    batch[add.length] = _selfCall(abi.encodeCall(OxideAccount.removeAuthKey, (0, _passkey(CURRENT_PASSKEY))));
  }

  function _passkeyMetadata() internal pure returns (bytes memory) {
    return abi.encodePacked(
      PASSKEY_METADATA_VERSION, keccak256(abi.encodePacked(CREDENTIAL_ID_TAG, CREDENTIAL_ID)), ENCRYPTED_WALLET_KEY
    );
  }

  function _selfCall(bytes memory callData) internal view returns (Execution memory) {
    return Execution(address(account), 0, callData);
  }

  function _intent(Execution[] memory batch) internal view returns (UserOpIntent memory) {
    bytes32 mode = bytes32(
      Mode.unwrap(
        ERC7579Utils.encodeMode(
          ERC7579Utils.CALLTYPE_BATCH,
          ERC7579Utils.EXECTYPE_DEFAULT,
          ModeSelector.wrap(0x00000000),
          ModePayload.wrap(0x00)
        )
      )
    );
    bytes memory readRecord = abi.encodeCall(AccountMetadataRegistry.getUserRecord, (address(account)));
    return UserOpIntent({
      precondition: UserOpCondition(address(destination), readRecord, keccak256(abi.encode(_currentRecord()))),
      postcondition: UserOpCondition(address(destination), readRecord, keccak256(abi.encode(_newRecord()))),
      rollupVersion: ROLLUP_VERSION,
      recipientCommitment: RECIPIENT_COMMITMENT,
      owner: address(account),
      nonce: uint64(entryPoint.getNonce(address(account), 0)),
      callData: abi.encodeCall(ERC7821.execute, (mode, abi.encode(batch))),
      accountGasLimits: bytes32((VERIFICATION_GAS << 128) | CALL_GAS)
    });
  }

  function _userOp(UserOpIntent memory intent) internal pure returns (PackedUserOperation memory op) {
    op.sender = intent.owner;
    op.nonce = intent.nonce;
    op.callData = intent.callData;
    op.accountGasLimits = intent.accountGasLimits;
  }

  function _sign(UserOpIntent memory intent, uint256 privateKey) internal view returns (bytes memory) {
    return AccountSignatures.r1(0, privateKey, entryPoint.getUserOpHash(_userOp(intent)));
  }

  function _runDirectly(UserOpIntent memory intent) internal {
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0] = _userOp(intent);
    ops[0].signature = _sign(intent, CURRENT_PASSKEY);
    entryPoint.handleOps(ops, payable(address(account)));
  }

  function _fund(UserOpIntent memory intent, uint256 amount)
    internal
    returns (UserOpSIPA sipa, bytes memory data, bytes memory proofs)
  {
    return _fund(intent, address(underlying), amount);
  }

  function _fund(UserOpIntent memory intent, address token, uint256 amount)
    internal
    returns (UserOpSIPA sipa, bytes memory data, bytes memory proofs)
  {
    data = abi.encode(intent);
    sipa = UserOpSIPA(
      sipaFactory.deploySIPA(
        address(userOpImplementation), keccak256(data), regRecovery, ROLLUP_VERSION, false, forwardingTable
      )
    );
    MintableToken(token).mint(address(sipa), amount);
    proofs = abi.encode(_sign(intent, CURRENT_PASSKEY));
  }
}

contract UserOpSIPATest is UserOpSIPAFixture {
  function test_aRotationAddsAPasskeyRepointsTheRecordAndDeposits() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);
    uint256 escrowBefore = underlying.balanceOf(address(portal));

    vm.expectCall(
      address(namePortal), abi.encodeCall(INamePortal.notify, (address(account), NAME_PORTAL_RECIPIENT, ROLLUP_VERSION))
    );
    vm.expectCall(
      address(portal), abi.encodeCall(OxidePortal.deposit, (RECIPIENT_COMMITMENT, 10 ether - USER_OP_SWEEP_TIP))
    );
    sipa.sweep(address(underlying), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    assertEq(account.getAuthKey(1).key.qx, _passkey(NEW_PASSKEY).qx);
    assertEq(account.getAuthKey(1).metadata, _passkeyMetadata());
    assertEq(destination.getUserRecord(address(account)).l2Address, NEW_L2_ADDRESS);
    assertEq(entryPoint.getNonce(address(account), 0), intent.nonce + 1);
    assertEq(underlying.balanceOf(relayer), USER_OP_SWEEP_TIP);
    assertEq(underlying.balanceOf(address(portal)) - escrowBefore, 10 ether - USER_OP_SWEEP_TIP);
  }

  function test_aRotationReplacesThePasskey() public {
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(_intent(_replacePasskeyBatch()), 10 ether);

    sipa.sweep(address(underlying), relayer, data, proofs);

    assertEq(account.authKeyCount(), 1);
    assertEq(account.getAuthKey(0).key.qx, _passkey(NEW_PASSKEY).qx);
    assertEq(account.getAuthKey(0).metadata, _passkeyMetadata());
  }

  function test_aSignatureByAPasskeyOutsideTheAccountReverts() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    (UserOpSIPA sipa, bytes memory data,) = _fund(intent, 10 ether);
    bytes memory proofs = abi.encode(_sign(intent, NEW_PASSKEY));

    vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
    sipa.sweep(address(underlying), relayer, data, proofs);
  }

  function test_aBatchThatMissesThePostconditionReverts() public {
    Execution[] memory batch = _addPasskeyBatch();
    Execution[] memory keepRecord = new Execution[](1);
    keepRecord[0] = batch[0];
    _expectNotRun(_intent(keepRecord), Errors.UserOpSIPA__PostconditionFailed.selector);
  }

  function test_aFailingBatchRevertsTheSweep() public {
    Execution[] memory batch = _addPasskeyBatch();
    Execution[] memory failing = new Execution[](batch.length + 1);
    for (uint256 i = 0; i < batch.length; i++) {
      failing[i] = batch[i];
    }
    failing[batch.length] = _selfCall(abi.encodeCall(OxideAccount.removeAuthKey, (0, _passkey(NEW_PASSKEY))));
    _expectNotRun(_intent(failing), Errors.UserOpSIPA__PostconditionFailed.selector);
  }

  function test_aFailedPreconditionReverts() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    vm.prank(address(account));
    destination.setUserRecord(
      address(account),
      _record(AccountMetadataRegistry.K1Point(G_X, G_Y), bytes32(uint256(0xCAFE)), resolverOperatorAddr, ROLLUP_VERSION)
    );
    _expectNotRun(intent, Errors.UserOpSIPA__PreconditionFailed.selector);
  }

  function test_aFrontRunUserOpStillSweeps() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);
    _runDirectly(intent);

    sipa.sweep(address(underlying), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    assertEq(underlying.balanceOf(relayer), USER_OP_SWEEP_TIP);
  }

  function test_aSupersededUserOpReverts() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);
    Execution[] memory other = new Execution[](1);
    other[0] = _selfCall(abi.encodeCall(OxideAccount.setData, (bytes32(0), hex"01")));
    _runDirectly(_intent(other));

    vm.expectRevert(Errors.UserOpSIPA__PostconditionFailed.selector);
    sipa.sweep(address(underlying), relayer, data, proofs);
  }

  function test_aRevertingConditionReverts() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    intent.precondition.data = abi.encodeCall(AccountMetadataRegistry.getUserRecord, (address(0xdead)));
    _expectNotRun(intent, Errors.UserOpSIPA__ConditionReverted.selector);
  }

  function test_aConditionOnATargetWithoutCodeReverts() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    intent.precondition = UserOpCondition(address(0xbeef), "", keccak256(""));
    _expectNotRun(intent, Errors.UserOpSIPA__ConditionTargetHasNoCode.selector);
  }

  function test_anIntentAheadOfTheAccountNonceReverts() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    intent.nonce += 1;
    intent.postcondition.resultHash = bytes32(0);
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);

    vm.expectRevert(Errors.UserOpSIPA__NonceNotReached.selector);
    sipa.sweep(address(underlying), relayer, data, proofs);

    assertFalse(sipa.swept());
    assertEq(entryPoint.getNonce(address(account), 0), intent.nonce - 1);
  }

  function test_aSecondSweepReverts() public {
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(_intent(_addPasskeyBatch()), 10 ether);
    sipa.sweep(address(underlying), relayer, data, proofs);
    underlying.mint(address(sipa), 1 ether);

    vm.expectRevert(Errors.SIPA__AlreadySwept.selector);
    sipa.sweep(address(underlying), relayer, data, proofs);
  }

  function test_anIntentForAnotherRollupVersionReverts() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    intent.rollupVersion = ROLLUP_VERSION + 1;
    _expectNotRun(intent, Errors.SIPA__RollupVersionMismatch.selector);
  }

  function test_anIntentWithoutConditionsRunsTheUserOp() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    intent.precondition = UserOpCondition(address(0), "", bytes32(0));
    intent.postcondition = UserOpCondition(address(0), "", bytes32(0));
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);

    sipa.sweep(address(underlying), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    assertEq(destination.getUserRecord(address(account)).l2Address, NEW_L2_ADDRESS);
  }

  function test_aFailingBatchWithoutAPostconditionStillSweeps() public {
    Execution[] memory batch = _addPasskeyBatch();
    Execution[] memory failing = new Execution[](batch.length + 1);
    for (uint256 i = 0; i < batch.length; i++) {
      failing[i] = batch[i];
    }
    failing[batch.length] = _selfCall(abi.encodeCall(OxideAccount.removeAuthKey, (0, _passkey(NEW_PASSKEY))));
    UserOpIntent memory intent = _intent(failing);
    intent.postcondition.resultHash = bytes32(0);
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);

    sipa.sweep(address(underlying), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 1);
    assertEq(entryPoint.getNonce(address(account), 0), intent.nonce + 1);
    assertEq(underlying.balanceOf(relayer), USER_OP_SWEEP_TIP);
  }

  function test_aChangedStateWithoutAPreconditionRunsTheUserOp() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    intent.precondition.resultHash = bytes32(0);
    vm.prank(address(account));
    destination.setUserRecord(
      address(account),
      _record(AccountMetadataRegistry.K1Point(G_X, G_Y), bytes32(uint256(0xCAFE)), resolverOperatorAddr, ROLLUP_VERSION)
    );
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);

    sipa.sweep(address(underlying), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    assertEq(destination.getUserRecord(address(account)).l2Address, NEW_L2_ADDRESS);
  }

  function test_aPreconditionAndAPostconditionCanReadDifferentCalls() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    intent.precondition = UserOpCondition(
      address(account), abi.encodeCall(OxideAccount.authKeyCount, ()), keccak256(abi.encode(uint256(1)))
    );
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);

    sipa.sweep(address(underlying), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    assertEq(destination.getUserRecord(address(account)).l2Address, NEW_L2_ADDRESS);
  }

  function test_aTokenWithoutARowRevertsAndRunsNothing() public {
    TestERC20 unlisted = new TestERC20("Unlisted", "UNL", address(this));
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, address(unlisted), 10 ether);

    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenNotListed.selector, address(unlisted)));
    sipa.sweep(address(unlisted), relayer, data, proofs);

    assertFalse(sipa.swept());
    assertEq(account.authKeyCount(), 1);
    assertEq(entryPoint.getNonce(address(account), 0), intent.nonce);
    assertEq(unlisted.balanceOf(address(sipa)), 10 ether, "the unlisted token stays for recovery");
  }

  function test_aResweepableSIPAReverts() public {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    bytes memory data = abi.encode(intent);
    UserOpSIPA sipa = UserOpSIPA(
      sipaFactory.deploySIPA(
        address(userOpImplementation), keccak256(data), regRecovery, ROLLUP_VERSION, true, forwardingTable
      )
    );
    MintableToken(address(underlying)).mint(address(sipa), 10 ether);
    bytes memory proofs = abi.encode(_sign(intent, CURRENT_PASSKEY));

    vm.expectRevert(Errors.UserOpSIPA__Resweepable.selector);
    sipa.sweep(address(underlying), relayer, data, proofs);

    assertFalse(sipa.swept());
    assertEq(account.authKeyCount(), 1);
  }

  function _expectNotRun(UserOpIntent memory intent, bytes4 error) internal {
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);

    vm.expectRevert(error);
    sipa.sweep(address(underlying), relayer, data, proofs);

    assertFalse(sipa.swept());
    assertEq(account.authKeyCount(), 1);
    assertEq(entryPoint.getNonce(address(account), 0), intent.nonce);
  }
}

contract UserOpSIPAStableSettleTest is UserOpSIPAFixture {
  uint256 internal constant AMOUNT_6DEC = 10e6;
  uint256 internal constant STABLE_TO_DAI_DECIMAL_SCALE = 1e12;

  MockCurve3Pool internal threePool;
  OxidePortal internal daiPortal;

  function setUp() public override {
    vm.chainId(1);
    super.setUp();
    threePool = StablecoinMocks.install();
    threePool.setRate(address(DAI), STABLE_TO_DAI_DECIMAL_SCALE * 1e18);
    MintableToken(address(DAI)).mint(address(THREE_POOL), 1_000_000 ether);

    daiPortal = _buildPortal(address(DAI));
    forwardingTable = ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(daiPortal)), TABLE_BENEFICIARY);
    vm.prank(OWNER);
    sipaFactory.blessTable(forwardingTable);
  }

  function test_usdcSweepRunsTheUserOpAndDepositsDai() public {
    _sweepStable(USDC, 1);
  }

  function test_usdtSweepRunsTheUserOpAndDepositsDai() public {
    _sweepStable(USDT, 2);
  }

  function _sweepStable(IERC20 token, int128 coinIndex) internal {
    UserOpIntent memory intent = _intent(_addPasskeyBatch());
    (UserOpSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, address(token), AMOUNT_6DEC);
    uint256 settledAmount = AMOUNT_6DEC * STABLE_TO_DAI_DECIMAL_SCALE;
    uint256 depositAmount = settledAmount - USER_OP_SWEEP_TIP;
    uint256 escrowBefore = DAI.balanceOf(address(daiPortal));

    vm.expectCall(
      address(namePortal), abi.encodeCall(INamePortal.notify, (address(account), NAME_PORTAL_RECIPIENT, ROLLUP_VERSION))
    );
    vm.expectCall(address(daiPortal), abi.encodeCall(OxidePortal.deposit, (RECIPIENT_COMMITMENT, depositAmount)));
    sipa.sweep(address(token), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    assertEq(destination.getUserRecord(address(account)).l2Address, NEW_L2_ADDRESS);
    assertEq(threePool.callCount(), 1);
    assertEq(threePool.lastI(), coinIndex);
    assertEq(threePool.lastJ(), 0);
    assertEq(threePool.lastDx(), AMOUNT_6DEC);
    assertEq(threePool.lastMinDy(), (settledAmount * 9900) / 10_000);
    assertEq(token.balanceOf(address(THREE_POOL)), AMOUNT_6DEC);
    assertEq(DAI.balanceOf(relayer), USER_OP_SWEEP_TIP);
    assertEq(DAI.balanceOf(address(daiPortal)) - escrowBefore, depositAmount);
    assertEq(token.balanceOf(address(sipa)), 0);
    assertEq(DAI.balanceOf(address(sipa)), 0);
  }
}

abstract contract UserOpSIPAGasFixture is UserOpSIPAFixture {
  DepositSubsidy internal manager;
  UserOpSIPA internal sipa;
  bytes internal data;
  bytes internal proofs;

  function setUp() public override {
    super.setUp();
    manager = new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(new MockV3Aggregator(8, PRICED_FEED_ANSWER))),
      sipaFactory
    );
    underlying.mint(address(manager), 1000 ether);
    vm.prank(OWNER);
    manager.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
    (sipa, data, proofs) = _fund(_intent(_batch()), 10 ether);
  }

  function _batch() internal view virtual returns (Execution[] memory);

  function _measure() internal returns (uint256 chainGas) {
    bytes memory callData = abi.encodeCall(
      DepositSubsidy.sweepForSubsidy, (ISIPA(address(sipa)), address(underlying), relayer, data, proofs)
    );
    uint256 snapshot = vm.snapshotState();
    vm.prank(relayer);
    (bool ok,) = address(manager).call(callData);
    require(ok, "direct sweep reverted");
    chainGas = _lastCallChainCost(callData);
    vm.revertToState(snapshot);
    console2.log("user op sweep chain gas", chainGas);

    (uint256 subsidy,) = RelayerTransaction.send(
      relayer,
      manager,
      abi.encodeCall(
        DepositSubsidy.sweepForSubsidy,
        (ISIPA(address(sipa)), address(underlying), address(operationExecutor), data, proofs)
      )
    );
    uint256 pricedGas = _pricedGas(subsidy, USER_OP_SWEEP_TIP);
    assertLe(
      pricedGas,
      manager.SWEEP_GAS_USER_OP_CEILING() + manager.FRESH_BALANCE_GAS(),
      "user op pricing must stay within its ceiling"
    );
    assertLe(chainGas, manager.SWEEP_GAS_USER_OP_CEILING());
    assertEq(underlying.balanceOf(relayer), USER_OP_SWEEP_TIP + subsidy);
  }
}

contract UserOpSIPAAddPasskeyGasTest is UserOpSIPAGasFixture {
  function _batch() internal view override returns (Execution[] memory) {
    return _addPasskeyBatch();
  }

  function test_addPasskeyRotationFitsUserOpGasCeiling() public {
    _measure();
  }

  function test_userOpCeilingStaysWithinTenPercentOfTheAddPasskeyRotation() public {
    uint256 chainGas = _measure();
    assertLe(
      manager.SWEEP_GAS_USER_OP_CEILING(),
      (chainGas * 110) / 100,
      "SWEEP_GAS_USER_OP_CEILING has drifted well above the add-passkey rotation"
    );
  }
}

contract UserOpSIPAReplacePasskeyGasTest is UserOpSIPAGasFixture {
  function _batch() internal view override returns (Execution[] memory) {
    return _replacePasskeyBatch();
  }

  function test_replacePasskeyRotationFitsUserOpGasCeiling() public {
    _measure();
  }
}
