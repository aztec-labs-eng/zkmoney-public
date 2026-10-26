// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";

import {GasBurningSIPA} from "@test/periphery/GasBurningSIPA.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {DEPOSIT_SWEEP_TIP, REGISTRATION_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";

contract DepositSubsidyFarmSafetyTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;
  DepositSubsidy internal fm;

  DepositSIPA internal warmSipa;
  SIPABase internal registrationSipa;
  bytes internal registrationData;

  function setUp() public virtual override {
    super.setUp();
    MockV3Aggregator feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    fm = new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(feed)),
      sipaFactory
    );
    underlying.mint(address(fm), 1_000_000 ether);
    underlying.mint(relayer, 1);

    vm.prank(OWNER);
    fm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);

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
        address(depositSIPAImplementation),
        keccak256(_intent),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true,
        forwardingTable
      )
    );
  }

  function test_GivenRevertedSweep_ThenNothingIsPaidOut() external {
    bytes memory intent = _depositIntent("reverting");
    DepositSIPA sipa = _depositSIPA(intent);
    underlying.mint(address(sipa), DEPOSIT_SWEEP_TIP - 1);
    uint256 budgetBefore = underlying.balanceOf(address(fm));
    uint256 relayerBefore = underlying.balanceOf(relayer);
    bytes memory outer = abi.encodeCall(
      OperationExecutor.execute,
      (address(fm), _sweepCalldata(address(sipa), intent, ""), IERC20(address(underlying)), 0, 0, 0)
    );

    vm.prank(relayer, relayer);
    (bool ok,) = address(operationExecutor).call(outer);

    assertFalse(ok, "the below-fee sweep must fail");
    assertEq(underlying.balanceOf(address(fm)), budgetBefore, "a failed sweep must draw nothing");
    assertEq(underlying.balanceOf(relayer), relayerBefore, "a failed sweep must pay nothing");
  }

  function test_GivenARegistration_ThenItIsPricedAboveAnyDepositSweep() external {
    bytes memory consent = _consentSig(bootstrapKey, registrationData);
    DomainAuth memory auth = _domainAuth(NAME_HASH, defaultOwner, nextNonce++, block.timestamp + 1 days);

    uint256 priced = _pricedGas(
      _submit(_sweepCalldata(address(registrationSipa), registrationData, _regProofs(consent, auth, _noTerms()))),
      REGISTRATION_SWEEP_TIP
    );
    console2.log("registration priced gas", priced);

    assertGt(
      priced, fm.SWEEP_GAS_DEPOSIT_CEILING(), "a registration must price above everything the deposit ceiling can pay"
    );
    assertLe(
      priced, fm.SWEEP_GAS_REGISTRATION_CEILING(), "a registration priced past its own ceiling: the cap is not binding"
    );
  }

  function test_GivenADirectCall_ThenTheSweepLandsAndThePotIsUntouched() external {
    uint256 budgetBefore = underlying.balanceOf(address(fm));
    uint256 relayerBefore = underlying.balanceOf(relayer);

    vm.prank(relayer, relayer);
    uint256 subsidy =
      fm.sweepForSubsidy(ISIPA(address(warmSipa)), address(underlying), relayer, _depositIntent("warm"), "");

    assertEq(subsidy, 0, "a direct call is not a relayer transaction, so it is paid no subsidy");
    assertEq(underlying.balanceOf(address(warmSipa)), 0, "the direct sweep must still land");
    assertEq(underlying.balanceOf(relayer) - relayerBefore, DEPOSIT_SWEEP_TIP, "the direct caller must get the fee");
    assertEq(underlying.balanceOf(address(fm)), budgetBefore, "the pot must be untouched");
  }

  function test_GivenPaddingUnderTheCeiling_ThenItEarnsTheFarmerNothing() external {
    vm.mockCall(address(sipaFactory), abi.encodeWithSelector(SIPAFactory.sipaIntentOf.selector), abi.encode(1));

    _burnSweep(new GasBurningSIPA(address(portal), DEPOSIT_SWEEP_TIP, 60_000));
    (uint256 leanSubsidy, uint256 leanGas) = _burnSweep(new GasBurningSIPA(address(portal), DEPOSIT_SWEEP_TIP, 60_000));
    (uint256 paddedSubsidy, uint256 paddedGas) =
      _burnSweep(new GasBurningSIPA(address(portal), DEPOSIT_SWEEP_TIP, 120_000));

    uint256 pricedDelta = _pricedGas(paddedSubsidy, DEPOSIT_SWEEP_TIP) - _pricedGas(leanSubsidy, DEPOSIT_SWEEP_TIP);
    uint256 burntDelta = paddedGas - leanGas;

    console2.log("lean", leanGas, "padded", paddedGas);
    console2.log("padding priced at", pricedDelta, "padding burnt", burntDelta);
    assertGt(paddedSubsidy, leanSubsidy, "under the ceiling the meter must still be moving");
    assertLe(pricedDelta, burntDelta, "padding is paid more gas than it burns: the farmer nets the difference");
  }

  function test_GivenTwoSweepsPastTheCeiling_ThenTheyDrawTheSamePayout() external {
    uint128 fee = uint128(DEPOSIT_SWEEP_TIP);
    vm.mockCall(address(sipaFactory), abi.encodeWithSelector(SIPAFactory.sipaIntentOf.selector), abi.encode(1));
    vm.fee(2 gwei);
    vm.txGasPrice(2 gwei);
    vm.prank(OWNER);
    fm.setDepositConfig(fee, type(uint128).max, 0);

    GasBurningSIPA lean = new GasBurningSIPA(address(portal), DEPOSIT_SWEEP_TIP, 400_000);
    GasBurningSIPA padded = new GasBurningSIPA(address(portal), DEPOSIT_SWEEP_TIP, 700_000);

    (uint256 leanSubsidy, uint256 leanGas) = _burnSweep(lean);
    (uint256 paddedSubsidy, uint256 paddedGas) = _burnSweep(padded);

    console2.log("lean", leanGas, "padded", paddedGas);
    assertGt(paddedGas, leanGas, "the padded sweep must really have burnt more");
    assertEq(paddedSubsidy, leanSubsidy, "burning past the ceiling must not move the payout");
  }

  function _burnSweep(GasBurningSIPA _sipa) internal returns (uint256 subsidy, uint256 gasUsed) {
    (subsidy, gasUsed) = RelayerTransaction.send(
      relayer,
      fm,
      abi.encodeCall(
        DepositSubsidy.sweepForSubsidy, (ISIPA(address(_sipa)), address(underlying), address(operationExecutor), "", "")
      )
    );
  }

  function _sweepCalldata(address _sipa, bytes memory _intentData, bytes memory _proofs)
    internal
    view
    returns (bytes memory)
  {
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy,
      (ISIPA(_sipa), address(underlying), address(operationExecutor), _intentData, _proofs)
    );
  }

  function _submit(bytes memory _callData) internal returns (uint256 subsidy) {
    (subsidy,) = RelayerTransaction.send(relayer, fm, _callData);
  }
}
