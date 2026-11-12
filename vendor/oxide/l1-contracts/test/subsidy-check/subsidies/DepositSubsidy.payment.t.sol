// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Intents} from "@periphery/Intent.sol";
import {DepositSubsidyRelayFixture} from "@test/subsidy-check/subsidies/DepositSubsidyRelayFixture.sol";

contract DepositSubsidyPaymentTest is DepositSubsidyRelayFixture {
  function _relayAndExpectNoTransfer(address _sipa, bytes memory _inner) internal {
    uint256 potBefore = underlying.balanceOf(address(sm));
    vm.expectCall(address(underlying), abi.encodeCall(IERC20.transfer, (address(operationExecutor), 0)), 0);
    vm.prank(payer, payer);
    (bool ok,) = address(operationExecutor).call(_executeCd(_inner, IERC20(address(underlying))));
    require(ok, "relay reverted");
    assertEq(underlying.balanceOf(_sipa), 0, "the sweep must still land");
    assertEq(underlying.balanceOf(address(sm)), potBefore, "a sweep with no subsidy drew from the pot");
  }

  function test_GivenARelayerTransactionWhoseFeePaysTheTarget_ThenTheSubsidySendsNoTransfer() external {
    vm.prank(OWNER);
    sm.setDepositConfig(0, type(uint128).max, 0);
    vm.fee(1);
    vm.txGasPrice(1);
    _relayAndExpectNoTransfer(address(resweepSipa), _resweepCd(address(operationExecutor), ""));
  }

  function test_GivenAnIntentWithACeilingOfZero_WhenAFirstSweepIsRelayed_ThenTheSubsidyPaysNothing() external {
    vm.prank(OWNER);
    sm.setSweepGasCeiling(Intents.DEPOSIT, 0);
    _relayAndExpectNoTransfer(firstSipa, _deployCd(firstIntent));
  }

  function test_GivenAnIntentWithACeiling_WhenAFirstSweepIsRelayed_ThenTheSubsidyPays() external {
    uint256 potBefore = underlying.balanceOf(address(sm));
    vm.prank(payer, payer);
    (bool ok,) = address(operationExecutor).call(_executeCd(_deployCd(firstIntent), IERC20(address(underlying))));
    require(ok, "relay reverted");
    assertLt(underlying.balanceOf(address(sm)), potBefore, "an eligible first sweep drew nothing from the pot");
  }
}
