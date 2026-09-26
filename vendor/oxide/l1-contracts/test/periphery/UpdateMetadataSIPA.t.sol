// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {UpdateMetadataSIPA, METADATA_UPDATE_SWEEP_FEE} from "@periphery/UpdateMetadataSIPA.sol";
import {MetadataUpdateIntent} from "@periphery/interfaces/IAccountMetadataController.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {INamePortal} from "@periphery/interfaces/INamePortal.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {StablecoinMocks} from "@test/helpers/StablecoinMocks.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {Errors} from "@periphery/Errors.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";
import {console2} from "forge-std/console2.sol";

abstract contract UpdateMetadataSIPAFixture is SweepGasFixture {
  UpdateMetadataSIPA internal updateImplementation;
  AccountMetadataRegistry internal destination;
  OxideAccount internal account;

  function setUp() public virtual override {
    super.setUp();
    account = OxideAccount(payable(accountFactory.deploy(bootstrap)));
    destination = AccountMetadataRegistry(nameRegistry.accountMetadataRegistry());
    updateImplementation = new UpdateMetadataSIPA(
      IOxidePortal(address(portal)), INameRegistry(address(nameRegistry)), METADATA_UPDATE_SWEEP_FEE
    );
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

  function _challenge(bytes memory data, address caller) internal view returns (bytes32) {
    return AccountSignatures.personalSignDigest(defaultOwner, registrationController.metadataUpdateDigest(data, caller));
  }

  function _signature(bytes memory data, address caller) internal view returns (bytes memory) {
    return AccountSignatures.k1(bootstrapKey, _challenge(data, caller));
  }

  function _installPasskey(uint256 key) internal {
    (uint256 x, uint256 y) = vm.publicKeyP256(key);
    vm.prank(address(account));
    account.addAuthKey(OxideAccount.R1Key(bytes32(x), bytes32(y)), "");
  }

  function _fund(MetadataUpdateIntent memory intent, uint256 amount)
    internal
    returns (UpdateMetadataSIPA sipa, bytes memory data, bytes memory proofs)
  {
    return _fund(intent, address(underlying), amount);
  }

  function _fund(MetadataUpdateIntent memory intent, address token, uint256 amount)
    internal
    returns (UpdateMetadataSIPA sipa, bytes memory data, bytes memory proofs)
  {
    data = abi.encode(intent);
    sipa = UpdateMetadataSIPA(
      sipaFactory.deploySIPA(address(updateImplementation), keccak256(data), regRecovery, ROLLUP_VERSION, false)
    );
    MintableToken(token).mint(address(sipa), amount);
    proofs = abi.encode(_signature(data, address(sipa)));
  }
}

contract UpdateMetadataSIPATest is UpdateMetadataSIPAFixture {
  function test_updateNotifyDeposit() public {
    MetadataUpdateIntent memory intent = _intent();
    (UpdateMetadataSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, 10 ether);
    uint256 escrowBefore = underlying.balanceOf(address(portal));
    vm.expectCall(
      address(namePortal), abi.encodeCall(INamePortal.notify, (defaultOwner, NAME_PORTAL_RECIPIENT, ROLLUP_VERSION))
    );
    vm.expectCall(
      address(portal),
      abi.encodeCall(OxidePortal.deposit, (intent.recipientCommitment, 10 ether - METADATA_UPDATE_SWEEP_FEE))
    );
    sipa.sweep(address(underlying), relayer, data, proofs);
    assertTrue(sipa.swept());
    assertTrue(destination.hasUserRecord(defaultOwner));
    assertEq(abi.encode(destination.getUserRecord(defaultOwner)), intent.metadata);
    assertEq(underlying.balanceOf(address(sipa)), 0);
    assertEq(underlying.balanceOf(relayer), METADATA_UPDATE_SWEEP_FEE);
    assertEq(underlying.balanceOf(address(portal)) - escrowBefore, 10 ether - METADATA_UPDATE_SWEEP_FEE);
    assertEq(nameRegistry.nameOf(defaultOwner), NAME_HASH);
  }

  function test_notificationFailureRollsBackRecordAndSweep() public {
    (UpdateMetadataSIPA sipa, bytes memory data, bytes memory proofs) = _fund(_intent(), 10 ether);
    vm.mockCallRevert(address(namePortal), abi.encodeWithSelector(INamePortal.notify.selector), hex"1234");
    vm.expectRevert(bytes(hex"1234"));
    sipa.sweep(address(underlying), relayer, data, proofs);
    assertFalse(destination.hasUserRecord(defaultOwner));
    assertFalse(sipa.swept());
    assertEq(underlying.balanceOf(address(sipa)), 10 ether);
  }

  function test_insufficientDepositRollsBackRecordAndNotification() public {
    (UpdateMetadataSIPA sipa, bytes memory data, bytes memory proofs) = _fund(_intent(), METADATA_UPDATE_SWEEP_FEE);
    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.SIPA__SweepBelowDepositFee.selector, METADATA_UPDATE_SWEEP_FEE, METADATA_UPDATE_SWEEP_FEE
      )
    );
    sipa.sweep(address(underlying), relayer, data, proofs);
    assertFalse(destination.hasUserRecord(defaultOwner));
    assertFalse(sipa.swept());
    assertEq(underlying.balanceOf(address(sipa)), METADATA_UPDATE_SWEEP_FEE);
  }

  function test_duplicateSweepRejected() public {
    (UpdateMetadataSIPA sipa, bytes memory data, bytes memory proofs) = _fund(_intent(), 10 ether);
    sipa.sweep(address(underlying), relayer, data, proofs);
    underlying.mint(address(sipa), 1 ether);
    vm.expectRevert(Errors.SIPA__AlreadySwept.selector);
    sipa.sweep(address(underlying), relayer, data, proofs);
  }

  function test_changedRegistryRejectsPreparedSweep() public {
    (UpdateMetadataSIPA sipa, bytes memory data, bytes memory proofs) = _fund(_intent(), 10 ether);
    AccountMetadataRegistry replacement = new AccountMetadataRegistry(nameRegistry);
    vm.prank(OWNER);
    nameRegistry.updateAccountMetadataRegistry(address(replacement));
    vm.expectRevert(Errors.MetadataUpdate__WrongRegistry.selector);
    sipa.sweep(address(underlying), relayer, data, proofs);
    assertFalse(sipa.swept());
  }
}

