// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {DepositSubsidyGasRowsFixture} from "@test/subsidy-check/fork/DepositSubsidyGasRowsFixture.sol";

/// forge-config: default.isolate = true
contract DepositSubsidyGasRowsForkTest is DepositSubsidyGasRowsFixture {
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

  function test_GasRow_daiDepositFirstSweep_BoundsTheRelay() external {
    _checkRow("daiDepositFirstSweep");
  }

  function test_GasRow_daiDepositResweep_BoundsTheRelay() external {
    _checkRow("daiDepositResweep");
  }

  function test_GasRow_daiDepositFirstSweepUsdc_BoundsTheRelay() external {
    _checkRow("daiDepositFirstSweepUsdc");
  }

  function test_GasRow_daiDepositResweepUsdc_BoundsTheRelay() external {
    _checkRow("daiDepositResweepUsdc");
  }

  function test_GasRow_daiDepositFirstSweepUsdt_BoundsTheRelay() external {
    _checkRow("daiDepositFirstSweepUsdt");
  }

  function test_GasRow_daiDepositResweepUsdt_BoundsTheRelay() external {
    _checkRow("daiDepositResweepUsdt");
  }

  function test_GasRow_daiDepositFirstSweepUsdcIdleDai_BoundsTheRelay() external {
    _checkRow("daiDepositFirstSweepUsdcIdleDai");
  }

  function test_GasRow_daiDepositResweepUsdcIdleDai_BoundsTheRelay() external {
    _checkRow("daiDepositResweepUsdcIdleDai");
  }

  function test_GasRow_daiDepositFirstSweepUsdtIdleDai_BoundsTheRelay() external {
    _checkRow("daiDepositFirstSweepUsdtIdleDai");
  }

  function test_GasRow_daiDepositResweepUsdtIdleDai_BoundsTheRelay() external {
    _checkRow("daiDepositResweepUsdtIdleDai");
  }

  function test_GasRow_daiRegistrationFirstSweep_BoundsTheRelay() external {
    _checkRow("daiRegistrationFirstSweep");
  }

  function test_GasRow_daiRegistrationSweep_BoundsTheRelay() external {
    _checkRow("daiRegistrationSweep");
  }

  function test_GasRow_daiRegistrationFirstSweepUsdc_BoundsTheRelay() external {
    _checkRow("daiRegistrationFirstSweepUsdc");
  }

  function test_GasRow_daiRegistrationSweepUsdc_BoundsTheRelay() external {
    _checkRow("daiRegistrationSweepUsdc");
  }

  function test_GasRow_daiRegistrationFirstSweepUsdt_BoundsTheRelay() external {
    _checkRow("daiRegistrationFirstSweepUsdt");
  }

  function test_GasRow_daiRegistrationSweepUsdt_BoundsTheRelay() external {
    _checkRow("daiRegistrationSweepUsdt");
  }

  function test_GasRow_daiRegistrationFirstSweepUsdcIdleDai_BoundsTheRelay() external {
    _checkRow("daiRegistrationFirstSweepUsdcIdleDai");
  }

  function test_GasRow_daiRegistrationSweepUsdcIdleDai_BoundsTheRelay() external {
    _checkRow("daiRegistrationSweepUsdcIdleDai");
  }

  function test_GasRow_daiRegistrationFirstSweepUsdtIdleDai_BoundsTheRelay() external {
    _checkRow("daiRegistrationFirstSweepUsdtIdleDai");
  }

  function test_GasRow_daiRegistrationSweepUsdtIdleDai_BoundsTheRelay() external {
    _checkRow("daiRegistrationSweepUsdtIdleDai");
  }

  function test_GasRow_susdsDepositFirstSweep_BoundsTheRelay() external {
    _checkRow("susdsDepositFirstSweep");
  }

  function test_GasRow_susdsDepositResweep_BoundsTheRelay() external {
    _checkRow("susdsDepositResweep");
  }
}
