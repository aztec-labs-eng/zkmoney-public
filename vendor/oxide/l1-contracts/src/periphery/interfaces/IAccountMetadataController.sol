// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

struct MetadataUpdateIntent {
  address owner;
  address metadataRegistry;
  bytes metadata;
  bytes32 expectedStateHash;
  uint256 rollupVersion;
  address namePortal;
  bytes32 namePortalRecipient;
  bytes32 recipientCommitment;
}

interface IAccountMetadataController {
  function updateUser(bytes calldata intentData, bytes calldata signature) external;
  function metadataStateHash(address owner) external view returns (bytes32);
  function metadataUpdateDigest(bytes calldata intentData, address sipa) external view returns (bytes32);
}
