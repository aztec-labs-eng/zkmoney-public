// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {RegistrationSIPA} from "@periphery/RegistrationSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {Errors} from "@periphery/Errors.sol";

contract DepositSIPASweepTest is OxidePortalBase {
  address internal relayer = makeAddr("relayer");
  bytes32 internal constant RECIPIENT_HASH = keccak256("recipient");
  uint256 internal constant DEPOSIT_AMOUNT = 100 ether;
  uint256 internal fee;

  function setUp() public override {
    super.setUp();
    _initialize();
    fee = DEPOSIT_FEE;
  }

  function test_depositFeeIsFlatQuarterOfDai() external pure {
    assertEq(DEPOSIT_FEE, 25e16);
  }

  function test_sweepPaysTheRelayerTheFeeAndBridgesTheRest() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT_AMOUNT - fee);
    assertEq(underlying.balanceOf(relayer), fee);
    assertEq(underlying.balanceOf(address(sipa)), 0, "the SIPA must keep nothing");
    assertEq(underlying.balanceOf(FEE_BENEFICIARY), 0);
  }

  function test_theFeeChargedIsTheFeeTheDepositSubsidyQuotes() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);

    uint256 quoted = ISIPA(address(sipa)).depositFee();
    assertEq(quoted, depositSIPAImplementation.DEPOSIT_FEE(), "the clone reports its implementation's fee");

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(relayer), quoted);
  }

  function test_sweepPaysOnlyTheFeeWhateverDepositSubsidyIsNamed() external {
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

  function test_bareSweepPaysTheFeeAndDrawsNoSubsidy() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    vm.fee(4e8);
    MockV3Aggregator aggregator = new MockV3Aggregator(8, 2500e8);
    DepositSubsidy sm = new DepositSubsidy(OWNER, address(portal), aggregator, sipaFactory);
    vm.prank(OWNER);
    sm.setDepositConfig(uint128(fee), type(uint128).max, uint128(fee));
    underlying.mint(address(sm), 100 ether);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT_AMOUNT - fee);
    assertEq(underlying.balanceOf(relayer), fee, "a bare sweep pays the fee and nothing more");
    assertEq(underlying.balanceOf(address(sm)), 100 ether, "the budget is untouched");
  }

  function test_sweepWithoutADepositSubsidyStillBridges() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT_AMOUNT - fee);
    assertEq(underlying.balanceOf(relayer), fee);
  }

  function test_revertsWhenBalanceBelowFee() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), fee - 1);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__SweepBelowDepositFee.selector, fee - 1, fee));
    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
  }

  function test_revertsWhenBalanceEqualsFee() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), fee);

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__SweepBelowDepositFee.selector, fee, fee));
    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
  }

  function test_aBalanceOneWeiAboveTheFeeBridgesOneWei() external {
    DepositSIPA sipa = _sipa();
    underlying.mint(address(sipa), fee + 1);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    sipa.sweep(address(underlying), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)) - portalBefore, 1);
    assertEq(underlying.balanceOf(relayer), fee);
  }

  function test_anImplementationRefusesAZeroFee() external {
    vm.expectRevert(Errors.SIPA__ZeroDepositFee.selector);
    new DepositSIPA(IOxidePortal(address(portal)), 0);

    vm.expectRevert(Errors.SIPA__ZeroDepositFee.selector);
    new RegistrationSIPA(IOxidePortal(address(portal)), INameRegistry(address(nameRegistry)), 0);
  }

  function test_aRegistrationImplementationRefusesAZeroNameRegistry() external {
    vm.expectRevert(Errors.RegistrationSIPA__ZeroNameRegistry.selector);
    new RegistrationSIPA(IOxidePortal(address(portal)), INameRegistry(address(0)), fee);
  }

  function test_aStrayTokenNeitherBridgesNorTouchesTheUnderlying() external {
    DepositSIPA sipa = _sipa();
    TestERC20 other = new TestERC20("Other", "OTH", address(this));
    other.mint(address(sipa), DEPOSIT_AMOUNT);
    underlying.mint(address(sipa), DEPOSIT_AMOUNT);
    uint256 portalBefore = underlying.balanceOf(address(portal));

    vm.expectRevert(abi.encodeWithSelector(Errors.SIPA__TokenNotPortalUnderlying.selector, address(other)));
    sipa.sweep(address(other), relayer, _depositIntent(), "");

    assertEq(underlying.balanceOf(address(portal)), portalBefore, "nothing bridged");
    assertEq(underlying.balanceOf(address(sipa)), DEPOSIT_AMOUNT, "the underlying is untouched");
  }

  function test_theImplementationPinsThePortalsTokenAndVersion() external view {
    assertEq(address(depositSIPAImplementation.PORTAL()), address(portal));
    assertEq(address(depositSIPAImplementation.UNDERLYING()), address(underlying));
    assertEq(portal.ROLLUP_VERSION(), ROLLUP_VERSION);
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
        true
      )
    );
  }
}
