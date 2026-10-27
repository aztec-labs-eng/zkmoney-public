// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {RegistrationSIPA} from "@periphery/RegistrationSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {ForwardingTable} from "@periphery/ForwardingTable.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OxidePortal} from "@core/OxidePortal.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {Errors} from "@periphery/Errors.sol";
import {ForwardingTableFixture, DEPOSIT_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";

contract DepositSIPASweepTest is OxidePortalBase {
  address internal relayer = makeAddr("relayer");
  bytes32 internal constant RECIPIENT_HASH = keccak256("recipient");
  uint256 internal constant DEPOSIT_AMOUNT = 100 ether;
  uint128 internal constant BENEFICIARY_FEE = 1 ether;
  uint256 internal fee;

  function setUp() public override {
    super.setUp();
    fee = DEPOSIT_SWEEP_TIP;
  }

  function test_depositTipIsFlatQuarterOfDai() external pure {
    assertEq(DEPOSIT_SWEEP_TIP, 25e16);
  }

  function test_sweepPaysTheRelayerTheTipAndBridgesTheRest() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT_AMOUNT - fee);
    assertEq(underlying.balanceOf(relayer), fee);
    assertEq(underlying.balanceOf(address(sipa)), 0, "the SIPA must keep nothing");
    assertEq(underlying.balanceOf(TABLE_BENEFICIARY), 0, "a zero beneficiary fee pays the beneficiary nothing");
  }

  function test_theCloneReportsItsTableAndTheRowOfAToken() external {
    _switchToNewTableWithDepositFee(1 ether);
    DepositSIPA sipa = _sipa();

    assertEq(address(sipa.forwardingTable()), address(forwardingTable));
    (IOxidePortal portal_, uint256 sweepTip, uint256 beneficiaryFee) = ISIPA(address(sipa)).route(address(underlying));
    assertEq(address(portal_), address(portal));
    assertEq(sweepTip, DEPOSIT_SWEEP_TIP);
    assertEq(beneficiaryFee, 1 ether);
  }

  function test_theTipChargedIsTheTipTheCloneReports() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);

    (, uint256 quoted,) = ISIPA(address(sipa)).route(address(underlying));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(relayer), quoted);
  }

  function test_sweepPaysOnlyTheTipWhateverDepositSubsidyIsNamed() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    address named = makeAddr("wellFundedDepositSubsidy");
    underlying.mint(named, 3 ether);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT_AMOUNT - fee);
    assertEq(underlying.balanceOf(relayer), fee);
    assertEq(underlying.balanceOf(named), 3 ether, "the named deposit subsidy is untouched");
  }

  function test_bareSweepPaysTheTipAndDrawsNoSubsidy() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    vm.fee(4e8);
    MockV3Aggregator aggregator = new MockV3Aggregator(8, 2500e8);
    DepositSubsidy sm = new DepositSubsidy(
      OWNER, address(portal), IOperationExecutor(address(operationExecutor)), aggregator, sipaFactory
    );
    vm.prank(OWNER);
    sm.setDepositConfig(uint128(fee), type(uint128).max, 0);
    underlying.mint(address(sm), 100 ether);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT_AMOUNT - fee);
    assertEq(underlying.balanceOf(relayer), fee, "a bare sweep pays the tip and nothing more");
    assertEq(underlying.balanceOf(address(sm)), 100 ether, "the budget is untouched");
  }

  function test_revertsWhenBalanceBelowTip() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), fee - 1);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__SweepBelowCharges.selector, fee - 1, fee));
    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
  }

  function test_revertsWhenBalanceEqualsTip() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), fee);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__SweepBelowCharges.selector, fee, fee));
    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
  }

  function test_aBalanceOneWeiAboveTheTipBridgesOneWei() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), fee + 1);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, 1);
    assertEq(underlying.balanceOf(relayer), fee);
  }

  function test_theBeneficiaryFeeGoesToTheTableBeneficiary() external {
    _switchToNewTableWithDepositFee(BENEFICIARY_FEE);
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(TABLE_BENEFICIARY), BENEFICIARY_FEE, "the beneficiary gets the row's fee");
    assertEq(underlying.balanceOf(relayer), fee, "the relayer gets the row's tip");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT_AMOUNT - fee - BENEFICIARY_FEE);
  }

  function test_revertsWhenBalanceDoesNotCoverTheTipAndTheBeneficiaryFee() external {
    _switchToNewTableWithDepositFee(BENEFICIARY_FEE);
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), fee + BENEFICIARY_FEE);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.SIPA__SweepBelowCharges.selector, fee + BENEFICIARY_FEE, fee + BENEFICIARY_FEE)
    );
    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
  }

  function test_anUnlistedTokenRevertsAndStaysForRecovery() external {
    DepositSIPA sipa = _sipa();
    TestERC20 other = new TestERC20("Other", "OTH", address(this));
    other.mint(address(sipa), DEPOSIT_AMOUNT);
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenNotListed.selector, address(other)));
    sipa.sweep(address(other), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)), portalBefore, "nothing bridged");
    assertEq(underlying.balanceOf(address(sipa)), DEPOSIT_AMOUNT, "the underlying is untouched");
    assertEq(other.balanceOf(address(sipa)), DEPOSIT_AMOUNT, "the unlisted token stays for recovery");
  }

  function test_aTokenWithoutADepositRowReverts() external {
    IForwardingTable.IntentFees[] memory intents = new IForwardingTable.IntentFees[](1);
    intents[0] = IForwardingTable.IntentFees({intent: SIPABase.Intent.Registration, beneficiaryFee: 0, sweepTip: 1});
    _switchToNewTable(intents);
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);

    vm.expectRevert(
      abi.encodeWithSelector(
        Errors.ForwardingTable__IntentNotListed.selector, address(underlying), uint8(SIPABase.Intent.Deposit)
      )
    );
    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
  }

  function test_oneSIPARoutesEachListedTokenToItsOwnPortal() external {
    TestERC20 second = new TestERC20("Second", "SND", address(this));
    OxidePortal secondPortal = _buildPortal(address(second));
    _addDepositRow(address(second), IOxidePortal(address(secondPortal)), 0);
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    second.mint(address(sipa), DEPOSIT_AMOUNT);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
    sipa.sweep(address(second), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT_AMOUNT - fee, "the first token");
    assertEq(second.balanceOf(address(secondPortal)), DEPOSIT_AMOUNT - fee, "the second token goes to its portal");
    assertEq(second.balanceOf(address(portal)), 0, "the second token does not reach the first portal");
    assertEq(second.balanceOf(relayer), fee, "the tip is paid in the swept token");
  }

  function test_aTableOnAnotherRollupVersionReverts() external {
    ForwardingTable otherVersion = new ForwardingTable(
      ForwardingTableFixture.args(OWNER, ROLLUP_VERSION + 1, TABLE_BENEFICIARY, new IForwardingTable.InitialRow[](0))
    );
    vm.prank(OWNER);
    sipaFactory.blessTable(otherVersion);
    DepositSIPA sipa = DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(_depositIntent()),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true,
        otherVersion
      )
    );
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);

    vm.expectRevert(Errors.SIPA__RollupVersionMismatch.selector);
    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
  }

  function test_aRegistrationImplementationRefusesAZeroNameRegistry() external {
    vm.expectRevert(Errors.RegistrationSIPA__ZeroNameRegistry.selector);
    new RegistrationSIPA(INameRegistry(address(0)));
  }

  function _addDepositRow(address _token, IOxidePortal _portal, uint128 _beneficiaryFee) internal {
    vm.prank(OWNER);
    forwardingTable.addRow(_token, _portal, _depositFees(_beneficiaryFee));
  }

  function _switchToNewTableWithDepositFee(uint128 _beneficiaryFee) internal {
    _switchToNewTable(_depositFees(_beneficiaryFee));
  }

  function _switchToNewTable(IForwardingTable.IntentFees[] memory _intents) internal {
    forwardingTable = ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(portal)), TABLE_BENEFICIARY, _intents);
    vm.prank(OWNER);
    sipaFactory.blessTable(forwardingTable);
  }

  function _depositFees(uint128 _beneficiaryFee) internal pure returns (IForwardingTable.IntentFees[] memory intents) {
    intents = new IForwardingTable.IntentFees[](1);
    intents[0] = IForwardingTable.IntentFees({
      intent: SIPABase.Intent.Deposit, beneficiaryFee: _beneficiaryFee, sweepTip: DEPOSIT_SWEEP_TIP
    });
  }

  function _depositIntent() internal pure returns (bytes memory) {
    return abi.encode(RECIPIENT_HASH);
  }

  function _sipa() internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(_depositIntent()),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true,
        forwardingTable
      )
    );
  }
}
