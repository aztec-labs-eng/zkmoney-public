// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {SweepGasCeilings} from "@test/helpers/SweepGasCeilings.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {GasBurningSIPA} from "@test/subsidy-check/subsidies/GasBurningSIPA.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {DEPOSIT_SWEEP_TIP, ADD_PASSKEY_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {Intents} from "@periphery/Intent.sol";

contract DepositSubsidyIntentPricingTest is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;

  DepositSubsidy internal sm;
  MockV3Aggregator internal feed;
  GasBurningSIPA internal addPasskeyGasBurner;

  function setUp() public virtual override {
    super.setUp();
    feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(feed)),
      sipaFactory,
      SweepGasCeilings.initial()
    );
    underlying.mint(address(sm), 1_000_000 ether);
    underlying.mint(relayer, 1);

    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);
    addPasskeyGasBurner = new GasBurningSIPA(address(portal), ADD_PASSKEY_SWEEP_TIP, 1_000_000);
    vm.mockCall(
      address(sipaFactory),
      abi.encodeCall(SIPAFactory.sipaIntentOf, (address(addPasskeyGasBurner))),
      abi.encode(Intents.ADD_PASSKEY)
    );
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

  function _sweep(address _sipa, bytes memory _intentData, bytes memory _proofs) internal returns (uint256 subsidy) {
    (subsidy,) = RelayerTransaction.send(relayer, sm, _sweepCd(_sipa, address(underlying), _intentData, _proofs));
  }

  function _sweepCd(address _sipa, address _token, bytes memory _intentData, bytes memory _proofs)
    internal
    view
    returns (bytes memory)
  {
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy, (ISIPA(_sipa), _token, address(operationExecutor), _intentData, _proofs)
    );
  }

  function test_GivenAnAnswerThatWouldOverflowTheQuote_ThenTheSweepStillLands() external {
    uint128 cap = 1 ether;
    uint128 fee = uint128(DEPOSIT_SWEEP_TIP);
    vm.prank(OWNER);
    sm.setDepositConfig(fee, cap, 0);
    feed.setAnswer(1e60);

    DepositSIPA sipa = _depositSIPA(_depositIntent("absurd"));
    underlying.mint(address(sipa), DEPOSIT);
    uint256 portalBefore = underlying.balanceOf(address(portal));
    uint256 relayerBefore = underlying.balanceOf(relayer);

    uint256 subsidy = _sweep(address(sipa), _depositIntent("absurd"), "");

    assertEq(subsidy, cap, "a bad-but-valid answer is bounded by the max, not by an overflow");
    assertEq(underlying.balanceOf(address(portal)) - portalBefore, DEPOSIT - fee, "the deposit still bridged");
    assertEq(underlying.balanceOf(relayer) - relayerBefore, fee + cap, "the relayer got the fee and the capped payout");
    assertEq(underlying.balanceOf(address(sipa)), 0, "the SIPA was swept");
  }

  function test_GivenAnAddPasskeyCeilingOfZero_ThenAnAddPasskeySweepDrawsNothingWhileADepositSweepIsPaid() external {
    vm.prank(OWNER);
    sm.setSweepGasCeiling(Intents.ADD_PASSKEY, 0);
    (uint256 addPasskey,) =
      RelayerTransaction.send(relayer, sm, _sweepCd(address(addPasskeyGasBurner), address(underlying), "", ""));
    assertEq(addPasskey, 0, "an add-passkey sweep drew from the pot with a ceiling of 0");

    DepositSIPA sipa = _depositSIPA(_depositIntent("deposit"));
    underlying.mint(address(sipa), DEPOSIT);
    assertGt(
      _sweep(address(sipa), _depositIntent("deposit"), ""), 0, "a deposit sweep with its own ceiling drew nothing"
    );
  }
}
