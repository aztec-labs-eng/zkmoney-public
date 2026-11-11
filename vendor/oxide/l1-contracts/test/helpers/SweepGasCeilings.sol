// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {Intents} from "@periphery/Intent.sol";

uint256 constant SWEEP_GAS_DEPOSIT_CEILING = 290_000;
uint256 constant SWEEP_GAS_REGISTRATION_CEILING = 810_000;
uint256 constant SWEEP_GAS_ADD_PASSKEY_CEILING = 820_000;

library SweepGasCeilings {
  function initial() internal pure returns (DepositSubsidy.SweepGasCeiling[] memory ceilings) {
    ceilings = new DepositSubsidy.SweepGasCeiling[](3);
    ceilings[0] = DepositSubsidy.SweepGasCeiling({intent: Intents.DEPOSIT, gas: SWEEP_GAS_DEPOSIT_CEILING});
    ceilings[1] = DepositSubsidy.SweepGasCeiling({intent: Intents.REGISTRATION, gas: SWEEP_GAS_REGISTRATION_CEILING});
    ceilings[2] = DepositSubsidy.SweepGasCeiling({intent: Intents.ADD_PASSKEY, gas: SWEEP_GAS_ADD_PASSKEY_CEILING});
  }
}