contract UpdateMetadataSIPAStableSettleTest is UpdateMetadataSIPAFixture {
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
    updateImplementation = new UpdateMetadataSIPA(
      IOxidePortal(address(daiPortal)), INameRegistry(address(nameRegistry)), METADATA_UPDATE_SWEEP_FEE
    );
    vm.startPrank(OWNER);
    sipaFactory.bless(address(updateImplementation));
    daiPortal.initialize(L2_PORTAL);
    vm.stopPrank();
  }

  function test_usdcSweepUpdatesMetadataAndDepositsDai() public {
    _sweepStable(USDC, 1);
  }

  function test_usdtSweepUpdatesMetadataAndDepositsDai() public {
    _sweepStable(USDT, 2);
  }

  function _sweepStable(IERC20 token, int128 coinIndex) internal {
    MetadataUpdateIntent memory intent = _intent();
    (UpdateMetadataSIPA sipa, bytes memory data, bytes memory proofs) = _fund(intent, address(token), AMOUNT_6DEC);
    uint256 settledAmount = AMOUNT_6DEC * STABLE_TO_DAI_DECIMAL_SCALE;
    uint256 depositAmount = settledAmount - METADATA_UPDATE_SWEEP_FEE;
    uint256 escrowBefore = DAI.balanceOf(address(daiPortal));
    assertEq(DAI.balanceOf(address(sipa)), 0);

    vm.expectCall(
      address(namePortal),
      abi.encodeCall(INamePortal.notify, (intent.owner, intent.namePortalRecipient, intent.rollupVersion))
    );
    vm.expectCall(address(daiPortal), abi.encodeCall(OxidePortal.deposit, (intent.recipientCommitment, depositAmount)));
    sipa.sweep(address(token), relayer, data, proofs);

    assertTrue(sipa.swept());
    assertTrue(destination.hasUserRecord(defaultOwner));
    assertEq(abi.encode(destination.getUserRecord(defaultOwner)), intent.metadata);
    assertEq(nameRegistry.nameOf(defaultOwner), NAME_HASH);
    assertEq(threePool.callCount(), 1);
    assertEq(threePool.lastI(), coinIndex);
    assertEq(threePool.lastJ(), 0);
    assertEq(threePool.lastDx(), AMOUNT_6DEC);
    assertEq(threePool.lastMinDy(), (settledAmount * 9900) / 10_000);
    assertEq(token.balanceOf(address(THREE_POOL)), AMOUNT_6DEC);
    assertEq(DAI.balanceOf(relayer), METADATA_UPDATE_SWEEP_FEE);
    assertEq(DAI.balanceOf(address(daiPortal)) - escrowBefore, depositAmount);
    assertEq(token.balanceOf(address(sipa)), 0);
    assertEq(DAI.balanceOf(address(sipa)), 0);
  }
}

