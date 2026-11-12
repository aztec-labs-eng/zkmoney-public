// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SweepGasCeilings} from "@test/helpers/SweepGasCeilings.sol";

import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";

import {GasBurningSIPA} from "@test/subsidy-check/subsidies/GasBurningSIPA.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {DEPOSIT_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {Intent, Intents} from "@periphery/Intent.sol";

contract BurningSIPAFactory {
  address internal immutable PORTAL;
  uint256 internal immutable FEE;
  uint256 internal immutable BURN;

  constructor(address _portal, uint256 _fee, uint256 _burn) {
    PORTAL = _portal;
    FEE = _fee;
    BURN = _burn;
  }

  function implementationFor(Intent) external view returns (address) {
    return address(this);
  }

  function approvedTable(address) external pure returns (bool) {
    return true;
  }

  function sipaIntentOf(address) external pure virtual returns (Intent) {
    return Intents.DEPOSIT;
  }

  function predictSIPA(address, bytes32, bytes32, uint256, bool, address) public view returns (address) {
    bytes32 initCodeHash = keccak256(abi.encodePacked(type(GasBurningSIPA).creationCode, abi.encode(PORTAL, FEE, BURN)));
    return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(0), initCodeHash)))));
  }

  function deploySIPA(address, bytes32, bytes32, uint256, bool, address) public virtual returns (address) {
    return address(new GasBurningSIPA{salt: bytes32(0)}(PORTAL, FEE, BURN));
  }
}

contract DepositSubsidyDeployAndSweepTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;
  uint256 internal constant CEILING_BOUND_BURN = 1_000_000;

  DepositSubsidy internal sm;
  MockV3Aggregator internal feed;

  function setUp() public virtual override {
    super.setUp();
    feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = _newSubsidy(address(portal), sipaFactory);
    underlying.mint(relayer, 1);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
  }

  function test_GivenACeilingBoundSIPAAlreadyDeployed_WhenDeployAndSweep_ThenItGetsNoDeployAllowance() external {
    (DepositSubsidy burner, BurningSIPAFactory factory) = _burningSubsidy();
    factory.deploySIPA(address(0), bytes32(0), bytes32(0), 0, true, address(0));

    uint256 subsidy = _deployAndSweepOn(burner, address(underlying));

    assertEq(
      _pricedGas(subsidy, DEPOSIT_SWEEP_TIP),
      burner.$sweepGasCeilings(Intents.DEPOSIT),
      "a sweep that deployed nothing must not draw the deploy allowance"
    );
  }

  function test_GivenAnUnknownToken_WhenDeployAndSweepDeploys_ThenNothingIsPriced() external {
    (DepositSubsidy burner, BurningSIPAFactory factory) = _burningSubsidy();
    address sipa = factory.predictSIPA(address(0), bytes32(0), bytes32(0), 0, true, address(0));

    uint256 subsidy = _deployAndSweepOn(burner, makeAddr("unknownToken"));

    assertGt(sipa.code.length, 0, "the call deployed the SIPA");
    assertEq(subsidy, 0, "the deploy allowance must not lift a zero ceiling");
  }

  function _newSubsidy(address _portal, SIPAFactory _factory) internal returns (DepositSubsidy subsidy) {
    subsidy = new DepositSubsidy(
      OWNER,
      _portal,
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(feed)),
      _factory,
      SweepGasCeilings.initial()
    );
    underlying.mint(address(subsidy), 1_000_000 ether);
    vm.prank(OWNER);
    subsidy.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
  }

  function _burningSubsidy() internal returns (DepositSubsidy subsidy, BurningSIPAFactory factory) {
    factory = new BurningSIPAFactory(address(portal), DEPOSIT_SWEEP_TIP, CEILING_BOUND_BURN);
    subsidy = _newSubsidy(address(portal), SIPAFactory(address(factory)));
  }

  function _deployAndSweepOn(DepositSubsidy _subsidy, address _token) internal returns (uint256 subsidy) {
    (subsidy,) = RelayerTransaction.send(
      relayer,
      _subsidy,
      abi.encodeCall(
        DepositSubsidy.deployAndSweepForSubsidy,
        (forwardingTable, Intents.DEPOSIT, bytes32(0), true, _token, address(operationExecutor), "", "")
      )
    );
  }
}
