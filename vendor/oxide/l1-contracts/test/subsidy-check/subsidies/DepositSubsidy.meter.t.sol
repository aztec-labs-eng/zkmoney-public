// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Math} from "@oz/utils/math/Math.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {Intent} from "@periphery/Intent.sol";
import {USDC, USDT} from "@periphery/ThreePoolLib.sol";
import {DepositSubsidySetup, SubsidyMath} from "@test/subsidy-check/subsidies/SubsidySetup.sol";
import {DepositSubsidyHarness} from "@test/subsidy-check/subsidies/SubsidyHarnesses.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";

contract DepositSubsidyMeterTest is DepositSubsidySetup {
  uint256 internal constant TX_INTRINSIC_GAS = 21_000;
  uint256 internal constant CLEARED_SLOT = 4800;
  uint256 internal constant RESTORED_ZERO_SLOT = 19_900;
  uint256 internal constant RESTORED_SLOT = 2800;
  uint256 internal constant NO_CEILING = type(uint128).max;

  struct Relay {
    uint256 frameGas;
    uint256 calldataGas;
    uint256 headGas;
    address input;
    bool startedEmpty;
    bool fresh;
  }

  function _input(uint256 _path) internal view returns (address) {
    if (_path == 0) return address(token);
    return _path == 1 ? address(USDC) : address(USDT);
  }

  function _relay(uint256 _frame, uint256 _calldata, uint256 _head, uint256 _category)
    internal
    view
    returns (Relay memory r)
  {
    r.frameGas = bound(_frame, 0, 2 ** 24);
    r.calldataGas = bound(_calldata, 0, 2 ** 20);
    r.headGas = bound(_head, 0, 2 ** 20);
    r.input = _input(_category % 3);
    r.startedEmpty = (_category / 3) % 2 == 1;
    r.fresh = _category / 6 == 1;
  }

  function _gross(Relay memory _r) internal view returns (uint256 gross) {
    gross = _r.frameGas + TX_INTRINSIC_GAS + _r.calldataGas + _r.headGas + subsidy.EXECUTOR_PATH_GAS();
    if (_r.fresh) gross += subsidy.FRESH_BALANCE_GAS();
  }

  function _protocolRefund(Relay memory _r) internal view returns (uint256 refund) {
    if (_r.input == address(token)) {
      refund = CLEARED_SLOT + RESTORED_ZERO_SLOT;
    } else {
      refund = RESTORED_ZERO_SLOT + RESTORED_ZERO_SLOT + CLEARED_SLOT + RESTORED_ZERO_SLOT + RESTORED_ZERO_SLOT;
    }
    refund += _r.startedEmpty ? RESTORED_ZERO_SLOT : RESTORED_SLOT;
  }

  function _priced(Relay memory _r, uint256 _ceiling) internal returns (uint256) {
    token.set(address(subsidy), type(uint128).max, _r.fresh ? 0 : 1);
    DepositSubsidy.Meter memory meter;
    meter.frameGas = _r.frameGas;
    meter.calldataGas = _r.calldataGas;
    meter.executorHeadGas = _r.headGas;
    meter.executorStartedEmpty = _r.startedEmpty;
    return subsidy.exposedPricedGas(_ceiling, _r.input, meter);
  }

  function testFuzz_GivenAnUnclippedRelay_ThenThePricedGasIsTheGrossGasLessTheProtocolRefunds(
    uint256 _frame,
    uint256 _calldata,
    uint256 _head
  ) external {
    for (uint256 category = 0; category < 12; category++) {
      Relay memory r = _relay(_frame, _calldata, _head, category);
      uint256 gross = _gross(r);
      assertEq(
        _priced(r, NO_CEILING),
        gross - Math.min(_protocolRefund(r), gross / 5),
        "the priced gas is not the gross gas less the EIP-3529 refunds of the relay"
      );
    }
  }

  function test_GivenARefundAboveAFifthOfTheGross_ThenAFifthOfTheGrossIsSubtracted() external {
    for (uint256 category = 0; category < 12; category++) {
      Relay memory r = _relay(0, 0, 0, category);
      uint256 gross = _gross(r);
      assertGt(_protocolRefund(r), gross / 5, "the case does not saturate the refund cap");
      assertEq(_priced(r, NO_CEILING), gross - gross / 5, "a saturated refund is not capped at a fifth of the gross");
    }
  }

  function test_GivenARefundAtAFifthOfTheGross_ThenTheRefundIsSubtractedWhole() external {
    Relay memory r = _relay(0, 0, 0, 0);
    uint256 refund = _protocolRefund(r);
    r.frameGas = 5 * refund - _gross(r);
    assertEq(_gross(r), 5 * refund, "the case is not at the refund cap");
    assertEq(_priced(r, NO_CEILING), 4 * refund, "at the cap the whole refund is subtracted");
    r.frameGas += 5;
    assertEq(_priced(r, NO_CEILING), 4 * refund + 5, "above the cap the whole refund is subtracted");
    r.frameGas -= 10;
    assertEq(_priced(r, NO_CEILING), 4 * refund - 4, "below the cap a fifth of the gross is subtracted");
  }

  function testFuzz_GivenSoundGasBounds_ThenThePricedGasIsAtMostTheChargedGas(
    uint256 _frame,
    uint256 _calldata,
    uint256 _head,
    uint256 _ceiling,
    uint256[3] memory _actual
  ) external {
    for (uint256 category = 0; category < 12; category++) {
      Relay memory r = _relay(_frame, _calldata, _head, category);
      uint256 grossActual = _gross(r) + bound(_actual[0], 0, 2 ** 24);
      uint256 refundActual = bound(_actual[1], 0, _protocolRefund(r));
      uint256 calldataFloor = bound(_actual[2], 0, 2 ** 25);
      assertLe(
        _priced(r, bound(_ceiling, 0, 2 ** 24)),
        SubsidyMath.charged(grossActual, refundActual, calldataFloor),
        "the subsidy prices more gas than the transaction is charged: a self-relay farms it"
      );
    }
  }

  function testFuzz_GivenAnUnpricedRefund_ThenTheOverpricingIsAtMostThatRefund(
    uint256 _frame,
    uint256 _calldata,
    uint256 _head,
    uint256 _unpricedRefund
  ) external {
    uint256 unpricedRefund = bound(_unpricedRefund, 0, 2 ** 20);
    for (uint256 category = 0; category < 12; category++) {
      Relay memory r = _relay(_frame, _calldata, _head, category);
      uint256 gross = _gross(r);
      assertLe(
        _priced(r, NO_CEILING),
        SubsidyMath.charged(gross, _protocolRefund(r) + unpricedRefund, 0) + unpricedRefund,
        "the overpricing is more than the refund that the meter does not price"
      );
    }
  }

  function test_GivenAnUnpricedRefund_ThenThePricedGasIsAboveTheChargedGas() external {
    Relay memory r = _relay(300_000, 0, 0, 0);
    uint256 gross = _gross(r);
    uint256 charged = SubsidyMath.charged(gross, _protocolRefund(r) + CLEARED_SLOT, 0);
    uint256 priced = _priced(r, NO_CEILING);
    assertGt(priced, charged, "the counterexample with an unpriced refund moved");
    assertEq(priced - charged, CLEARED_SLOT, "the overpricing is the unpriced refund");
  }

  function testFuzz_GivenACeiling_ThenThePricedGasIsAtMostTheCeilingPlusTheFreshBalanceGas(
    uint256 _frame,
    uint256 _calldata,
    uint256 _head,
    uint256 _ceiling
  ) external {
    uint256 ceiling = bound(_ceiling, 0, 2 ** 24);
    for (uint256 category = 0; category < 12; category++) {
      Relay memory r = _relay(_frame, _calldata, _head, category);
      uint256 allowance = r.fresh ? subsidy.FRESH_BALANCE_GAS() : 0;
      uint256 priced = _priced(r, ceiling);
      assertLe(priced, ceiling + allowance, "the subsidy prices gas over the ceiling");
      uint256 gross = _gross(r);
      assertEq(
        priced,
        Math.min(gross - Math.min(_protocolRefund(r), gross / 5), ceiling + allowance),
        "the ceiling does not clip the priced gas"
      );
    }
  }

  function testFuzz_GivenACeilingOfZero_ThenEveryTokenGetsAZeroCeiling(uint8 _intent, address _other) external {
    Intent intent = Intent.wrap(_intent);
    vm.prank(OWNER);
    subsidy.setSweepGasCeiling(intent, 0);
    address[4] memory tokens = [address(token), address(USDC), address(USDT), _other];
    for (uint256 i = 0; i < tokens.length; i++) {
      assertEq(subsidy.exposedSweepGasCeilingFor(intent, tokens[i], false), 0, "a ceiling of 0 grows for a resweep");
      assertEq(subsidy.exposedSweepGasCeilingFor(intent, tokens[i], true), 0, "a ceiling of 0 grows for a deploy");
    }
  }

  function testFuzz_GivenATokenThatItDoesNotRoute_ThenTheCeilingIsZero(uint8 _intent, uint256 _ceiling, uint256 _seed)
    external
  {
    Intent intent = Intent.wrap(_intent);
    vm.prank(OWNER);
    subsidy.setSweepGasCeiling(intent, bound(_ceiling, 1, 2 ** 32));
    address unrouted = address(uint160(uint256(keccak256(abi.encode(_seed, "unrouted")))));
    assertEq(subsidy.exposedSweepGasCeilingFor(intent, unrouted, false), 0, "an unrouted token gets a ceiling");
    assertEq(subsidy.exposedSweepGasCeilingFor(intent, unrouted, true), 0, "an unrouted deploy gets a ceiling");
  }

  function test_GivenARoutedToken_ThenTheCeilingAddsItsAllowances() external {
    Intent intent = Intent.wrap(1);
    vm.prank(OWNER);
    subsidy.setSweepGasCeiling(intent, 290_000);
    uint256 deploy = subsidy.SWEEP_GAS_DEPLOY_ALLOWANCE();
    assertEq(subsidy.exposedSweepGasCeilingFor(intent, address(token), false), 290_000, "token resweep");
    assertEq(subsidy.exposedSweepGasCeilingFor(intent, address(token), true), 290_000 + deploy, "token deploy");
    assertEq(
      subsidy.exposedSweepGasCeilingFor(intent, address(USDC), false),
      290_000 + subsidy.SWEEP_GAS_SWAP_USDC_HOP(),
      "USDC resweep"
    );
    assertEq(
      subsidy.exposedSweepGasCeilingFor(intent, address(USDT), true),
      290_000 + deploy + subsidy.SWEEP_GAS_SWAP_USDT_HOP(),
      "USDT deploy"
    );
  }

  function testFuzz_GivenARelayerTransaction_ThenTheMeterKeepsTheExecutorContext(
    uint256 _startGas,
    uint256 _headGas,
    bool _startedEmpty
  ) external {
    uint256 headGas = bound(_headGas, 0, type(uint128).max);
    executor.set(true, _startedEmpty, address(token), headGas);
    vm.prank(address(executor));
    DepositSubsidy.Meter memory meter = subsidy.exposedOpenMeter(_startGas, address(executor));

    assertTrue(meter.relayerTransaction, "the meter does not mark a relayer transaction");
    assertEq(meter.startGas, _startGas, "the meter loses its start gas");
    assertEq(meter.executorHeadGas, headGas, "the meter loses the executor's head gas");
    assertEq(meter.executorStartedEmpty, _startedEmpty, "the meter loses the executor's start balance");
    assertGt(meter.calldataGas, 0, "the meter prices no calldata");
  }

  function testFuzz_GivenAnyCalldata_ThenTheMeterPricesItAtTheEvmCost(
    bytes memory _suffix,
    uint256 _zeros,
    uint256 _ones
  ) external {
    bytes memory suffix = bytes.concat(_suffix, new bytes(bound(_zeros, 0, 2048)), _filled(bound(_ones, 0, 2048)));
    assertEq(
      _openedCalldataGas(suffix),
      RelayerTransaction.calldataGas(_openMeterCall(suffix)),
      "the meter prices calldata at another cost than the EVM charges"
    );
  }

  function test_GivenEachLengthOfAPartialWord_ThenTheMeterPricesTheCalldataAtTheEvmCost() external {
    for (uint256 length = 0; length <= 64; length++) {
      bytes memory suffix = new bytes(length);
      for (uint256 i = 0; i < length; i += 3) {
        suffix[i] = 0xff;
      }
      assertEq(
        _openedCalldataGas(suffix),
        RelayerTransaction.calldataGas(_openMeterCall(suffix)),
        "the meter prices a partial word of calldata at another cost than the EVM charges"
      );
    }
  }

  function test_GivenZeroPaddedCalldata_ThenTheMeterPricesEachZeroByteAtTheEvmCost() external {
    bytes memory suffix = bytes.concat(new bytes(1024), _filled(1024));
    assertEq(
      _openedCalldataGas(suffix),
      RelayerTransaction.calldataGas(_openMeterCall(suffix)),
      "the meter prices zero-padded calldata at another cost than the EVM charges"
    );
  }

  function testFuzz_GivenACeilingForEachIntent_ThenEachIntentGetsItsOwn(
    uint8 _intent,
    uint256 _step,
    uint256 _ceiling,
    uint256 _otherCeiling,
    bool _deployed
  ) external {
    Intent intent = Intent.wrap(_intent);
    Intent other = Intent.wrap(uint8((uint256(_intent) + bound(_step, 1, 255)) % 256));
    uint256 ceiling = bound(_ceiling, 1, 2 ** 32);
    uint256 otherCeiling = bound(_otherCeiling, 1, 2 ** 32);
    vm.startPrank(OWNER);
    subsidy.setSweepGasCeiling(intent, ceiling);
    subsidy.setSweepGasCeiling(other, otherCeiling);
    vm.stopPrank();

    uint256 deploy = _deployed ? subsidy.SWEEP_GAS_DEPLOY_ALLOWANCE() : 0;
    assertEq(subsidy.exposedSweepGasCeilingFor(intent, address(token), _deployed), ceiling + deploy, "intent");
    assertEq(subsidy.exposedSweepGasCeilingFor(other, address(token), _deployed), otherCeiling + deploy, "other intent");
    assertEq(
      subsidy.exposedSweepGasCeilingFor(intent, address(USDC), _deployed),
      ceiling + deploy + subsidy.SWEEP_GAS_SWAP_USDC_HOP(),
      "intent through USDC"
    );
    assertEq(
      subsidy.exposedSweepGasCeilingFor(other, address(USDT), _deployed),
      otherCeiling + deploy + subsidy.SWEEP_GAS_SWAP_USDT_HOP(),
      "other intent through USDT"
    );
  }

  function _filled(uint256 _length) internal pure returns (bytes memory data) {
    data = new bytes(_length);
    for (uint256 i = 0; i < _length; i++) {
      data[i] = 0xff;
    }
  }

  function _openMeterCall(bytes memory _suffix) internal view returns (bytes memory) {
    return bytes.concat(abi.encodeCall(DepositSubsidyHarness.exposedOpenMeter, (0, address(executor))), _suffix);
  }

  function _openedCalldataGas(bytes memory _suffix) internal returns (uint256) {
    executor.set(true, false, address(token), 0);
    vm.prank(address(executor));
    (bool ok, bytes memory ret) = address(subsidy).call(_openMeterCall(_suffix));
    require(ok, "the meter did not open");
    return abi.decode(ret, (DepositSubsidy.Meter)).calldataGas;
  }
}
