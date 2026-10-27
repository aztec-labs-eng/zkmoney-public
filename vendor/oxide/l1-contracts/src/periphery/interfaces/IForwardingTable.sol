// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {SIPABase} from "@periphery/SIPABase.sol";

interface IForwardingTable {
  struct IntentFees {
    SIPABase.Intent intent;
    uint128 beneficiaryFee;
    uint128 sweepTip;
  }

  struct InitialRow {
    address token;
    IOxidePortal portal;
    IntentFees[] intents;
  }

  struct ConstructorArgs {
    address owner;
    uint256 rollupVersion;
    address beneficiary;
    InitialRow[] rows;
  }

  event RowAdded(address indexed token, address indexed portal, IntentFees[] intents);

  event IntentsAdded(address indexed token, IntentFees[] intents);

  event BeneficiaryUpdated(address indexed previous, address indexed current);

  function ROLLUP_VERSION() external view returns (uint256);

  function $beneficiary() external view returns (address);

  function rowFor(address _token, SIPABase.Intent _intent)
    external
    view
    returns (IOxidePortal portal, address beneficiary, uint128 beneficiaryFee, uint128 sweepTip);

  function addRow(address _token, IOxidePortal _portal, IntentFees[] calldata _intents) external;

  function addIntents(address _token, IntentFees[] calldata _intents) external;

  function setBeneficiary(address _beneficiary) external;
}
