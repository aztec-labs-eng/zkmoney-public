// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {ForwardingTable} from "@periphery/ForwardingTable.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {SIPABase} from "@periphery/SIPABase.sol";

uint128 constant DEPOSIT_SWEEP_TIP = 25e16;
uint128 constant REGISTRATION_SWEEP_TIP = 5e17;
uint128 constant USER_OP_SWEEP_TIP = 5e17;

library ForwardingTableFixture {
  function standardIntents() internal pure returns (IForwardingTable.IntentFees[] memory intents) {
    intents = new IForwardingTable.IntentFees[](3);
    intents[0] =
      IForwardingTable.IntentFees({intent: SIPABase.Intent.Deposit, beneficiaryFee: 0, sweepTip: DEPOSIT_SWEEP_TIP});
    intents[1] = IForwardingTable.IntentFees({
      intent: SIPABase.Intent.Registration, beneficiaryFee: 0, sweepTip: REGISTRATION_SWEEP_TIP
    });
    intents[2] =
      IForwardingTable.IntentFees({intent: SIPABase.Intent.UserOp, beneficiaryFee: 0, sweepTip: USER_OP_SWEEP_TIP});
  }

  function standardRows(IOxidePortal portal) internal view returns (IForwardingTable.InitialRow[] memory rows) {
    rows = new IForwardingTable.InitialRow[](1);
    rows[0] =
      IForwardingTable.InitialRow({token: address(portal.UNDERLYING()), portal: portal, intents: standardIntents()});
  }

  function args(address owner, uint256 rollupVersion, address beneficiary, IForwardingTable.InitialRow[] memory rows)
    internal
    pure
    returns (IForwardingTable.ConstructorArgs memory)
  {
    return IForwardingTable.ConstructorArgs({
      owner: owner, rollupVersion: rollupVersion, beneficiary: beneficiary, rows: rows
    });
  }

  function deploy(address owner, IOxidePortal portal, address beneficiary) internal returns (ForwardingTable) {
    return new ForwardingTable(args(owner, portal.ROLLUP_VERSION(), beneficiary, standardRows(portal)));
  }

  function deploy(address owner, IOxidePortal portal, address beneficiary, IForwardingTable.IntentFees[] memory intents)
    internal
    returns (ForwardingTable)
  {
    IForwardingTable.InitialRow[] memory rows = new IForwardingTable.InitialRow[](1);
    rows[0] = IForwardingTable.InitialRow({token: address(portal.UNDERLYING()), portal: portal, intents: intents});
    return new ForwardingTable(args(owner, portal.ROLLUP_VERSION(), beneficiary, rows));
  }
}
