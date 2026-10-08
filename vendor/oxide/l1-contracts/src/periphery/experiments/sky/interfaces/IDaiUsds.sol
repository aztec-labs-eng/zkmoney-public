// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface IDaiUsds {
  // solhint-disable oxide/no-comments
  // Sky's DAI-USDS converter changes DAI to USDS, and USDS to DAI, one to one with no fee. So `wad` is both the
  // amount that goes in and the amount that comes out.
  // solhint-enable oxide/no-comments

  function daiToUsds(address usr, uint256 wad) external;

  function usdsToDai(address usr, uint256 wad) external;
}
