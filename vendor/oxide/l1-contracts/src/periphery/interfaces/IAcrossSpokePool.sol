// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

// solhint-disable-next-line oxide/no-comments
// Across SpokePool that takes a deposit on this chain so that an Across relayer fills it on the destination chain.
interface IAcrossSpokePool {
  event FundsDeposited(
    bytes32 inputToken,
    bytes32 outputToken,
    uint256 inputAmount,
    uint256 outputAmount,
    uint256 indexed destinationChainId,
    uint256 indexed depositId,
    uint32 quoteTimestamp,
    uint32 fillDeadline,
    uint32 exclusivityDeadline,
    bytes32 indexed depositor,
    bytes32 recipient,
    bytes32 exclusiveRelayer,
    bytes message
  );

  function depositV3Now(
    address _depositor,
    address _recipient,
    address _inputToken,
    address _outputToken,
    uint256 _inputAmount,
    uint256 _outputAmount,
    uint256 _destinationChainId,
    address _exclusiveRelayer,
    uint32 _fillDeadlineOffset,
    uint32 _exclusivityParameter,
    bytes calldata _message
  ) external payable;
}
