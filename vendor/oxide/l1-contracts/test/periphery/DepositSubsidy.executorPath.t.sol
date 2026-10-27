// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {DEPOSIT_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";

interface VmCooling {
  function cool(address) external;
}

contract RelayingContract {
  function relay(OperationExecutor _executor, bytes calldata _call) external returns (uint256 payout) {
    (bool ok, bytes memory ret) = address(_executor).call(_call);
    require(ok, "relay reverted");
    payout = abi.decode(ret, (uint256));
  }
}

contract SubsidyCallingTarget {
  function sweep(DepositSubsidy _subsidy, bytes calldata _call) external {
    (bool ok,) = address(_subsidy).call(_call);
    require(ok, "subsidy call reverted");
  }
}

abstract contract DepositSubsidyExecutorPathFixture is SweepGasFixture {
  uint256 internal constant DEPOSIT = 100 ether;
  uint256 internal constant UNDERPAY_TOLERANCE = 2000;
  uint256 internal constant RELAYER_CALLDATA_PADDING = 2 * 32 * (16 - 4);
  uint256 internal constant HARNESS_TO_CHAIN_RELAY = 33_453;

  DepositSubsidy internal sm;
  MockV3Aggregator internal feed;
  TestERC20 internal otherToken;
  address internal payer;
  address internal freshPayer;
  RelayingContract internal relayingContract;

  bytes internal resweepIntent;
  DepositSIPA internal resweepSipa;
  bytes internal firstIntent;
  address internal firstSipa;

  function setUp() public virtual override {
    super.setUp();
    feed = new MockV3Aggregator(8, PRICED_FEED_ANSWER);
    sm = new DepositSubsidy(
      OWNER,
      address(portal),
      IOperationExecutor(address(operationExecutor)),
      AggregatorV3Interface(address(feed)),
      sipaFactory
    );
    underlying.mint(address(sm), 1_000_000 ether);
    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);

    otherToken = new TestERC20("Other", "OTH", address(this));
    payer = makeAddr("payer");
    underlying.mint(payer, 1);
    freshPayer = makeAddr("freshPayer");
    relayingContract = new RelayingContract();

    _warmInbox(8);

    resweepIntent = _depositIntent("resweep");
    resweepSipa = _depositSIPA(resweepIntent);
    underlying.mint(address(resweepSipa), DEPOSIT);
    resweepSipa.sweep(address(underlying), payer, resweepIntent, "");
    underlying.mint(address(resweepSipa), DEPOSIT);

    firstIntent = _depositIntent("first");
    firstSipa = _predictDepositSIPA(firstIntent);
    underlying.mint(firstSipa, DEPOSIT);
  }

  function _assertPricedAtTheTransactionGas(uint256 _txGas, uint256 _priced) internal pure {
    assertLe(_priced, _txGas, "the subsidy priced more gas than the transaction used: a self-relay farms it");
    assertGe(_priced + UNDERPAY_TOLERANCE, _txGas, "the subsidy priced well below the transaction gas");
  }

  function _relayFrom(address _from, address _sipa, bytes memory _inner)
    internal
    returns (uint256 txGas, uint256 priced)
  {
    return _sendFrom(_from, _sipa, _executeCd(_inner, IERC20(address(underlying))));
  }

  function _sendFrom(address _from, address _sipa, bytes memory _outer)
    internal
    returns (uint256 txGas, uint256 priced)
  {
    _coolAll(_sipa);
    VmCooling(address(vm)).cool(_from);
    vm.prank(_from, _from);
    (bool ok, bytes memory ret) = address(operationExecutor).call(_outer);
    require(ok, "relay reverted");
    txGas = RelayerTransaction.lastTxGas(_outer);
    priced = _pricedGas(abi.decode(ret, (uint256)) - DEPOSIT_SWEEP_TIP, DEPOSIT_SWEEP_TIP);
  }

  function _assertPaysNothing(address _target, bytes memory _call, address _feeRecipient) internal {
    uint256 potBefore = underlying.balanceOf(address(sm));
    uint256 recipientBefore = underlying.balanceOf(_feeRecipient);
    vm.prank(payer, payer);
    (bool ok,) = _target.call(_call);
    require(ok, "sweep reverted");

    assertEq(underlying.balanceOf(address(resweepSipa)), 0, "the sweep must still land");
    assertEq(
      underlying.balanceOf(_feeRecipient) - recipientBefore, DEPOSIT_SWEEP_TIP, "the fee recipient must get the fee"
    );
    assertEq(underlying.balanceOf(address(sm)), potBefore, "a sweep that is not a relayer transaction drew a subsidy");
  }

  function _executeCd(bytes memory _inner, IERC20 _payoutToken) internal view returns (bytes memory) {
    return abi.encodeCall(OperationExecutor.execute, (address(sm), _inner, _payoutToken, 0, 0, 0));
  }

  function _resweepCd(address _relayer, bytes memory _proofs) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy,
      (ISIPA(address(resweepSipa)), address(underlying), _relayer, resweepIntent, _proofs)
    );
  }

  function _deployCd(bytes memory _intentData) internal view returns (bytes memory) {
    return _deployCd(_intentData, "");
  }

  function _deployCd(bytes memory _intentData, bytes memory _proofs) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.deployAndSweepForSubsidy,
      (
        forwardingTable,
        SIPABase.Intent.Deposit,
        _recoveryCommitment("recovery"),
        true,
        address(underlying),
        address(operationExecutor),
        _intentData,
        _proofs
      )
    );
  }

  function _depositIntent(bytes32 _salt) internal pure returns (bytes memory) {
    return abi.encode(_field(_salt));
  }

  function _depositSIPA(bytes memory _intent) internal returns (DepositSIPA) {
    return DepositSIPA(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(_intent),
        _recoveryCommitment("recovery"),
        ROLLUP_VERSION,
        true,
        forwardingTable
      )
    );
  }

  function _predictDepositSIPA(bytes memory _intent) internal view returns (address) {
    return sipaFactory.predictSIPA(
      address(depositSIPAImplementation),
      keccak256(_intent),
      _recoveryCommitment("recovery"),
      ROLLUP_VERSION,
      true,
      forwardingTable
    );
  }

  function _warmInbox(uint256 _n) internal {
    DepositSIPA s = _depositSIPA(_depositIntent("inboxWarm"));
    for (uint256 i = 0; i < _n; i++) {
      underlying.mint(address(s), DEPOSIT);
      s.sweep(address(underlying), payer, _depositIntent("inboxWarm"), "");
    }
  }

  function _coolAll(address _sipa) internal {
    address[13] memory a = [
      _sipa,
      address(sipaFactory),
      address(depositSIPAImplementation),
      address(portal),
      address(forwardingTable),
      address(wiredInbox),
      address(rollup),
      address(registry),
      address(underlying),
      address(otherToken),
      address(sm),
      address(feed),
      address(operationExecutor)
    ];
    for (uint256 i = 0; i < a.length; i++) {
      VmCooling(address(vm)).cool(a[i]);
    }
  }
}

