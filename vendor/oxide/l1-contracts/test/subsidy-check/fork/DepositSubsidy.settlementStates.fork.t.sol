// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Intents} from "@periphery/Intent.sol";
import {DAI} from "@periphery/ThreePoolLib.sol";
import {DepositSubsidySettlementsFixture} from "@test/subsidy-check/fork/DepositSubsidySettlementsFixture.sol";

/// forge-config: default.isolate = true
contract DepositSubsidySettlementStatesForkTest is DepositSubsidySettlementsFixture {
  string internal constant DAI_FIRST_SWEEP = "daiDepositFirstSweep";
  string internal constant SMALL_CREDIT = "daiDepositFirstSweepOfASmallCredit";

  function setUp() public override {
    super.setUp();
    deal(address(DAI), address(operationExecutor), 1);
  }

  function _stageRows() internal override {
    _stageRow(DAI_FIRST_SWEEP);
    _stageRow("susdsDepositResweep");
    _stageDeposit(SMALL_CREDIT, "dai.first.small", daiSubsidy, DAI, 0.5 ether, false, false);
  }

  function _warmTheConfigLikeTheCapChange() internal {
    (, uint128 cap,) = daiSubsidy.$depositConfig();
    _setCap(cap);
  }

  function _setCap(uint256 _cap) internal {
    (uint128 profit,, uint128 minCredit) = daiSubsidy.$depositConfig();
    vm.prank(OWNER);
    daiSubsidy.setDepositConfig(profit, uint128(_cap), minCredit);
  }

  function test_GivenACreditBelowTheMinimum_ThenTheSubsidyPaysNothingAndTheRelayerDefers() external {
    (, Settlement memory s) = _settle(SMALL_CREDIT, gasRelayer);
    assertEq(s.simulatedPayout, s.fee, "a sweep below the minimum credit got a subsidy");
    assertFalse(s.sent, "the relayer sends a sweep that the fee does not pay for");
  }

  function test_GivenAnIntentWithACeilingOfZero_ThenTheSubsidyPaysNothingAndTheRelayerDefers() external {
    vm.prank(OWNER);
    daiSubsidy.setSweepGasCeiling(Intents.DEPOSIT, 0);
    (, Settlement memory s) = _settle(DAI_FIRST_SWEEP, gasRelayer);
    assertEq(s.simulatedPayout, s.fee, "an intent with a ceiling of 0 got a subsidy");
    assertFalse(s.sent, "the relayer sends a sweep that the fee does not pay for");
  }

  function test_GivenACapOneTokenWeiBelowTheRelayersCost_ThenTheRelayerDefers() external {
    _warmTheConfigLikeTheCapChange();
    (, Settlement memory measured) = _quote(DAI_FIRST_SWEEP, gasRelayer);
    _setCap(measured.quoted - measured.fee - 1);
    (, Settlement memory s) = _settle(DAI_FIRST_SWEEP, gasRelayer);
    assertEq(s.quoted, measured.quoted, "the cap changed the relay's gas");
    assertEq(s.simulatedPayout, s.quoted - 1, "the cap does not bind the payout");
    assertFalse(s.sent, "the relayer sends a relay that the capped payout does not pay for");
  }

  function test_GivenACapAtTheRelayersCost_ThenTheRelayerSendsAndTheExecutorAccepts() external {
    _warmTheConfigLikeTheCapChange();
    (, Settlement memory measured) = _quote(DAI_FIRST_SWEEP, gasRelayer);
    _setCap(measured.quoted - measured.fee);
    (, Settlement memory s) = _settle(DAI_FIRST_SWEEP, gasRelayer);
    assertEq(s.quoted, measured.quoted, "the cap changed the relay's gas");
    assertEq(s.simulatedPayout, s.quoted, "the cap does not bind the payout at the relayer's cost");
    assertTrue(s.sent, "the relayer defers a relay that the capped payout pays for");
  }

  function test_GivenAnEmptyPot_ThenTheRelayerDefersUntilThePotIsFunded() external {
    uint256 pot = DAI.balanceOf(address(daiSubsidy));
    vm.prank(OWNER);
    daiSubsidy.defund();
    (, Settlement memory empty) = _quote(DAI_FIRST_SWEEP, gasRelayer);
    assertEq(empty.simulatedPayout, empty.fee, "an empty pot paid a subsidy");
    assertLt(empty.simulatedPayout, empty.quoted, "the fee alone pays for the relay, so the pot does not matter");
    deal(address(DAI), address(daiSubsidy), pot);
    (, Settlement memory funded) = _settle(DAI_FIRST_SWEEP, gasRelayer);
    assertTrue(funded.sent, "the relayer defers the relay after the pot is funded");
  }

  function test_GivenAPartlyFundedPot_ThenTheSubsidyIsThePot() external {
    deal(address(DAI), address(daiSubsidy), 1 ether);
    (, Settlement memory s) = _quote(DAI_FIRST_SWEEP, gasRelayer);
    assertEq(s.simulatedPayout, s.fee + 1 ether, "a partly funded pot does not pay its balance");
  }

  function test_GivenTheSusdsResweepWhereItsSubsidyTurnsOff_ThenTheFeeAlonePaysWithNoTransfer() external {
    vm.fee(0.1 gwei);
    vm.txGasPrice(0.15 gwei);
    vm.expectCall(address(SUSDS), abi.encodeCall(IERC20.transfer, (address(operationExecutor), 0)), 0);
    (, Settlement memory s) = _settle("susdsDepositResweep", gasRelayer);
    assertEq(s.simulatedPayout, s.fee, "the subsidy pays at a gas price where the fee covers the target");
    assertTrue(s.sent, "the relayer defers a relay that the fee alone pays for");
  }

  function test_GivenADustyExecutor_ThenARelayerThatHoldsTheTokenGainsNothing() external {
    (int256 gain, uint256 paid) = _farmingGain(DAI_FIRST_SWEEP);
    assertGt(paid, 0, "the farmer's relay got no subsidy, so the check tests nothing");
    assertLe(gain, 0, "a relayer that holds the token gains from its own sweep through a dusty executor");
  }
}
