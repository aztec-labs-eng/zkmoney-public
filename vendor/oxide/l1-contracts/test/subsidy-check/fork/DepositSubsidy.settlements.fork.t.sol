// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DepositSubsidySettlementsFixture} from "@test/subsidy-check/fork/DepositSubsidySettlementsFixture.sol";

/// forge-config: default.isolate = true
contract DepositSubsidySettlementsForkTest is DepositSubsidySettlementsFixture {
  function _stageRows() internal override {
    _stageRow("daiDepositFirstSweep");
    _stageRow("daiDepositResweep");
    _stageRow("daiDepositFirstSweepUsdc");
    _stageRow("daiDepositResweepUsdc");
    _stageRow("daiDepositFirstSweepUsdt");
    _stageRow("daiDepositResweepUsdt");
    _stageRow("daiDepositFirstSweepUsdcIdleDai");
    _stageRow("daiDepositResweepUsdcIdleDai");
    _stageRow("daiDepositFirstSweepUsdtIdleDai");
    _stageRow("daiDepositResweepUsdtIdleDai");
    _stageRow("susdsDepositFirstSweep");
    _stageRow("susdsDepositResweep");
    _stageRow("daiRegistrationFirstSweep");
    _stageRow("daiRegistrationSweep");
    _stageRow("daiRegistrationFirstSweepUsdc");
    _stageRow("daiRegistrationSweepUsdc");
    _stageRow("daiRegistrationFirstSweepUsdt");
    _stageRow("daiRegistrationSweepUsdt");
    _stageRow("daiRegistrationFirstSweepUsdcIdleDai");
    _stageRow("daiRegistrationSweepUsdcIdleDai");
    _stageRow("daiRegistrationFirstSweepUsdtIdleDai");
    _stageRow("daiRegistrationSweepUsdtIdleDai");
  }

  function test_Settle_v6prod_daiDepositFirstSweep_IsLiveAtTheCorner() external {
    _assertLiveAtTheCorner("daiDepositFirstSweep");
  }

  function test_Farm_v6prod_daiDepositFirstSweep_GainsNothing() external {
    _assertGainsNothing("daiDepositFirstSweep");
  }

  function test_Settle_v6prod_daiDepositFirstSweepUsdc_IsLiveAtTheCorner() external {
    _assertLiveAtTheCorner("daiDepositFirstSweepUsdc");
  }

  function test_Farm_v6prod_daiDepositFirstSweepUsdc_GainsNothing() external {
    _assertGainsNothing("daiDepositFirstSweepUsdc");
  }

  function test_Gap_DaiConfig_v6prod_daiDepositFirstSweepUsdcIdleDai_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiDepositFirstSweepUsdcIdleDai", false);
  }

  function test_Farm_v6prod_daiDepositFirstSweepUsdcIdleDai_GainsNothing() external {
    _assertGainsNothing("daiDepositFirstSweepUsdcIdleDai");
  }

  function test_Settle_v6prod_daiDepositFirstSweepUsdt_IsLiveAtTheCorner() external {
    _assertLiveAtTheCorner("daiDepositFirstSweepUsdt");
  }

  function test_Farm_v6prod_daiDepositFirstSweepUsdt_GainsNothing() external {
    _assertGainsNothing("daiDepositFirstSweepUsdt");
  }

  function test_Gap_DaiConfig_v6prod_daiDepositFirstSweepUsdtIdleDai_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiDepositFirstSweepUsdtIdleDai", false);
  }

  function test_Farm_v6prod_daiDepositFirstSweepUsdtIdleDai_GainsNothing() external {
    _assertGainsNothing("daiDepositFirstSweepUsdtIdleDai");
  }

  function test_Settle_v6prod_daiDepositResweep_IsLiveAtTheCorner() external {
    _assertLiveAtTheCorner("daiDepositResweep");
  }

  function test_Farm_v6prod_daiDepositResweep_GainsNothing() external {
    _assertGainsNothing("daiDepositResweep");
  }

  function test_Settle_v6prod_daiDepositResweepUsdc_IsLiveAtTheCorner() external {
    _assertLiveAtTheCorner("daiDepositResweepUsdc");
  }

  function test_Farm_v6prod_daiDepositResweepUsdc_GainsNothing() external {
    _assertGainsNothing("daiDepositResweepUsdc");
  }

  function test_Gap_DaiConfig_v6prod_daiDepositResweepUsdcIdleDai_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiDepositResweepUsdcIdleDai", false);
  }

  function test_Farm_v6prod_daiDepositResweepUsdcIdleDai_GainsNothing() external {
    _assertGainsNothing("daiDepositResweepUsdcIdleDai");
  }

  function test_Settle_v6prod_daiDepositResweepUsdt_IsLiveAtTheCorner() external {
    _assertLiveAtTheCorner("daiDepositResweepUsdt");
  }

  function test_Farm_v6prod_daiDepositResweepUsdt_GainsNothing() external {
    _assertGainsNothing("daiDepositResweepUsdt");
  }

  function test_Gap_DaiConfig_v6prod_daiDepositResweepUsdtIdleDai_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiDepositResweepUsdtIdleDai", false);
  }

  function test_Farm_v6prod_daiDepositResweepUsdtIdleDai_GainsNothing() external {
    _assertGainsNothing("daiDepositResweepUsdtIdleDai");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationFirstSweep_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationFirstSweep", true);
  }

  function test_Farm_v6prod_daiRegistrationFirstSweep_GainsNothing() external {
    _assertGainsNothing("daiRegistrationFirstSweep");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationFirstSweepUsdc_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationFirstSweepUsdc", true);
  }

  function test_Farm_v6prod_daiRegistrationFirstSweepUsdc_GainsNothing() external {
    _assertGainsNothing("daiRegistrationFirstSweepUsdc");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationFirstSweepUsdcIdleDai_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationFirstSweepUsdcIdleDai", true);
  }

  function test_Farm_v6prod_daiRegistrationFirstSweepUsdcIdleDai_GainsNothing() external {
    _assertGainsNothing("daiRegistrationFirstSweepUsdcIdleDai");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationFirstSweepUsdt_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationFirstSweepUsdt", true);
  }

  function test_Farm_v6prod_daiRegistrationFirstSweepUsdt_GainsNothing() external {
    _assertGainsNothing("daiRegistrationFirstSweepUsdt");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationFirstSweepUsdtIdleDai_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationFirstSweepUsdtIdleDai", true);
  }

  function test_Farm_v6prod_daiRegistrationFirstSweepUsdtIdleDai_GainsNothing() external {
    _assertGainsNothing("daiRegistrationFirstSweepUsdtIdleDai");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationSweep_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationSweep", true);
  }

  function test_Farm_v6prod_daiRegistrationSweep_GainsNothing() external {
    _assertGainsNothing("daiRegistrationSweep");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationSweepUsdc_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationSweepUsdc", true);
  }

  function test_Farm_v6prod_daiRegistrationSweepUsdc_GainsNothing() external {
    _assertGainsNothing("daiRegistrationSweepUsdc");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationSweepUsdcIdleDai_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationSweepUsdcIdleDai", true);
  }

  function test_Farm_v6prod_daiRegistrationSweepUsdcIdleDai_GainsNothing() external {
    _assertGainsNothing("daiRegistrationSweepUsdcIdleDai");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationSweepUsdt_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationSweepUsdt", true);
  }

  function test_Farm_v6prod_daiRegistrationSweepUsdt_GainsNothing() external {
    _assertGainsNothing("daiRegistrationSweepUsdt");
  }

  function test_Gap_GasLimitEscalation_v6prod_daiRegistrationSweepUsdtIdleDai_SettlesButIsShortAtTheCorner() external {
    _assertShortAtTheCorner("daiRegistrationSweepUsdtIdleDai", true);
  }

  function test_Farm_v6prod_daiRegistrationSweepUsdtIdleDai_GainsNothing() external {
    _assertGainsNothing("daiRegistrationSweepUsdtIdleDai");
  }

  function test_Settle_v6prod_susdsDepositFirstSweep_IsLiveAtTheCorner() external {
    _assertLiveAtTheCorner("susdsDepositFirstSweep");
  }

  function test_Gap_SusdsAtOneDollar_v6prod_susdsDepositFirstSweep_Farms() external {
    _assertFarms("susdsDepositFirstSweep");
  }

  function test_Settle_v6prod_susdsDepositResweep_IsLiveAtTheCorner() external {
    _assertLiveAtTheCorner("susdsDepositResweep");
  }

  function test_Gap_SusdsAtOneDollar_v6prod_susdsDepositResweep_Farms() external {
    _assertFarms("susdsDepositResweep");
  }
}