contract DepositSubsidyExecutorPathTest is DepositSubsidyExecutorPathFixture {
  function test_GivenAResweepRelayedByAnEOA_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(payer, address(resweepSipa), _resweepCd(address(operationExecutor), ""));
    console2.log("resweep through the executor: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAFirstSweepRelayedByAnEOA_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) = _relayFrom(payer, firstSipa, _deployCd(firstIntent));
    console2.log("first sweep through the executor: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenATypicalResweepRelay_ThenTheDepositCeilingSitsAtOrAboveIt() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrom(payer, address(resweepSipa), _resweepCd(address(operationExecutor), ""));
    uint256 chainCost = txGas + HARNESS_TO_CHAIN_RELAY;
    uint256 ceiling = sm.SWEEP_GAS_DEPOSIT_CEILING();
    console2.log("deposit resweep relay (chain)", chainCost, "ceiling", ceiling);
    assertGe(ceiling, chainCost, "SWEEP_GAS_DEPOSIT_CEILING sits under a typical resweep relay: it is clipped");
    assertLe(ceiling, (chainCost * 110) / 100, "SWEEP_GAS_DEPOSIT_CEILING has drifted well above a resweep relay");
  }

  function test_GivenATypicalFirstSweepRelay_ThenTheCeilingWithTheDeployAllowanceSitsAtOrAboveIt() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrom(payer, firstSipa, _deployCd(firstIntent));
    uint256 chainCost = txGas + HARNESS_TO_CHAIN_RELAY;
    uint256 ceiling = sm.SWEEP_GAS_DEPOSIT_CEILING() + sm.SWEEP_GAS_DEPLOY_ALLOWANCE();
    console2.log("deposit first sweep relay (chain)", chainCost, "ceiling", ceiling);
    assertGe(ceiling, chainCost, "the deploy allowance sits under a typical first sweep relay: it is clipped");
    assertLe(ceiling, (chainCost * 110) / 100, "the deploy allowance has drifted well above a first sweep relay");
  }

  function test_GivenAPayerWithNoBalance_ThenTheFreshBalanceIsPriced() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(freshPayer, address(resweepSipa), _resweepCd(address(operationExecutor), ""));
    console2.log("resweep to a fresh payer: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAPayerThatHoldsTheToken_WhenGasIsAtTheGuaranteedPrice_ThenTheRelayerTransactionExecutes()
    external
  {
    _assertExecutesAtTheGuaranteedPrice(payer);
  }

  function test_GivenAPayerWithNoBalance_WhenGasIsAtTheGuaranteedPrice_ThenTheRelayerTransactionExecutes() external {
    _assertExecutesAtTheGuaranteedPrice(freshPayer);
  }

  function _assertExecutesAtTheGuaranteedPrice(address _payer) internal {
    uint256 tokenWeiPerEth = uint256(PRICED_FEED_ANSWER) * 1e10;
    uint256 profit = Math.min(PRICED_MIN_PROFIT, DEPOSIT_SWEEP_TIP);
    uint256 gasPrice = (profit * 1e18) / ((UNDERPAY_TOLERANCE + RELAYER_CALLDATA_PADDING) * tokenWeiPerEth);
    vm.fee(gasPrice);
    vm.txGasPrice(gasPrice);
    bytes memory inner = _resweepCd(address(operationExecutor), "");

    uint256 snapshot = vm.snapshotState();
    (uint256 simulatedGas,) = _relayFrom(_payer, address(resweepSipa), inner);
    vm.revertToState(snapshot);
    uint256 gasToCover = simulatedGas + RELAYER_CALLDATA_PADDING;

    _coolAll(address(resweepSipa));
    VmCooling(address(vm)).cool(_payer);
    vm.prank(_payer, _payer);
    uint256 payout =
      operationExecutor.execute(address(sm), inner, IERC20(address(underlying)), 0, gasToCover, tokenWeiPerEth);

    uint256 gasCost = Math.mulDiv(gasToCover * gasPrice, tokenWeiPerEth, 1e18, Math.Rounding.Ceil);
    console2.log("guaranteed gas price", gasPrice, "gas to cover", gasToCover);
    assertGe(payout, gasCost, "the payout does not cover the relayer's gas at the guaranteed gas price");
  }

  function test_GivenAClippedFirstSweepToAPayerWithNoBalance_ThenTheFreshBalanceIsPaidOnTopOfTheCeiling() external {
    bytes memory padded = _deployCd(firstIntent, new bytes(16_384));
    uint256 ceiling = sm.SWEEP_GAS_DEPOSIT_CEILING() + sm.SWEEP_GAS_DEPLOY_ALLOWANCE();
    uint256 snapshot = vm.snapshotState();
    (, uint256 pricedForHolder) = _relayFrom(payer, firstSipa, padded);
    vm.revertToState(snapshot);
    (, uint256 pricedForFresh) = _relayFrom(freshPayer, firstSipa, padded);

    assertEq(pricedForHolder, ceiling, "the padded first sweep must reach the ceiling for the case to show anything");
    assertEq(pricedForFresh, ceiling + sm.FRESH_BALANCE_GAS(), "the ceiling clipped the fresh payer's balance write");
  }

  function test_GivenZeroPaddedProofs_ThenThePaddingIsPricedAtWhatItCosts() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(payer, address(resweepSipa), _resweepCd(address(operationExecutor), new bytes(1024)));
    console2.log("resweep with 1 KiB of zero proofs: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAContractRelayer_ThenTheSubsidyPaysNothing() external {
    bytes memory outer = _executeCd(_resweepCd(address(operationExecutor), ""), IERC20(address(underlying)));
    _assertPaysNothing(
      address(relayingContract),
      abi.encodeCall(RelayingContract.relay, (operationExecutor, outer)),
      address(relayingContract)
    );
  }

  function test_GivenARelayerOtherThanTheExecutor_ThenTheSubsidyPaysNothing() external {
    _assertPaysNothing(
      address(operationExecutor), _executeCd(_resweepCd(payer, ""), IERC20(address(underlying))), payer
    );
  }

  function test_GivenAnotherPayoutToken_ThenTheSubsidyPaysNothing() external {
    _assertPaysNothing(
      address(operationExecutor),
      _executeCd(_resweepCd(address(operationExecutor), ""), IERC20(address(otherToken))),
      address(operationExecutor)
    );
  }

  function test_GivenATargetThatCallsTheSubsidyItself_ThenTheSubsidyPaysNothing() external {
    SubsidyCallingTarget target = new SubsidyCallingTarget();
    bytes memory sweep = abi.encodeCall(SubsidyCallingTarget.sweep, (sm, _resweepCd(address(operationExecutor), "")));
    bytes memory outer =
      abi.encodeCall(OperationExecutor.execute, (address(target), sweep, IERC20(address(underlying)), 0, 0, 0));
    _assertPaysNothing(address(operationExecutor), outer, payer);
  }

  function test_GivenADirectSubsidyCall_ThenTheSubsidyPaysNothing() external {
    _assertPaysNothing(address(sm), _resweepCd(payer, ""), payer);
  }
}

contract DepositSubsidyDustedExecutorPathTest is DepositSubsidyExecutorPathFixture {
  function setUp() public virtual override {
    super.setUp();
    underlying.mint(address(operationExecutor), 1);
  }

  function test_GivenAnExecutorHoldingDust_ThenItsSmallerRefundIsPriced() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(payer, address(resweepSipa), _resweepCd(address(operationExecutor), ""));
    console2.log("resweep through a dusted executor: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }
}

contract DepositSubsidyDrainedExecutorPathTest is DepositSubsidyExecutorPathFixture {
  function setUp() public virtual override {
    super.setUp();
    underlying.mint(address(operationExecutor), 1);
    address drainer = makeAddr("drainer");
    vm.prank(drainer, drainer);
    operationExecutor.execute(
      address(underlying), abi.encodeCall(IERC20.transfer, (drainer, 1)), IERC20(address(otherToken)), 0, 0, 0
    );
  }

  function test_GivenASeedThatAnyoneDrained_ThenTheEmptyExecutorIsPriced() external {
    assertEq(underlying.balanceOf(address(operationExecutor)), 0, "the drainer must have taken the seed out");
    (uint256 txGas, uint256 priced) =
      _relayFrom(payer, address(resweepSipa), _resweepCd(address(operationExecutor), ""));
    console2.log("resweep through a drained executor: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }
}
