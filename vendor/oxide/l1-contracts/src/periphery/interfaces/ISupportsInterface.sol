// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface ISupportsInterface {
  function supportsInterface(bytes4 interfaceID) external pure returns (bool);
}
