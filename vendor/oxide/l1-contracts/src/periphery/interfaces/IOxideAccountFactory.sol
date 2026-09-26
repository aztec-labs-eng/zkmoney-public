// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface IOxideAccountFactory {
  function deploy(address bootstrap) external returns (address account);

  function predictAccountAddress(address bootstrap) external view returns (address);
}
