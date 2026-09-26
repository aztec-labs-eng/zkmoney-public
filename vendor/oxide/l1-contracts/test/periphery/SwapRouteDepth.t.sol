// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {OxideConstants} from "@generated/OxideConstants.gen.sol";

contract SwapRouteDepthTest is Test {
  function test_TxAmountCapMatchesMeasuredMargin() external pure {
    assertEq(
      OxideConstants.TX_AMOUNT_CAP,
      2583e18,
      "TX_AMOUNT_CAP changed: re-measure the sandwich margin against live pool depth and update this constant"
    );
  }
}
