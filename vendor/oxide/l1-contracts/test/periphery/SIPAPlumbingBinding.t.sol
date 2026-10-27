// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {ForwardingTable} from "@periphery/ForwardingTable.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {RegistrationSIPA} from "@periphery/RegistrationSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {Errors} from "@periphery/Errors.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {RegistrationTestBase} from "@test/periphery/registration/RegistrationTestBase.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {MockPortal} from "@test/mocks/MockPortal.sol";
import {
  ForwardingTableFixture,
  DEPOSIT_SWEEP_TIP,
  REGISTRATION_SWEEP_TIP
} from "@test/helpers/ForwardingTableFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";

contract RoguePortal {
  IERC20 public immutable UNDERLYING;
  uint256 public immutable ROLLUP_VERSION;
  address public immutable SINK;

  constructor(IERC20 _underlying, uint256 _version, address _sink) {
    UNDERLYING = _underlying;
    ROLLUP_VERSION = _version;
    SINK = _sink;
  }

  function deposit(bytes32, uint256 amount) external returns (bytes32, uint256, uint256) {
    UNDERLYING.transferFrom(msg.sender, SINK, amount);
    return (bytes32(0), 0, amount);
  }
}

contract SIPAPlumbingBindingTest is RegistrationTestBase {
  address internal attacker = makeAddr("attacker");

  function test_GivenTheCloneArgs_ThenTheyNameOnlyTheTable() external {
    bytes memory intent = _depositIntent("shape");
    DepositSIPA sipa = _depositSIPA(intent);

    assertEq(
      abi.encode(
        SIPABase.Args(keccak256(intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true, forwardingTable)
      )
      .length,
      5 * 32
    );
    assertEq(address(sipa.forwardingTable()), address(forwardingTable));
    (IOxidePortal portal_, uint256 sweepTip,) = sipa.route(address(underlying));
    assertEq(address(portal_), address(portal));
    assertEq(sweepTip, DEPOSIT_SWEEP_TIP);
  }

  function test_GivenARoguePortal_ThenNoSIPACanSettleAgainstIt() external {
    RoguePortal rogue = new RoguePortal(IERC20(address(underlying)), ROLLUP_VERSION, attacker);
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, REGISTRATION_MIN + REGISTRATION_FEE);

    (IOxidePortal portal_,,) = sipa.route(address(underlying));
    assertEq(address(portal_), address(portal));
    assertNotEq(address(portal_), address(rogue));

    uint256 portalBefore = underlying.balanceOf(address(portal));
    _sweepRegistrationAsAttacker(sipa, registrationData);

    assertEq(underlying.balanceOf(attacker), REGISTRATION_SWEEP_TIP, "only the relayer's cut is the sweeper's");
    assertEq(
      underlying.balanceOf(address(portal)) - portalBefore,
      REGISTRATION_MIN,
      "the floor the controller enforced must reach the portal"
    );
  }

  function test_GivenARegistrationSweep_ThenOnlyTheTablesTipIsCharged() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase sipa = _deployAndFund(registrationData, REGISTRATION_MIN + REGISTRATION_FEE);

    uint256 sweepFee = REGISTRATION_SWEEP_TIP;
    (, uint256 sweepTip,) = sipa.route(address(underlying));
    assertEq(sweepTip, sweepFee, "the clone charges its table's tip and no other");

    _sweepRegistrationAsAttacker(sipa, registrationData);

    assertEq(underlying.balanceOf(attacker), sweepFee, "only the relayer's cut is the relayer's");
    assertEq(underlying.balanceOf(address(portal)), REGISTRATION_MIN, "the deposit must reach the portal");
  }

  function test_GivenAFrontRun_ThenTheParallelSIPACannotSettle() external {
    bytes memory registrationData = _registrationData(NAME_HASH, defaultOwner);
    SIPABase victim = _deployAndFund(registrationData, 100 ether);

    uint256 stake = REGISTRATION_MIN + REGISTRATION_FEE;
    underlying.mint(attacker, stake);
    SIPABase front = SIPABase(
      sipaFactory.deploySIPA(
        address(registrationSIPAImplementation),
        keccak256(registrationData),
        _recoveryCommitment("attackerRecovery"),
        ROLLUP_VERSION,
        true,
        forwardingTable
      )
    );
    assertNotEq(address(front), address(victim));
    assertTrue(sipaFactory.isBlessed(address(front)), "provenance alone still admits it");
    vm.prank(attacker);
    underlying.transfer(address(front), stake);

    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);
    bytes memory proofs = _regProofs(consent, auth, _noTerms());
    vm.prank(attacker);
    vm.expectPartialRevert(Errors.RegistrationController__InvalidConsent.selector);
    front.sweep(address(underlying), attacker, registrationData, proofs);

    assertEq(nameRegistry.ownerOf(NAME_HASH), address(0));
    _sweepRegistrationAsAttacker(victim, registrationData);
    assertEq(nameRegistry.ownerOf(NAME_HASH), defaultOwner);
    assertEq(underlying.balanceOf(address(victim)), 0, "the victim's deposit is not stranded");
  }

  function test_GivenASelfFundedSweep_ThenItDrawsLessThanItCost() external {
    uint128 fee = uint128(DEPOSIT_SWEEP_TIP);
    MockV3Aggregator feed = new MockV3Aggregator(8, 3000e8);
    DepositSubsidy sm = new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(feed)),
      sipaFactory
    );
    underlying.mint(address(sm), 100_000 ether);
    vm.prank(OWNER);
    sm.setDepositConfig(0.1e18, 12e18, 0);
    vm.fee(1 gwei);
    vm.txGasPrice(1 gwei);

    bytes memory intent = _depositIntent("drain");
    DepositSIPA sipa = _depositSIPA(intent);
    (, uint256 sweepTip,) = sipa.route(address(underlying));
    assertEq(sweepTip, DEPOSIT_SWEEP_TIP, "a SIPA has no fee of its own, only its table's");

    bytes memory sweep = abi.encodeCall(
      DepositSubsidy.sweepForSubsidy,
      (ISIPA(address(sipa)), address(underlying), address(operationExecutor), intent, "")
    );
    underlying.mint(address(sipa), 100 ether);
    (uint256 warm,) = RelayerTransaction.send(relayer, sm, sweep);
    underlying.mint(address(sipa), 100 ether);

    uint256 relayerBefore = underlying.balanceOf(relayer);
    (uint256 subsidy, uint256 txGas) = RelayerTransaction.send(relayer, sm, sweep);

    uint256 realCostUsd = txGas * 1 gwei * 3000;
    console2.log("warm", warm, "subsidy", subsidy);
    console2.log("transaction gas", txGas, "real cost (1e18 USD)", realCostUsd);

    assertEq(underlying.balanceOf(relayer) - relayerBefore, subsidy + fee, "the payout is the subsidy plus the fee");
    assertLt(subsidy, realCostUsd, "a self-swept deposit must never earn more than the gas it burnt");
    assertLt(subsidy, 1e18, "an ordinary deposit sweep is nowhere near the 12 DAI ceiling");
  }

  function test_GivenEachIntent_ThenTheQuoteIsKeyedOnIt() external {
    uint128 fee = uint128(DEPOSIT_SWEEP_TIP);
    MockV3Aggregator feed = new MockV3Aggregator(8, 3000e8);
    DepositSubsidy sm = new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(feed)),
      sipaFactory
    );
    underlying.mint(address(sm), 100_000 ether);
    vm.prank(OWNER);
    sm.setDepositConfig(0.1e18, type(uint128).max, 0);
    vm.fee(1 gwei);
    vm.txGasPrice(1 gwei);

    assertGt(
      sm.quoteSubsidy(fee, sm.SWEEP_GAS_REGISTRATION_CEILING()),
      sm.quoteSubsidy(fee, sm.SWEEP_GAS_DEPOSIT_CEILING()),
      "a registration must be quoted above a deposit at the ceiling"
    );
    assertGt(sm.SWEEP_GAS_SWAP_USDC_HOP(), 0, "the USDC route carries swap gas");
    assertGt(sm.SWEEP_GAS_SWAP_USDT_HOP(), 0, "the USDT route carries swap gas");
  }

  function test_GivenAGrowingBlessedSet_ThenTheGateCostDoesNotGrow() external {
    bytes memory intent = _depositIntent("gate");
    DepositSIPA sipa = _depositSIPA(intent);
    underlying.mint(address(sipa), 100 ether);
    vm.prank(relayer);
    sipa.sweep(address(underlying), relayer, intent, "");

    uint256[3] memory costs;
    uint256[3] memory sizes = [uint256(1), 4, 8];
    for (uint256 i = 0; i < sizes.length; i++) {
      _growBlessedSetTo(sizes[i]);
      uint256 before = gasleft();
      sipaFactory.isBlessed(address(sipa));
      costs[i] = before - gasleft();
      console2.log("blessed implementations", sizes[i], "isSIPA gas", costs[i]);
    }

    assertEq(costs[2], costs[1], "the gate must not get dearer as the set grows");
  }

  function test_GivenAVersionRoll_ThenTheOlderTableStaysBlessed() external {
    bytes memory intent = _depositIntent("roll");
    DepositSIPA sipa = _depositSIPA(intent);
    underlying.mint(address(sipa), 100 ether);

    MockPortal nextPortal = new MockPortal(IERC20(address(underlying)), ROLLUP_VERSION + 1);
    _blessTable(_tableFor(address(nextPortal)));

    assertTrue(sipaFactory.isBlessed(address(sipa)), "the older table must stay blessed");
    vm.prank(relayer);
    sipa.sweep(address(underlying), relayer, intent, "");
    assertEq(underlying.balanceOf(address(sipa)), 0, "a SIPA funded before the roll must still sweep");
  }

  function test_GivenANewTable_ThenTheIntentPointersDoNotChange() external {
    ForwardingTable nextTable = _tableFor(address(new MockPortal(IERC20(address(underlying)), ROLLUP_VERSION)));
    _blessTable(nextTable);

    assertTrue(sipaFactory.approvedTable(address(nextTable)));
    assertTrue(sipaFactory.approvedTable(address(forwardingTable)), "the earlier table stays approved");
    assertEq(sipaFactory.implementationFor(SIPABase.Intent.Deposit), address(depositSIPAImplementation));
    assertEq(sipaFactory.implementationFor(SIPABase.Intent.Registration), address(registrationSIPAImplementation));
  }

  function test_GivenANewImplementation_ThenItsIntentIsPointedAgainAndOlderSIPAsStillSweep() external {
    bytes memory intent = _depositIntent("repoint");
    DepositSIPA older = _depositSIPA(intent);
    underlying.mint(address(older), 100 ether);
    address nextDeposit = address(new DepositSIPA());

    vm.prank(OWNER);
    sipaFactory.blessImplementation(nextDeposit);

    assertEq(sipaFactory.implementationFor(SIPABase.Intent.Deposit), nextDeposit);
    assertEq(
      sipaFactory.implementationFor(SIPABase.Intent.Registration),
      address(registrationSIPAImplementation),
      "the other intents keep their pointers"
    );
    assertTrue(sipaFactory.intentOf(address(depositSIPAImplementation)) == SIPABase.Intent.Deposit);
    address newer = sipaFactory.deploySIPA(
      nextDeposit, keccak256(intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true, forwardingTable
    );
    assertNotEq(newer, address(older));
    assertTrue(sipaFactory.isBlessed(newer));

    assertTrue(sipaFactory.isBlessed(address(older)), "a SIPA of the earlier implementation stays blessed");
    vm.prank(relayer);
    older.sweep(address(underlying), relayer, intent, "");
    assertEq(underlying.balanceOf(address(older)), 0, "a SIPA funded before the new pointing must still sweep");
  }

  function test_GivenADepositImplementation_ThenItDoesNotAuthenticateARegistration() external {
    assertTrue(sipaFactory.intentOf(address(depositSIPAImplementation)) == SIPABase.Intent.Deposit);
    assertTrue(sipaFactory.intentOf(address(registrationSIPAImplementation)) == SIPABase.Intent.Registration);
    assertTrue(sipaFactory.intentOf(makeAddr("neither")) == SIPABase.Intent.None);
  }

  function test_GivenANonOwner_WhenBlessing_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    sipaFactory.blessImplementation(address(depositSIPAImplementation));
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    sipaFactory.blessTable(forwardingTable);
  }

  function test_GivenAZeroImplementation_WhenBlessing_ThenReverts() external {
    vm.prank(OWNER);
    vm.expectRevert(Errors.SIPAFactory__ZeroImplementation.selector);
    sipaFactory.blessImplementation(address(0));
  }

  function test_GivenAnImplementationOfNoIntent_WhenBlessing_ThenReverts() external {
    address noIntent = makeAddr("noIntent");
    vm.mockCall(noIntent, abi.encodeCall(SIPABase.INTENT, ()), abi.encode(SIPABase.Intent.None));
    vm.prank(OWNER);
    vm.expectRevert(Errors.SIPAFactory__ZeroImplementation.selector);
    sipaFactory.blessImplementation(noIntent);
  }

  function test_GivenAZeroTable_WhenBlessing_ThenReverts() external {
    vm.prank(OWNER);
    vm.expectRevert(Errors.SIPAFactory__ZeroTable.selector);
    sipaFactory.blessTable(IForwardingTable(address(0)));
  }

  function test_GivenAFactoryClone_ThenItsImplementationIsReadBackExactly() external {
    address clone = sipaFactory.deploySIPA(
      address(depositSIPAImplementation),
      keccak256("offset"),
      _recoveryCommitment("r"),
      ROLLUP_VERSION,
      true,
      forwardingTable
    );
    assertEq(
      sipaFactory.cloneImplementation(clone),
      address(depositSIPAImplementation),
      "the ERC-1167 implementation offset has moved; the gate would read the wrong address"
    );
  }

  function _growBlessedSetTo(uint256 target) internal {
    while (blessedCount < target) {
      address portalFor = address(new MockPortal(IERC20(address(underlying)), ROLLUP_VERSION + 100 + blessedCount));
      address deposit = address(new DepositSIPA());
      address registration = address(new RegistrationSIPA(INameRegistry(address(nameRegistry))));
      ForwardingTable table = _tableFor(portalFor);
      vm.startPrank(OWNER);
      sipaFactory.blessImplementation(deposit);
      sipaFactory.blessImplementation(registration);
      sipaFactory.blessTable(table);
      vm.stopPrank();
      blessedCount++;
    }
  }

  uint256 internal blessedCount = 1;

  function _tableFor(address _portal) internal returns (ForwardingTable) {
    return ForwardingTableFixture.deploy(OWNER, IOxidePortal(_portal), TABLE_BENEFICIARY);
  }

  function _blessTable(ForwardingTable _table) internal {
    vm.prank(OWNER);
    sipaFactory.blessTable(_table);
  }

  function _depositIntent(bytes32 _salt) internal pure returns (bytes memory) {
    return abi.encode(_salt);
  }

  function _depositSIPA(bytes memory _intent) internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(_intent),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true,
        forwardingTable
      )
    );
  }

  function _sweepRegistrationAsAttacker(SIPABase _sipa, bytes memory _registrationData) internal {
    bytes memory consent = _consentSig(bootstrapKey, _registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);
    vm.prank(attacker);
    _sipa.sweep(address(underlying), attacker, _registrationData, _regProofs(consent, auth, _noTerms()));
  }
}
