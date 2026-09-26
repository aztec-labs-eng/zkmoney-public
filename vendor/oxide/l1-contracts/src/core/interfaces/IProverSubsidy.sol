// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;

interface IProverSubsidy {
  function quoteSubsidy(uint256 _numClaims) external view returns (uint256);

  function paySubsidy(uint256 _numClaims, address _to) external returns (uint256 subsidy);
}
