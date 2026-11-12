// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DepositSubsidySetup, SubsidyMath} from "@test/subsidy-check/subsidies/SubsidySetup.sol";

abstract contract DepositSubsidyFlowCorners is DepositSubsidySetup {
  uint256 internal constant FEED_TO_TOKEN_WEI = 1e10;

  struct Flow {
    uint256 fee;
    uint128 profit;
    uint128 cap;
    uint256 coverGas;
    uint256 unpricedGas;
    uint256 targetWei;
    uint256 usdPerEth;
  }

  function _flow(
    uint256 _fee,
    uint128 _profit,
    uint128 _cap,
    uint256 _coverGas,
    uint256 _unpricedGas,
    uint256 _targetWei,
    uint256 _usdPerEth
  ) internal pure returns (Flow memory) {
    return Flow(_fee, _profit, _cap, _coverGas, _unpricedGas, _targetWei, _usdPerEth);
  }

  function _atTheTarget(Flow memory _f) internal returns (uint256 payout, uint256 required) {
    _configure(_f.profit, _f.cap);
    _fundPot(_f.cap);
    _setPrices(_f.targetWei - SubsidyMath.MAX_PRIORITY_FEE_WEI, _f.targetWei);
    uint256 tokenPerEth = _f.usdPerEth * FEED_TO_TOKEN_WEI;
    payout = _f.fee + subsidy.exposedQuote(_f.fee, _f.coverGas - _f.unpricedGas, tokenPerEth);
    required = SubsidyMath.required(_f.coverGas, _f.targetWei, tokenPerEth) + 1;
  }

  function _assertLiveAtTheTarget(Flow memory _f) internal {
    (uint256 payout, uint256 required) = _atTheTarget(_f);
    assertGe(payout, required, "the flow is not live at its target with a 1 token-wei margin");
  }

  function _assertShortAtTheTarget(Flow memory _f) internal {
    (uint256 payout, uint256 required) = _atTheTarget(_f);
    assertLt(payout, required, "a known gap is live at its target: remove it from flows.GAP_FLOWS");
  }
}
