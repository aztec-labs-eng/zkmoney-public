// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";

contract DepositSIPASweepGasTest is OxidePortalBase {
  uint256 internal constant SWEEP_AMOUNT = 100 ether;

  uint256 internal constant STEADY_SWEEP_GAS = 111_321;
  uint256 internal constant TOLERANCE = 1500;

  DepositSIPA internal sipa;
  address internal relayer = makeAddr("relayer");

  function _depositIntent() internal pure returns (bytes memory) {
    return abi.encode(keccak256("recipient"));
  }

  function setUp() public override {
    super.setUp();
    _initialize();

    sipa = DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(_depositIntent()),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true
      )
    );
    underlying.mint(address(sipa), SWEEP_AMOUNT);
  }

  function test_SteadyStateSweepGas() external {
    _sweep();
    uint256 a = _sweep();
    uint256 b = _sweep();

    console2.log("deposit sweep gas", a, b);
    assertApproxEqAbs(a, b, 200, "re-sweep gas not steady");
    assertApproxEqAbs(a, STEADY_SWEEP_GAS, TOLERANCE, "deposit sweep gas moved");
  }

  function _sweep() internal returns (uint256) {
    underlying.mint(address(sipa), SWEEP_AMOUNT);
    sipa.sweep(address(underlying), relayer, _depositIntent(), "");
    Vm.Gas memory g = vm.lastCallGas();
    return uint256(int256(uint256(g.gasTotalUsed)) - int256(g.gasRefunded));
  }
}
