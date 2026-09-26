// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

struct DomainAuth {
  uint256 nonce;
  uint256 deadline;
  bytes signature;
}

interface INameRegistry {
  function registrationController() external view returns (address);
  function accountMetadataRegistry() external view returns (address);
  function resolver() external view returns (address);
  function domainOwner() external view returns (address);

  function ownerOf(bytes32 nameHash) external view returns (address);
  function nameOf(address owner) external view returns (bytes32);

  function claimName(bytes32 nameHash, address owner, DomainAuth calldata domainAuth) external;

  function changeName(address owner, bytes32 newNameHash, DomainAuth calldata domainAuth) external;
}
