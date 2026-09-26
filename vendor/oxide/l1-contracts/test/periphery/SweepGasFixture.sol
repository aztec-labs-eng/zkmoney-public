// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Vm} from "forge-std/Vm.sol";

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Inbox} from "@aztec/core/messagebridge/Inbox.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {Constants} from "@aztec/core/libraries/ConstantsGen.sol";

import {DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";

import {RegistrationTestBase} from "@test/periphery/registration/RegistrationTestBase.sol";

abstract contract SweepGasFixture is RegistrationTestBase {
  uint256 internal constant HARNESS_TO_CHAIN = 99_827;

  function _setupInbox() internal override {
    Inbox realInbox =
      new Inbox(address(rollup), IERC20(address(underlying)), ROLLUP_VERSION, Constants.L1_TO_L2_MSG_SUBTREE_HEIGHT, 2);
    wiredInbox = IInbox(address(realInbox));
  }

  function _field(bytes32 _word) internal pure returns (bytes32) {
    return bytes32(uint256(_word) % Constants.MAX_FIELD_VALUE);
  }

  function _calldataGas(bytes memory _data) internal pure returns (uint256 total) {
    for (uint256 i = 0; i < _data.length; i++) {
      total += _data[i] == 0 ? 4 : 16;
    }
  }

  function _lastCallCost(bytes memory _callData) internal returns (uint256) {
    Vm.Gas memory g = vm.lastCallGas();
    uint256 burnt = uint256(g.gasTotalUsed);
    uint256 refund = uint256(int256(g.gasRefunded));
    return _calldataGas(_callData) + burnt - (refund < burnt / 5 ? refund : burnt / 5);
  }

  function _lastCallChainCost(bytes memory _callData) internal returns (uint256) {
    return _lastCallCost(_callData) + HARNESS_TO_CHAIN;
  }

  uint256 internal constant PRICED_UNIT_FEE = 4e9;
  uint256 internal constant PRICED_BASEFEE = PRICED_UNIT_FEE;
  int256 internal constant PRICED_FEED_ANSWER = 2500e8;
  uint128 internal constant PRICED_MIN_PROFIT = uint128(DEPOSIT_FEE);

  function _pricedGas(uint256 _quote, uint256 _fee) internal pure returns (uint256) {
    require(_quote > 0, "quote clamped to zero: it carries no gas figure to read back");
    return (_quote + _fee - PRICED_MIN_PROFIT) / 1e13;
  }
}
