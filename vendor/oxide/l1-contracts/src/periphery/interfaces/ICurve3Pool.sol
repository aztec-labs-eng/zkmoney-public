// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;

interface ICurve3Pool {
  function coins(uint256 _i) external view returns (address);

  function exchange(int128 _i, int128 _j, uint256 _dx, uint256 _minDy) external;
}
