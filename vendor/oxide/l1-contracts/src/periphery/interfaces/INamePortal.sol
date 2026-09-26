// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface INamePortal {
  function notify(address user, bytes32 l2Recipient, uint256 rollupVersion)
    external
    returns (bytes32 key, uint256 index);
}
