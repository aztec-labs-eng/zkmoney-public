// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";

import {GasBurningSIPA} from "@test/periphery/GasBurningSIPA.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

contract DepositSubsidyFarmSafetyTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;
  DepositSubsidy internal fm;

  DepositSIPA internal firstSipa;
  DepositSIPA internal warmSipa;
  SIPABase internal registrationSipa;
  bytes internal registrationData;

  function setUp() public virtual override {
    super.setUp();
    MockV3Aggregator feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    fm = new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(address(feed)), sipaFactory);
    underlying.mint(address(fm), 1_000_000 ether);

    vm.prank(OWNER);
    fm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, PRICED_MIN_PROFIT);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);

    firstSipa = _depositSIPA(_depositIntent("first"));
    underlying.mint(address(firstSipa), DEPOSIT);
    warmSipa = _depositSIPA(_depositIntent("warm"));
    underlying.mint(address(warmSipa), DEPOSIT);

    registrationData = _registrationData(NAME_HASH, defaultOwner);
    registrationSipa = _deployAndFund(registrationData, DEPOSIT);
  }

  function _depositIntent(bytes32 _salt) internal pure returns (bytes memory) {
    return abi.encode(_field(_salt));
  }

  function _depositSIPA(bytes memory _intent) internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation), keccak256(_intent), _recoveryCommitment("recovery"), ROLLUP_VERSION, true
      )
    );
  }

  function test_GivenFirstDepositSweep_ThenThePayoutStaysUnderTheRealCost() external {
    _assertUnderRealCost(
      _sweepCalldata(address(firstSipa), _depositIntent("first"), ""), DEPOSIT_FEE, "first deposit sweep"
    );
  }

  function test_GivenWarmResweep_ThenThePayoutStaysUnderTheRealCost() external {
    bytes memory callData = _sweepCalldata(address(warmSipa), _depositIntent("warm"), "");

    _submit(callData);
    underlying.mint(address(warmSipa), DEPOSIT);
    _submit(callData);

    underlying.mint(address(warmSipa), DEPOSIT);
    _assertUnderRealCost(callData, DEPOSIT_FEE, "warm re-sweep");
  }

  function test_GivenRevertedSweep_ThenNothingIsPaidOut() external {
    bytes memory intent = _depositIntent("reverting");
    DepositSIPA sipa = _depositSIPA(intent);
    underlying.mint(address(sipa), DEPOSIT_FEE - 1);
    uint256 budgetBefore = underlying.balanceOf(address(fm));
    uint256 relayerBefore = underlying.balanceOf(relayer);

    vm.prank(relayer);
    (bool ok,) = address(fm).call(_sweepCalldata(address(sipa), intent, ""));

    assertFalse(ok, "the below-fee sweep must fail");
    assertEq(underlying.balanceOf(address(fm)), budgetBefore, "a failed sweep must draw nothing");
    assertEq(underlying.balanceOf(relayer), relayerBefore, "a failed sweep must pay nothing");
  }

  function test_GivenATypicalRegistration_ThenThePayoutStaysUnderItsCost() external {
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);

    _assertUnderRealCost(
      _sweepCalldata(address(registrationSipa), registrationData, _regProofs(consent, auth, _noTerms())),
      registrationSIPAImplementation.DEPOSIT_FEE(),
      "typical registration sweep"
    );
  }

  function test_GivenARegistration_ThenItIsPricedAboveAnyDepositSweep() external {
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);

    uint256 priced = _pricedGas(
      _submit(_sweepCalldata(address(registrationSipa), registrationData, _regProofs(consent, auth, _noTerms()))),
      registrationSIPAImplementation.DEPOSIT_FEE()
    );
    console2.log("registration priced gas", priced);

    assertGt(
      priced, fm.SWEEP_GAS_DEPOSIT_CEILING(), "a registration must price above everything the deposit ceiling can pay"
    );
    assertLe(
      priced, fm.SWEEP_GAS_REGISTRATION_CEILING(), "a registration priced past its own ceiling: the cap is not binding"
    );
  }

  function test_GivenPaddingUnderTheCeiling_ThenItEarnsTheFarmerNothing() external {
    vm.mockCall(address(sipaFactory), abi.encodeWithSelector(SIPAFactory.sipaIntentOf.selector), abi.encode(1));

    _burnSweep(new GasBurningSIPA(address(portal), DEPOSIT_FEE, 60_000));
    (uint256 leanSubsidy, uint256 leanGas) = _burnSweep(new GasBurningSIPA(address(portal), DEPOSIT_FEE, 60_000));
    (uint256 paddedSubsidy, uint256 paddedGas) = _burnSweep(new GasBurningSIPA(address(portal), DEPOSIT_FEE, 120_000));

    uint256 pricedDelta = _pricedGas(paddedSubsidy, DEPOSIT_FEE) - _pricedGas(leanSubsidy, DEPOSIT_FEE);
    uint256 burntDelta = paddedGas - leanGas;

    console2.log("lean", leanGas, "padded", paddedGas);
    console2.log("padding priced at", pricedDelta, "padding burnt", burntDelta);
    assertGt(paddedSubsidy, leanSubsidy, "under the ceiling the meter must still be moving");
    assertLe(pricedDelta, burntDelta, "padding is paid more gas than it burns: the farmer nets the difference");
  }

  function test_GivenTwoSweepsPastTheCeiling_ThenTheyDrawTheSamePayout() external {
    uint128 fee = uint128(DEPOSIT_FEE);
    vm.mockCall(address(sipaFactory), abi.encodeWithSelector(SIPAFactory.sipaIntentOf.selector), abi.encode(1));
    vm.fee(2 gwei);
    vm.txGasPrice(2 gwei);
    vm.prank(OWNER);
    fm.setDepositConfig(fee, type(uint128).max, fee);

    GasBurningSIPA lean = new GasBurningSIPA(address(portal), DEPOSIT_FEE, 400_000);
    GasBurningSIPA padded = new GasBurningSIPA(address(portal), DEPOSIT_FEE, 700_000);

    (uint256 leanSubsidy, uint256 leanGas) = _burnSweep(lean);
    (uint256 paddedSubsidy, uint256 paddedGas) = _burnSweep(padded);

    console2.log("lean", leanGas, "padded", paddedGas);
    assertGt(paddedGas, leanGas, "the padded sweep must really have burnt more");
    assertEq(paddedSubsidy, leanSubsidy, "burning past the ceiling must not move the payout");
  }

  function _burnSweep(GasBurningSIPA _sipa) internal returns (uint256 subsidy, uint256 gasUsed) {
    uint256 before = gasleft();
    subsidy = fm.sweepForSubsidy(ISIPA(address(_sipa)), address(underlying), relayer, "", "");
    gasUsed = before - gasleft();
  }

  function _sweepCalldata(address _sipa, bytes memory _intentData, bytes memory _proofs)
    internal
    view
    returns (bytes memory)
  {
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy, (ISIPA(_sipa), address(underlying), relayer, _intentData, _proofs)
    );
  }

  function _submit(bytes memory _callData) internal returns (uint256 subsidy) {
    vm.prank(relayer);
    (bool ok, bytes memory ret) = address(fm).call(_callData);
    require(ok, "sweep reverted");
    subsidy = abi.decode(ret, (uint256));
  }

  function _assertUnderRealCost(bytes memory _callData, uint256 _fee, string memory _label) internal {
    uint256 pricedGas = _pricedGas(_submit(_callData), _fee);
    Vm.Gas memory g = vm.lastCallGas();
    uint256 refund = uint256(int256(g.gasRefunded));
    uint256 realCost = _lastCallCost(_callData);

    console2.log(_label);
    console2.log("  priced", pricedGas, "real cost (harness)", realCost);

    assertGt(pricedGas, 0, "the deposit subsidy must have quoted something to compare against");
    assertLe(refund, 44_600, "refund above what a pre-funded SIPA reclaims: the fixture is measuring the wrong thing");
    assertLe(pricedGas, realCost, "the deposit subsidy prices more gas than the sweep really costs");
  }
}
