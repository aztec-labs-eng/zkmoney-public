// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";

import {DepositSubsidyRelayFixture} from "@test/subsidy-check/subsidies/DepositSubsidyRelayFixture.sol";

contract DepositSubsidyExecutorPathTest is DepositSubsidyRelayFixture {
  function test_GivenZeroPaddedProofs_ThenThePaddingIsPricedAtWhatItCosts() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(payer, address(resweepSipa), _resweepCd(address(operationExecutor), new bytes(1024)));
    console2.log("resweep with 1 KiB of zero proofs: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }
}