abstract contract UpdateMetadataSIPAGasFixture is UpdateMetadataSIPAFixture {
  DepositSubsidy internal manager;
  UpdateMetadataSIPA internal sipa;
  bytes internal data;
  bytes internal proofs;

  function setUp() public virtual override {
    super.setUp();
    manager = new DepositSubsidy(
      OWNER, address(portal), AggregatorV3Interface(address(new MockV3Aggregator(8, PRICED_FEED_ANSWER))), sipaFactory
    );
    underlying.mint(address(manager), 1000 ether);
    vm.prank(OWNER);
    manager.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, PRICED_MIN_PROFIT);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
  }

  function _prepareSweep(bool passkey) internal {
    if (passkey) _installPasskey(12_345);
    (sipa, data, proofs) = _fund(_intent(), 10 ether);
    if (passkey) proofs = abi.encode(AccountSignatures.r1(0, 12_345, _challenge(data, address(sipa))));
  }

  function _measure() internal {
    bytes memory callData = abi.encodeCall(
      DepositSubsidy.sweepForSubsidy, (ISIPA(address(sipa)), address(underlying), relayer, data, proofs)
    );
    uint256 subsidy = manager.sweepForSubsidy(ISIPA(address(sipa)), address(underlying), relayer, data, proofs);
    uint256 chainGas = _lastCallChainCost(callData);
    console2.log("metadata sweep chain gas", chainGas);
    uint256 pricedGas = _pricedGas(subsidy, METADATA_UPDATE_SWEEP_FEE);
    assertLe(pricedGas, manager.SWEEP_GAS_METADATA_UPDATE_CEILING(), "metadata pricing must stay within its ceiling");
    assertLe(chainGas, manager.SWEEP_GAS_METADATA_UPDATE_CEILING());
    assertEq(underlying.balanceOf(relayer), METADATA_UPDATE_SWEEP_FEE + subsidy);
  }
}

contract UpdateMetadataSIPABootstrapGasTest is UpdateMetadataSIPAGasFixture {
  function setUp() public override {
    super.setUp();
    _prepareSweep(false);
  }

  function test_bootstrapSweepFitsMetadataGasCeiling() public {
    _measure();
  }
}

contract UpdateMetadataSIPAPasskeyGasTest is UpdateMetadataSIPAGasFixture {
  function setUp() public override {
    super.setUp();
    _prepareSweep(true);
  }

  function test_passkeySweepFitsMetadataGasCeiling() public {
    _measure();
  }
}
