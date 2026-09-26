// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

struct SignedTerms {
  uint256 fee;
  uint256 minDeposit;
  uint256 nonce;
  uint256 deadline;
  bytes signature;
}

struct R1Install {
  bytes32 qx;
  bytes32 qy;
  bytes metadata;
  bytes signature;
}

interface IRegistrationController {
  function SIPA_FACTORY() external view returns (address);

  function register(address token, uint256 balance, bytes calldata registrationData, bytes calldata proofs) external;
}
