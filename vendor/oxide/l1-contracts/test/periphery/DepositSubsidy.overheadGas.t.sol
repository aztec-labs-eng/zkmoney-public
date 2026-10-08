// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {GasBurningSIPA} from "@test/periphery/GasBurningSIPA.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";

contract DepositSubsidyOverheadGasTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;
  uint128 internal constant OVERHEAD_GAS = 30_000;
  uint256 internal constant CEILING_BOUND_BURN = 1_000_000;

  DepositSubsidy internal sm;

  function setUp() public virtual override {
    super.setUp();
    MockV3Aggregator feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = new DepositSubsidy(OWNER, address(portal), AggregatorV3Interface(address(feed)), sipaFactory);
    underlying.mint(address(sm), 1_000_000 ether);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
    _configure(0, 0);
  }

  function test_GivenAnOverhead_WhenAMeteredSweepIsPriced_ThenItAddsExactlyTheOverhead() external {
    bytes memory intent = _depositIntent("metered");
    DepositSIPA sipa = _depositSIPA(intent);
    underlying.mint(address(sipa), DEPOSIT);

    uint256 snapshot = vm.snapshotState();
    _configure(0, 0);
    uint256 without = _pricedGas(_sweep(address(sipa), address(underlying), intent), DEPOSIT_FEE);
    vm.revertToState(snapshot);
    _configure(0, OVERHEAD_GAS);
    uint256 with = _pricedGas(_sweep(address(sipa), address(underlying), intent), DEPOSIT_FEE);

    assertEq(with, without + OVERHEAD_GAS, "the overhead must be added on top of the metered gas");
  }

  function test_GivenAnOverhead_WhenTheCeilingBinds_ThenTheOverheadIsAddedAfterTheClamp() external {
    _mockDepositIntent();
    _configure(0, OVERHEAD_GAS);

    uint256 priced = _pricedGas(_sweep(_burner(), address(underlying), ""), DEPOSIT_FEE);

    assertEq(priced, sm.SWEEP_GAS_DEPOSIT_CEILING() + OVERHEAD_GAS, "the ceiling must not clip the overhead");
  }

  function test_GivenAnOverhead_WhenTwoSweepsRunInOneTransaction_ThenEachOneGetsIt() external {
    _mockDepositIntent();
    _configure(0, OVERHEAD_GAS);
    address first = _burner();
    address second = _burner();

    uint256 firstPriced = _pricedGas(_sweep(first, address(underlying), ""), DEPOSIT_FEE);
    uint256 secondPriced = _pricedGas(_sweep(second, address(underlying), ""), DEPOSIT_FEE);

    assertEq(firstPriced, sm.SWEEP_GAS_DEPOSIT_CEILING() + OVERHEAD_GAS, "the first sweep gets the overhead");
    assertEq(secondPriced, sm.SWEEP_GAS_DEPOSIT_CEILING() + OVERHEAD_GAS, "the second sweep gets the overhead");
  }

  function test_GivenAZeroOverhead_WhenTheCeilingBinds_ThenThePriceIsTheCeiling() external {
    _mockDepositIntent();

    uint256 priced = _pricedGas(_sweep(_burner(), address(underlying), ""), DEPOSIT_FEE);

    assertEq(priced, sm.SWEEP_GAS_DEPOSIT_CEILING(), "a zero overhead must price the sweep as before");
  }

  function test_GivenAnOverhead_WhenTheTokenIsUnknown_ThenNothingIsPriced() external {
    _mockDepositIntent();
    _configure(0, OVERHEAD_GAS);

    uint256 subsidy = _sweep(_burner(), makeAddr("unknownToken"), "");

    assertEq(subsidy, 0, "the overhead must not lift a zero ceiling");
  }

  function test_GivenAnOverhead_WhenTheCreditIsBelowTheMinimum_ThenNothingIsPriced() external {
    _mockDepositIntent();
    _configure(1, OVERHEAD_GAS);

    uint256 subsidy = _sweep(_burner(), address(underlying), "");

    assertEq(subsidy, 0, "the overhead must not pay a sweep under the minimum credit");
  }

  function _configure(uint128 _minCreditedAmount, uint128 _overheadGas) internal {
    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, PRICED_MIN_PROFIT, _minCreditedAmount, _overheadGas);
  }

  function _mockDepositIntent() internal {
    vm.mockCall(
      address(sipaFactory),
      abi.encodeWithSelector(SIPAFactory.sipaIntentOf.selector),
      abi.encode(SIPABase.Intent.Deposit)
    );
  }

  function _burner() internal returns (address) {
    return address(new GasBurningSIPA(address(portal), DEPOSIT_FEE, CEILING_BOUND_BURN));
  }

  function _sweep(address _sipa, address _token, bytes memory _intentData) internal returns (uint256) {
    return sm.sweepForSubsidy(ISIPA(_sipa), _token, relayer, _intentData, "");
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
}
