// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";

import {OxideConstants} from "@generated/OxideConstants.gen.sol";

import {RelayedExit} from "@test/periphery/RelayedExit.sol";

contract PlainWithdrawalSubsidyRelayedExitTest is RelayedExit {
  uint256 internal constant EXIT_PRICING_TOLERANCE = 2000;
  uint256 internal constant BUSY_CHECKPOINT_PATH_DEPTH = 12;

  function test_GivenAWithdrawalAtTheShallowestPath_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayWithdrawalAtDepth(RELAYED_WITHDRAWAL_PATH_DEPTH);
    _assertStillShortOfItsGas("withdrawal, shallowest path", txGas + HARNESS_TO_CHAIN_WITHDRAWAL_RELAY, priced);
  }

  function test_GivenAWithdrawalFromABusyCheckpoint_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 txGas, uint256 priced) = _relayWithdrawalAtDepth(BUSY_CHECKPOINT_PATH_DEPTH);
    _assertStillShortOfItsGas("withdrawal, busy checkpoint", txGas + HARNESS_TO_CHAIN_WITHDRAWAL_RELAY, priced);
  }

  function test_GivenAOneNoteFrozenNotesRefund_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 chainGas, uint256 priced) = _relayFrozenNotesRefund(1);
    _assertStillShortOfItsGas("frozen notes refund, one note", chainGas, priced);
  }

  function test_GivenAFrozenNotesRefundOfTheMostNotes_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 chainGas, uint256 priced) = _relayFrozenNotesRefund(OxideConstants.MAX_FROZEN_NOTES_PER_REFUND);
    _assertStillShortOfItsGas("frozen notes refund, most notes", chainGas, priced);
  }

  function test_GivenAFrozenDepositsRefund_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 chainGas, uint256 priced) = _relayFrozenDepositsRefund();
    _assertStillShortOfItsGas("frozen deposit refund", chainGas, priced);
  }

  function test_GivenAnUnprocessedDepositRefund_ThenTheSubsidyPaysItsGas() external givenTeeIsRegistered("tee") {
    (uint256 chainGas, uint256 priced) = _relayUnprocessedDepositRefund();
    _assertStillShortOfItsGas("unprocessed deposit refund", chainGas, priced);
  }

  function _assertStillShortOfItsGas(string memory _label, uint256 _chainGas, uint256 _priced) internal pure {
    console2.log(_label, "chain gas", _chainGas);
    console2.log(_label, "priced", _priced);
    assertLt(
      _priced + EXIT_PRICING_TOLERANCE, _chainGas, "the subsidy now pays this exit's gas, so assert that it pays it"
    );
  }
}
