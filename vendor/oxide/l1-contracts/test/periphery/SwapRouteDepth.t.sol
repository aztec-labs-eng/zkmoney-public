// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

contract SwapRouteDepthTest is Test {
  function test_ProdTxAmountCapMatchesMeasuredMargin() external {
    string memory seed = vm.readFile("../environments/deployments/seeds/sky-prod/bridges/susds-example.json");
    assertEq(
      vm.parseUint(vm.parseJsonString(seed, ".deployment.txAmountCap")),
      5166e18,
      "Prod txAmountCap changed: re-measure the sandwich margin against live pool depth and update this constant"
    );
  }
}
