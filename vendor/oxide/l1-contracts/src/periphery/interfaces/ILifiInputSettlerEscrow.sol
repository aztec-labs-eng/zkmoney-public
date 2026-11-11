// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

struct MandateOutput {
  bytes32 oracle;
  bytes32 settler;
  uint256 chainId;
  bytes32 token;
  uint256 amount;
  bytes32 recipient;
  bytes callbackData;
  bytes context;
}

struct StandardOrder {
  address user;
  uint256 nonce;
  uint256 originChainId;
  uint32 expires;
  uint32 fillDeadline;
  address inputOracle;
  uint256[2][] inputs;
  MandateOutput[] outputs;
}

interface ILifiInputSettlerEscrow {
  // solhint-disable-next-line oxide/no-comments
  // Opens the order and pulls its inputs from the caller with transferFrom, so the caller must approve them first.
  function open(StandardOrder calldata order) external;
}
