// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";

import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {SweepGasCeilings} from "@test/helpers/SweepGasCeilings.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {IERC20 as IPayoutToken} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {AddPasskeySIPA, AddPasskeyIntent} from "@periphery/AddPasskeySIPA.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {INamePortal} from "@periphery/interfaces/INamePortal.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {IOxideAccountFactory} from "@periphery/interfaces/IOxideAccountFactory.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {DAI, USDC, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {StablecoinMocks} from "@test/helpers/StablecoinMocks.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";
import {ForwardingTableFixture, ADD_PASSKEY_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {
  ERC7579Utils,
  Mode,
  ModeSelector,
  ModePayload
} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";

abstract contract AddPasskeySIPAFixture is SweepGasFixture {
  uint256 internal constant CURRENT_PASSKEY = 12_345;
  uint256 internal constant NEW_PASSKEY = 67_890;
  bytes32 internal constant NEW_L2_ADDRESS = bytes32(uint256(0xB0B));
  bytes1 internal constant PASSKEY_METADATA_VERSION = 0x01;
  string internal constant CREDENTIAL_ID_TAG = "oxide.passkey.credential-id.v1";
  bytes internal constant ENCRYPTED_WALLET_KEY =
    hex"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d";
  uint256 internal constant VERIFICATION_GAS = 400_000;
  uint256 internal constant CALL_GAS = 400_000;
  uint256 internal constant LONGEST_CREDENTIAL_ID_BYTES = 128;

  AddPasskeySIPA internal addImplementation;
  AccountMetadataRegistry internal destination;
  OxideAccount internal account;

  function setUp() public virtual override {
    super.setUp();
    account = OxideAccount(payable(accountFactory.deploy(bootstrap)));
    destination = AccountMetadataRegistry(nameRegistry.accountMetadataRegistry());
    addImplementation = new AddPasskeySIPA(
      IOxideAccountFactory(address(accountFactory)),
      INameRegistry(address(nameRegistry)),
      INamePortal(address(namePortal))
    );
    vm.prank(OWNER);
    sipaFactory.blessImplementation(address(addImplementation));
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

  function _addIntent() internal view returns (AddPasskeyIntent memory) {
    return AddPasskeyIntent({
      rollupVersion: ROLLUP_VERSION,
      recipientCommitment: RECIPIENT_COMMITMENT,
      owner: address(account),
      nonce: uint64(entryPoint.getNonce(address(account), 0)),
      accountGasLimits: bytes32((VERIFICATION_GAS << 128) | CALL_GAS),
      record: _newRecord(),
      namePortalRecipient: NAME_PORTAL_RECIPIENT,
      key: _passkey(NEW_PASSKEY),
      metadata: _metadata()
    });
  }

  function _userOp(AddPasskeyIntent memory intent) internal view returns (PackedUserOperation memory op) {
    Execution[] memory batch = new Execution[](3);
    batch[0] = Execution(intent.owner, 0, abi.encodeCall(OxideAccount.addAuthKey, (intent.key, intent.metadata)));
    batch[1] = Execution(
      nameRegistry.accountMetadataRegistry(),
      0,
      abi.encodeCall(AccountMetadataRegistry.setUserRecord, (intent.owner, intent.record))
    );
    batch[2] = Execution(
      address(namePortal),
      0,
      abi.encodeCall(INamePortal.notify, (intent.owner, intent.namePortalRecipient, intent.rollupVersion))
    );
    op.sender = intent.owner;
    op.nonce = intent.nonce;
    Mode mode = ERC7579Utils.encodeMode(
      ERC7579Utils.CALLTYPE_BATCH, ERC7579Utils.EXECTYPE_DEFAULT, ModeSelector.wrap(0x00000000), ModePayload.wrap(0x00)
    );
    op.callData = abi.encodeCall(ERC7821.execute, (Mode.unwrap(mode), abi.encode(batch)));
    op.accountGasLimits = intent.accountGasLimits;
  }

  function _signOp(PackedUserOperation memory op) internal view returns (bytes memory) {
    return abi.encode(AccountSignatures.r1(0, CURRENT_PASSKEY, entryPoint.getUserOpHash(op)));
  }

  function _deploy(bytes memory data, bool resweepable, address token, uint256 amount)
    internal
    returns (AddPasskeySIPA sipa)
  {
    sipa = AddPasskeySIPA(
      sipaFactory.deploySIPA(
        address(addImplementation), keccak256(data), regRecovery, ROLLUP_VERSION, resweepable, forwardingTable
      )
    );
    MintableToken(token).mint(address(sipa), amount);
  }

  function _fundAdd(AddPasskeyIntent memory intent)
    internal
    returns (AddPasskeySIPA sipa, bytes memory data, bytes memory proofs)
  {
    return _fundAdd(intent, address(underlying), 10 ether);
  }

  function _fundAdd(AddPasskeyIntent memory intent, address token, uint256 amount)
    internal
    returns (AddPasskeySIPA sipa, bytes memory data, bytes memory proofs)
  {
    data = abi.encode(intent);
    sipa = _deploy(data, false, token, amount);
    proofs = _signOp(_userOp(intent));
  }

  function _metadata() internal pure returns (bytes memory) {
    bytes memory credentialId = new bytes(LONGEST_CREDENTIAL_ID_BYTES);
    for (uint256 i = 0; i < LONGEST_CREDENTIAL_ID_BYTES; i++) {
      credentialId[i] = bytes1(uint8(uint256(keccak256(abi.encode(NEW_PASSKEY, "cred", i))) | 1));
    }
    return abi.encodePacked(
      PASSKEY_METADATA_VERSION,
      keccak256(abi.encodePacked(CREDENTIAL_ID_TAG, credentialId)),
      ENCRYPTED_WALLET_KEY,
      credentialId
    );
  }
}

contract AddPasskeySIPATest is AddPasskeySIPAFixture {
  function test_aZeroAccountFactoryReverts() public {
    vm.expectRevert(Errors.AddPasskeySIPA__ZeroAccountFactory.selector);
    new AddPasskeySIPA(
      IOxideAccountFactory(address(0)), INameRegistry(address(nameRegistry)), INamePortal(address(namePortal))
    );
  }

  function test_aZeroNameRegistryReverts() public {
    vm.expectRevert(Errors.AddPasskeySIPA__ZeroNameRegistry.selector);
    new AddPasskeySIPA(
      IOxideAccountFactory(address(accountFactory)), INameRegistry(address(0)), INamePortal(address(namePortal))
    );
  }

  function test_aZeroNamePortalReverts() public {
    vm.expectRevert(Errors.AddPasskeySIPA__ZeroNamePortal.selector);
    new AddPasskeySIPA(
      IOxideAccountFactory(address(accountFactory)), INameRegistry(address(nameRegistry)), INamePortal(address(0))
    );
  }

  function test_anAddAppendsThePasskeyRepointsTheRecordAndDeposits() public {
    AddPasskeyIntent memory intent = _addIntent();
    (AddPasskeySIPA sipa, bytes memory data, bytes memory proofs) = _fundAdd(intent);
    uint256 escrowBefore = underlying.balanceOf(address(portal));

    vm.expectCall(
      address(namePortal), abi.encodeCall(INamePortal.notify, (address(account), NAME_PORTAL_RECIPIENT, ROLLUP_VERSION))
    );
    vm.expectCall(
      address(portal), abi.encodeCall(OxidePortal.deposit, (RECIPIENT_COMMITMENT, 10 ether - ADD_PASSKEY_SWEEP_TIP))
    );
    sipa.sweep(address(underlying), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    OxideAccount.R1Key memory added = account.getAuthKey(1).key;
    assertEq(added.qx, _passkey(NEW_PASSKEY).qx);
    assertEq(added.qy, _passkey(NEW_PASSKEY).qy);
    assertEq(account.getAuthKey(1).metadata, intent.metadata);
    assertEq(destination.getUserRecord(address(account)).l2Address, NEW_L2_ADDRESS);
    assertEq(entryPoint.getNonce(address(account), 0), intent.nonce + 1);
    assertEq(underlying.balanceOf(relayer), ADD_PASSKEY_SWEEP_TIP);
    assertEq(underlying.balanceOf(address(portal)) - escrowBefore, 10 ether - ADD_PASSKEY_SWEEP_TIP);
  }

  function test_anAccountOutsideTheFactoryReverts() public {
    AddPasskeyIntent memory intent = _addIntent();
    intent.owner = address(new ForeignAccount(bootstrap));
    _expectAddNotRun(intent, abi.encodeWithSelector(Errors.AddPasskeySIPA__NotFactoryAccount.selector, intent.owner));
  }

  function test_aFrontRunUserOpStillSweeps() public {
    AddPasskeyIntent memory intent = _addIntent();
    (AddPasskeySIPA sipa, bytes memory data, bytes memory proofs) = _fundAdd(intent);
    _runDirectly(intent, proofs);

    sipa.sweep(address(underlying), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    assertEq(underlying.balanceOf(relayer), ADD_PASSKEY_SWEEP_TIP);
  }

  function test_anIntentAheadOfTheAccountNonceReverts() public {
    AddPasskeyIntent memory intent = _addIntent();
    intent.nonce += 1;
    _expectAddNotRun(
      intent, abi.encodeWithSelector(Errors.AddPasskeySIPA__NonceNotReached.selector, intent.nonce - 1, intent.nonce)
    );
  }

  function test_anIntentForAnotherRollupVersionReverts() public {
    AddPasskeyIntent memory intent = _addIntent();
    intent.rollupVersion = ROLLUP_VERSION + 1;
    _expectAddNotRun(intent, abi.encodeWithSelector(Errors.SIPA__RollupVersionMismatch.selector));
  }

  function test_aSignatureByAPasskeyOutsideTheAccountReverts() public {
    AddPasskeyIntent memory intent = _addIntent();
    (AddPasskeySIPA sipa, bytes memory data,) = _fundAdd(intent);
    bytes memory proofs = abi.encode(AccountSignatures.r1(0, NEW_PASSKEY, entryPoint.getUserOpHash(_userOp(intent))));

    vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
    sipa.sweep(address(underlying), relayer, data, proofs);
  }

  function test_aRecordForAnotherRollupVersionReverts() public {
    AddPasskeyIntent memory intent = _addIntent();
    intent.record.rollupVersion = ROLLUP_VERSION + 1;
    _expectAddNotRun(
      intent,
      abi.encodeWithSelector(
        Errors.AddPasskeySIPA__RecordRollupVersionMismatch.selector, ROLLUP_VERSION + 1, ROLLUP_VERSION
      )
    );
  }

  function test_anAddWritesTheRecordToTheCurrentMetadataRegistry() public {
    AccountMetadataRegistry next = new AccountMetadataRegistry(INameRegistry(address(nameRegistry)));
    vm.prank(address(account));
    next.setUserRecord(address(account), _currentRecord());
    vm.prank(OWNER);
    nameRegistry.updateAccountMetadataRegistry(address(next));
    (AddPasskeySIPA sipa, bytes memory data, bytes memory proofs) = _fundAdd(_addIntent());

    sipa.sweep(address(underlying), relayer, data, proofs);

    assertEq(next.getUserRecord(address(account)).l2Address, NEW_L2_ADDRESS);
    assertEq(destination.getUserRecord(address(account)).l2Address, L2_ADDRESS);
  }

  function test_aFailingBatchRevertsTheSweep() public {
    AddPasskeyIntent memory intent = _addIntent();
    intent.namePortalRecipient = bytes32(0);
    _expectAddNotRun(intent, abi.encodeWithSelector(Errors.AddPasskeySIPA__RecordNotSet.selector));
  }

  function test_aSupersededUserOpReverts() public {
    AddPasskeyIntent memory intent = _addIntent();
    (AddPasskeySIPA sipa, bytes memory data, bytes memory proofs) = _fundAdd(intent);
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0] = _userOp(intent);
    ops[0].callData = abi.encodeCall(OxideAccount.setData, (bytes32(0), hex"01"));
    ops[0].signature = abi.decode(_signOp(ops[0]), (bytes));
    entryPoint.handleOps(ops, payable(address(account)));

    vm.expectRevert(Errors.AddPasskeySIPA__RecordNotSet.selector);
    sipa.sweep(address(underlying), relayer, data, proofs);
  }

  function test_aResweepableSIPAReverts() public {
    AddPasskeyIntent memory intent = _addIntent();
    bytes memory data = abi.encode(intent);
    AddPasskeySIPA sipa = _deploy(data, true, address(underlying), 10 ether);
    bytes memory proofs = _signOp(_userOp(intent));

    vm.expectRevert(Errors.AddPasskeySIPA__Resweepable.selector);
    sipa.sweep(address(underlying), relayer, data, proofs);

    assertFalse(sipa.swept());
    assertEq(account.authKeyCount(), 1);
  }

  function _expectAddNotRun(AddPasskeyIntent memory intent, bytes memory error) internal {
    (AddPasskeySIPA sipa, bytes memory data, bytes memory proofs) = _fundAdd(intent);
    uint256 nonceBefore = entryPoint.getNonce(address(account), 0);

    vm.expectRevert(error);
    sipa.sweep(address(underlying), relayer, data, proofs);

    assertFalse(sipa.swept());
    assertEq(account.authKeyCount(), 1);
    assertEq(entryPoint.getNonce(address(account), 0), nonceBefore);
  }

  function _runDirectly(AddPasskeyIntent memory intent, bytes memory proofs) internal {
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0] = _userOp(intent);
    ops[0].signature = abi.decode(proofs, (bytes));
    entryPoint.handleOps(ops, payable(address(account)));
  }
}

contract AddPasskeySIPAStableSettleTest is AddPasskeySIPAFixture {
  uint256 internal constant AMOUNT_6DEC = 10e6;
  uint256 internal constant STABLE_TO_DAI_DECIMAL_SCALE = 1e12;

  OxidePortal internal daiPortal;

  function setUp() public override {
    vm.chainId(1);
    super.setUp();
    MockCurve3Pool threePool = StablecoinMocks.install();
    threePool.setRate(address(DAI), STABLE_TO_DAI_DECIMAL_SCALE * 1e18);
    MintableToken(address(DAI)).mint(address(THREE_POOL), 1_000_000 ether);

    daiPortal = _buildPortal(address(DAI));
    forwardingTable = ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(daiPortal)), TABLE_BENEFICIARY);
    vm.prank(OWNER);
    sipaFactory.blessTable(forwardingTable);
  }

  function test_aUsdcSweepRunsTheAddAndDepositsDai() public {
    (AddPasskeySIPA sipa, bytes memory data, bytes memory proofs) = _fundAdd(_addIntent(), address(USDC), AMOUNT_6DEC);
    uint256 depositAmount = AMOUNT_6DEC * STABLE_TO_DAI_DECIMAL_SCALE - ADD_PASSKEY_SWEEP_TIP;

    vm.expectCall(address(daiPortal), abi.encodeCall(OxidePortal.deposit, (RECIPIENT_COMMITMENT, depositAmount)));
    sipa.sweep(address(USDC), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertEq(account.authKeyCount(), 2);
    assertEq(DAI.balanceOf(relayer), ADD_PASSKEY_SWEEP_TIP);
    assertEq(IERC20(USDC).balanceOf(address(sipa)), 0);
  }
}

abstract contract AddPasskeySIPASubsidyFixture is AddPasskeySIPAFixture {
  DepositSubsidy internal manager;
  AddPasskeySIPA internal sipa;
  bytes internal data;
  bytes internal proofs;

  function setUp() public virtual override {
    super.setUp();
    manager = new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(new MockV3Aggregator(8, PRICED_FEED_ANSWER))),
      sipaFactory,
      SweepGasCeilings.initial()
    );
    underlying.mint(address(manager), 1000 ether);
    vm.prank(OWNER);
    manager.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
  }
}

