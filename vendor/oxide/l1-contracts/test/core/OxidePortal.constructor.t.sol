// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";

contract OxidePortalConstructorTest is OxidePortalBase {
  function test_WhenDeployed_ThenStoresTheTeeRegistry() external view {
    assertEq(address(portal.TEE_REGISTRY()), address(teeRegistry));
  }

  function test_WhenDeployed_ThenReadsTheL2TokenFromItsDeployer() external view {
    assertEq(portal.L2_TOKEN(), L2_TOKEN);
  }
}
