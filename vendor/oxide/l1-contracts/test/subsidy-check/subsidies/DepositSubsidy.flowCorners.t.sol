// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DepositSubsidyFlowCorners} from "@test/subsidy-check/subsidies/DepositSubsidyFlowCorners.sol";

contract DepositSubsidyFlowCornersTest is DepositSubsidyFlowCorners {
  function test_Flow_v6prod_daiDepositFirstSweep_IsLiveAtItsTarget() external {
    _assertLiveAtTheTarget(_v6prod_daiDepositFirstSweep());
  }

  function _v6prod_daiDepositFirstSweep() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 371_000, 2300, 5.1 gwei, 5000e8);
  }

  function test_Flow_v6prod_daiDepositFirstSweepUsdc_IsLiveAtItsTarget() external {
    _assertLiveAtTheTarget(_v6prod_daiDepositFirstSweepUsdc());
  }

  function _v6prod_daiDepositFirstSweepUsdc() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 477_000, 2500, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiDepositFirstSweepUsdcIdleDai_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiDepositFirstSweepUsdcIdleDai());
  }

  function _v6prod_daiDepositFirstSweepUsdcIdleDai() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 475_000, 17_600, 5.1 gwei, 5000e8);
  }

  function test_Flow_v6prod_daiDepositFirstSweepUsdt_IsLiveAtItsTarget() external {
    _assertLiveAtTheTarget(_v6prod_daiDepositFirstSweepUsdt());
  }

  function _v6prod_daiDepositFirstSweepUsdt() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 479_000, 2500, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiDepositFirstSweepUsdtIdleDai_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiDepositFirstSweepUsdtIdleDai());
  }

  function _v6prod_daiDepositFirstSweepUsdtIdleDai() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 477_000, 17_600, 5.1 gwei, 5000e8);
  }

  function test_Flow_v6prod_daiDepositResweep_IsLiveAtItsTarget() external {
    _assertLiveAtTheTarget(_v6prod_daiDepositResweep());
  }

  function _v6prod_daiDepositResweep() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 286_000, 1700, 5.1 gwei, 5000e8);
  }

  function test_Flow_v6prod_daiDepositResweepUsdc_IsLiveAtItsTarget() external {
    _assertLiveAtTheTarget(_v6prod_daiDepositResweepUsdc());
  }

  function _v6prod_daiDepositResweepUsdc() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 397_000, 1700, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiDepositResweepUsdcIdleDai_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiDepositResweepUsdcIdleDai());
  }

  function _v6prod_daiDepositResweepUsdcIdleDai() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 390_000, 8100, 5.1 gwei, 5000e8);
  }

  function test_Flow_v6prod_daiDepositResweepUsdt_IsLiveAtItsTarget() external {
    _assertLiveAtTheTarget(_v6prod_daiDepositResweepUsdt());
  }

  function _v6prod_daiDepositResweepUsdt() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 399_000, 1700, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiDepositResweepUsdtIdleDai_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiDepositResweepUsdtIdleDai());
  }

  function _v6prod_daiDepositResweepUsdtIdleDai() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 392_000, 8500, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationFirstSweep_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationFirstSweep());
  }

  function _v6prod_daiRegistrationFirstSweep() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 925_000, 15_100, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationFirstSweepUsdc_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationFirstSweepUsdc());
  }

  function _v6prod_daiRegistrationFirstSweepUsdc() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 1_030_000, 2500, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationFirstSweepUsdcIdleDai_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationFirstSweepUsdcIdleDai());
  }

  function _v6prod_daiRegistrationFirstSweepUsdcIdleDai() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 1_028_000, 17_600, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationFirstSweepUsdt_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationFirstSweepUsdt());
  }

  function _v6prod_daiRegistrationFirstSweepUsdt() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 1_032_000, 2500, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationFirstSweepUsdtIdleDai_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationFirstSweepUsdtIdleDai());
  }

  function _v6prod_daiRegistrationFirstSweepUsdtIdleDai() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 1_030_000, 17_600, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationSweep_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationSweep());
  }

  function _v6prod_daiRegistrationSweep() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 840_000, 12_000, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationSweepUsdc_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationSweepUsdc());
  }

  function _v6prod_daiRegistrationSweepUsdc() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 945_000, 1900, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationSweepUsdcIdleDai_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationSweepUsdcIdleDai());
  }

  function _v6prod_daiRegistrationSweepUsdcIdleDai() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 943_000, 17_000, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationSweepUsdt_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationSweepUsdt());
  }

  function _v6prod_daiRegistrationSweepUsdt() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 947_000, 1900, 5.1 gwei, 5000e8);
  }

  function test_Gap_DaiConfig_v6prod_daiRegistrationSweepUsdtIdleDai_IsShortAtItsTarget() external {
    _assertShortAtTheTarget(_v6prod_daiRegistrationSweepUsdtIdleDai());
  }

  function _v6prod_daiRegistrationSweepUsdtIdleDai() internal pure returns (Flow memory) {
    return _flow(5e17, 1e17, 12e18, 945_000, 17_000, 5.1 gwei, 5000e8);
  }

  function test_Flow_v6prod_susdsDepositFirstSweep_IsLiveAtItsTarget() external {
    _assertLiveAtTheTarget(_v6prod_susdsDepositFirstSweep());
  }

  function _v6prod_susdsDepositFirstSweep() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 370_000, 3400, 5.1 gwei, 5000e8);
  }

  function test_Flow_v6prod_susdsDepositResweep_IsLiveAtItsTarget() external {
    _assertLiveAtTheTarget(_v6prod_susdsDepositResweep());
  }

  function _v6prod_susdsDepositResweep() internal pure returns (Flow memory) {
    return _flow(25e16, 1e17, 12e18, 285_000, 2800, 5.1 gwei, 5000e8);
  }
}
