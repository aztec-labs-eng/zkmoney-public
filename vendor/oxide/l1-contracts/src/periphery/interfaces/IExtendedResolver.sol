// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface IExtendedResolver {
  function resolve(bytes memory name, bytes memory data) external view returns (bytes memory);
}
