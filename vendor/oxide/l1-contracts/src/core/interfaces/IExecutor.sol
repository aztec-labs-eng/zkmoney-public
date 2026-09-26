// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface IExecutor {
  // solhint-disable oxide/no-comments
  // We pass the information of what kind of flow triggerred the execution into the Executor contract as it's needed
  // for subsidies.
  // solhint-enable oxide/no-comments
  enum Flow {
    Withdrawal,
    FrozenNotesRefund,
    FrozenDepositRefund,
    UnprocessedDepositRefund
  }

  function execute(Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload) external;
}
