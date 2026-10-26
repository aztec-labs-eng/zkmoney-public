// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface IAccountMetadataController {
  function metadataStateHash(address owner) external view returns (bytes32);
}
