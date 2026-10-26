// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Aztec Labs.
pragma solidity >=0.8.27;

// solhint-disable-next-line oxide/no-comments
// Maker's LitePSM and the USDS PSM wrapper: a 1:1 swap between a stablecoin and its gem (USDC), with a fee in WAD.
interface IMakerPsm {
  // solhint-disable-next-line oxide/no-comments
  // The stablecoin the PSM pulls on buyGem: DAI on the LitePSM, USDS on the USDS wrapper.
  function dai() external view returns (address);

  // solhint-disable-next-line oxide/no-comments
  // The fee on buyGem as a WAD fraction of the gem amount.
  function tout() external view returns (uint256);

  // solhint-disable-next-line oxide/no-comments
  // Scales a gem amount to the stablecoin's decimals, so a caller can price a trade before it calls buyGem.
  function to18ConversionFactor() external view returns (uint256);

  // solhint-disable-next-line oxide/no-comments
  // Buys `_gemAmt` gem for `_usr` with stablecoin pulled from the caller, at 1:1 plus the tout fee.
  function buyGem(address _usr, uint256 _gemAmt) external returns (uint256);
}