contract AddPasskeySIPACallGasTest is AddPasskeySIPASubsidyFixture {
  uint256 internal constant MAX_ADD_PASSKEY_CALL_GAS = 4_000_000;
  uint256 internal constant MAX_SIMULATION_GAS = 15_000_000;

  /// forge-config: default.isolate = true
  function test_anAddWithThreeHalvesOfItsGasEstimateSweepsAtTheRelayerFirstGasLimit() public {
    _checkMetadataLengths();
  }

  /// forge-config: default.isolate = true
  function test_anAddIntoAnEmptyRegistryWithThreeHalvesOfItsGasEstimateSweepsAtTheRelayerFirstGasLimit() public {
    AccountMetadataRegistry empty = new AccountMetadataRegistry(INameRegistry(address(nameRegistry)));
    vm.prank(OWNER);
    nameRegistry.updateAccountMetadataRegistry(address(empty));
    _checkMetadataLengths();
  }

  function _checkMetadataLengths() internal {
    uint256[3] memory lengths = [uint256(33), 95, 223];
    for (uint256 i = 0; i < lengths.length; i++) {
      uint256 snapshot = vm.snapshotState();
      _checkAdd(lengths[i]);
      vm.revertToState(snapshot);
    }
  }

  function _checkAdd(uint256 metadataLength) internal {
    AddPasskeyIntent memory intent = _addIntent();
    intent.metadata = _metadataOf(metadataLength);
    uint256 estimate = _gasEstimate(intent);
    uint256 intrinsicGas =
      RelayerTransaction.TX_INTRINSIC_GAS + RelayerTransaction.calldataGas(_userOp(intent).callData);
    uint256 callGas = ((estimate - intrinsicGas) * 3) / 2;
    assertLe(callGas, MAX_ADD_PASSKEY_CALL_GAS, "the call gas of an add is more than MAX_ADD_PASSKEY_CALL_GAS");
    intent.accountGasLimits = bytes32((VERIFICATION_GAS << 128) | callGas);

    (sipa, data, proofs) = _fundAdd(intent);
    bytes memory relay = abi.encodeCall(
      OperationExecutor.execute,
      (
        address(manager),
        abi.encodeCall(
          DepositSubsidy.sweepForSubsidy,
          (ISIPA(address(sipa)), address(underlying), address(operationExecutor), data, proofs)
        ),
        IPayoutToken(address(underlying)),
        0,
        0,
        0
      )
    );
    uint256 snapshot = vm.snapshotState();
    uint256 txGas = _relayedTxGas(relay, MAX_SIMULATION_GAS);
    vm.revertToState(snapshot);
    uint256 gasLimit = (txGas * 3) / 2;
    console2.log("add passkey, metadata bytes", metadataLength, "gas estimate", estimate);
    console2.log("add passkey, metadata bytes", metadataLength, "relayed sweep", txGas);
    assertLe(gasLimit, MAX_SIMULATION_GAS, "the relayer's first gas limit is more than its simulation gas");
    _relayedTxGas(relay, gasLimit);

    assertEq(account.authKeyCount(), 2);
    AccountMetadataRegistry registry = AccountMetadataRegistry(nameRegistry.accountMetadataRegistry());
    assertEq(registry.getUserRecord(address(account)).l2Address, NEW_L2_ADDRESS);
  }

  function _relayedTxGas(bytes memory relay, uint256 gasLimit) internal returns (uint256 txGas) {
    uint256 executionGas = gasLimit - RelayerTransaction.TX_INTRINSIC_GAS - RelayerTransaction.calldataGas(relay);
    vm.prank(relayer, relayer);
    uint256 before = gasleft();
    (bool ok,) = address(operationExecutor).call{gas: executionGas}(relay);
    txGas = before - gasleft();
    require(ok, "the relayed sweep reverted");
  }

  function _gasEstimate(AddPasskeyIntent memory intent) internal returns (uint256) {
    bytes memory callData = _userOp(intent).callData;
    uint256 snapshot = vm.snapshotState();
    vm.prank(address(entryPoint));
    uint256 before = gasleft();
    (bool ok,) = address(account).call(callData);
    uint256 txGas = before - gasleft();
    require(ok, "a direct run of the add reverted");
    vm.revertToState(snapshot);
    return (txGas * 64) / 63;
  }

  function _metadataOf(uint256 length) internal pure returns (bytes memory) {
    bytes memory walletKey = new bytes(length - 33);
    for (uint256 i = 0; i < walletKey.length; i++) {
      walletKey[i] = bytes1(uint8(i + 1));
    }
    return
      abi.encodePacked(PASSKEY_METADATA_VERSION, keccak256(abi.encodePacked(CREDENTIAL_ID_TAG, hex"c0ffee")), walletKey);
  }
}

contract ForeignAccount {
  address internal immutable BOOTSTRAP;

  constructor(address _bootstrap) {
    BOOTSTRAP = _bootstrap;
  }

  function bootstrapOwner() external view returns (address) {
    return BOOTSTRAP;
  }
}
