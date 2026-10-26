// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface IPortalFactory {
  // solhint-disable-next-line oxide/no-comments
  /**
   * @notice The L2 token of the portal being deployed, read by the portal's constructor. It is not a constructor
   * argument, because the L2 token's address commits to the portal's address. It is zero outside a deployment.
   */
  function pendingL2Token() external view returns (bytes32);
}
