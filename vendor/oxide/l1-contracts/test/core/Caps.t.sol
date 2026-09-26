// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";
import {Caps} from "@core/Caps.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Errors} from "@core/lib/Errors.sol";

contract CapsHarness is Caps {
  constructor(uint256 _rate, uint256 _globalLimit) Caps(_rate, _globalLimit) {}

  function markUsage(uint256 _amount) external {
    _markUsage(_amount);
  }
}

contract CapsTest is Test {
  CapsHarness internal caps;
  CapsHarness internal prodCaps;

  uint256 internal constant RATE = 1 ether;
  uint256 internal constant GLOBAL_LIMIT = 10_000 ether;

  uint256 internal constant PROD_RATE = uint256(50_000 ether) / 86_400;
  uint256 internal constant PROD_GLOBAL_LIMIT = 50_000 ether;

  function setUp() public {
    caps = new CapsHarness(RATE, GLOBAL_LIMIT);
    prodCaps = new CapsHarness(PROD_RATE, PROD_GLOBAL_LIMIT);
  }

  function _drain(CapsHarness _caps) internal {
    uint256 limit = _caps.GLOBAL_LIMIT();
    uint256 drained;
    while (drained + OxideConstants.TX_AMOUNT_CAP <= limit) {
      _caps.markUsage(OxideConstants.TX_AMOUNT_CAP);
      drained += OxideConstants.TX_AMOUNT_CAP;
    }
    uint256 remaining = limit - drained;
    if (remaining > 0) {
      _caps.markUsage(remaining);
    }
  }

  function test_startsAtGlobalLimit() public view {
    assertEq(caps.getCurrentAvailable(), GLOBAL_LIMIT);
  }

  function test_markUsage_decreasesAvailable() public {
    caps.markUsage(50 ether);
    assertEq(caps.getCurrentAvailable(), GLOBAL_LIMIT - 50 ether);
  }

  function test_markUsage_revertsWhenOverTxLimit() public {
    vm.expectRevert(Errors.Caps__TxLimitSurpassed.selector);
    caps.markUsage(OxideConstants.TX_AMOUNT_CAP + 1);
  }

  function test_markUsage_revertsWhenOverGlobalLimit() public {
    _drain(caps);
    vm.expectRevert(Errors.Caps__GlobalLimitSurpassed.selector);
    caps.markUsage(1);
  }

  function test_rateAccrual_capsAtGlobalLimit() public {
    caps.markUsage(OxideConstants.TX_AMOUNT_CAP);
    uint256 afterUse = caps.getCurrentAvailable();
    assertEq(afterUse, GLOBAL_LIMIT - OxideConstants.TX_AMOUNT_CAP);

    vm.warp(block.timestamp + 10);
    assertEq(caps.getCurrentAvailable(), GLOBAL_LIMIT - OxideConstants.TX_AMOUNT_CAP + 10 * RATE);

    vm.warp(block.timestamp + 1_000_000);
    assertEq(caps.getCurrentAvailable(), GLOBAL_LIMIT);
  }

  function test_prodValues_startsAtGlobalLimit() public view {
    assertEq(prodCaps.getCurrentAvailable(), PROD_GLOBAL_LIMIT);
  }

  function test_prodValues_drainsAndRevertsWhenEmpty() public {
    _drain(prodCaps);
    assertEq(prodCaps.getCurrentAvailable(), 0);
    vm.expectRevert(Errors.Caps__GlobalLimitSurpassed.selector);
    prodCaps.markUsage(1);
  }

  function test_prodValues_refillsOverOneDay() public {
    _drain(prodCaps);
    vm.warp(block.timestamp + 1 days);
    uint256 available = prodCaps.getCurrentAvailable();
    assertEq(available, 86_400 * PROD_RATE);
    assertLt(available, PROD_GLOBAL_LIMIT);
    assertGt(available, PROD_GLOBAL_LIMIT - 0.001 ether);
  }

  function test_prodValues_capsAtGlobalLimit() public {
    _drain(prodCaps);
    vm.warp(block.timestamp + 2 days);
    assertEq(prodCaps.getCurrentAvailable(), PROD_GLOBAL_LIMIT);
  }
}
