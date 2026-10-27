// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {ISIPA} from "@periphery/interfaces/ISIPA.sol";

import {DaiRelayForkFixture} from "@test/fork/DaiRelayForkFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {DEPOSIT_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";

interface VmCooling {
  function cool(address) external;
}

contract DepositSubsidyExecutorPathForkTest is DaiRelayForkFixture {
  uint256 internal constant DEPOSIT = 100 ether;
  uint256 internal constant STABLE_DEPOSIT = 100e6;
  bytes32 internal constant USDC_IMPLEMENTATION_SLOT =
    0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;
  uint256 internal constant UNDERPAY_TOLERANCE = 2000;
  uint256 internal constant FORK_TO_CHAIN_RELAY = 24_604;

  DepositSubsidy internal sm;
  address internal payer;

  bytes internal resweepIntent;
  DepositSIPA internal resweepSipa;
  bytes internal firstIntent;
  address internal firstSipa;

  bytes internal firstUsdcIntent;
  address internal firstUsdcSipa;
  bytes internal firstUsdtIntent;
  address internal firstUsdtSipa;
  bytes internal firstUsdcIdleDaiIntent;
  address internal firstUsdcIdleDaiSipa;
  bytes internal usdcResweepIntent;
  DepositSIPA internal usdcResweepSipa;
  bytes internal usdtResweepIntent;
  DepositSIPA internal usdtResweepSipa;
  bytes internal usdcIdleDaiIntent;
  DepositSIPA internal usdcIdleDaiSipa;
  bytes internal usdtIdleDaiIntent;
  DepositSIPA internal usdtIdleDaiSipa;

  function setUp() public override {
    super.setUp();
    sm = new DepositSubsidy(
      OWNER, address(portal), IOperationExecutor(address(operationExecutor)), CHAINLINK_ETH_USD, sipaFactory
    );
    _dealDai(address(sm), 1_000_000 ether);
    vm.prank(OWNER);
    sm.setDepositConfig(PRICED_MIN_PROFIT, type(uint128).max, 0);
    vm.fee(PRICED_BASEFEE);
    vm.txGasPrice(PRICED_BASEFEE);

    payer = makeAddr("payer");
    _dealDai(payer, 1);

    _warmInbox(8);

    resweepIntent = _depositIntent("resweep");
    resweepSipa = _depositSIPA(resweepIntent);
    _dealDai(address(resweepSipa), DEPOSIT);
    resweepSipa.sweep(address(DAI), payer, resweepIntent, "");
    _dealDai(address(resweepSipa), DEPOSIT);

    firstIntent = _depositIntent("first");
    firstSipa = _predictDepositSIPA(firstIntent);
    _dealDai(firstSipa, DEPOSIT);

    firstUsdcIntent = _depositIntent("first.usdc");
    firstUsdcSipa = _predictDepositSIPA(firstUsdcIntent);
    deal(address(USDC), firstUsdcSipa, STABLE_DEPOSIT);

    firstUsdtIntent = _depositIntent("first.usdt");
    firstUsdtSipa = _predictDepositSIPA(firstUsdtIntent);
    deal(address(USDT), firstUsdtSipa, STABLE_DEPOSIT);

    firstUsdcIdleDaiIntent = _depositIntent("first.idleDai.usdc");
    firstUsdcIdleDaiSipa = _predictDepositSIPA(firstUsdcIdleDaiIntent);
    deal(address(USDC), firstUsdcIdleDaiSipa, STABLE_DEPOSIT);
    _dealDai(firstUsdcIdleDaiSipa, DEPOSIT);

    usdcResweepIntent = _depositIntent("resweep.usdc");
    usdcResweepSipa = _sweptDepositSIPA(usdcResweepIntent);
    deal(address(USDC), address(usdcResweepSipa), STABLE_DEPOSIT);

    usdtResweepIntent = _depositIntent("resweep.usdt");
    usdtResweepSipa = _sweptDepositSIPA(usdtResweepIntent);
    deal(address(USDT), address(usdtResweepSipa), STABLE_DEPOSIT);

    usdcIdleDaiIntent = _depositIntent("idleDai.usdc");
    usdcIdleDaiSipa = _sweptDepositSIPA(usdcIdleDaiIntent);
    deal(address(USDC), address(usdcIdleDaiSipa), STABLE_DEPOSIT);
    _dealDai(address(usdcIdleDaiSipa), DEPOSIT);

    usdtIdleDaiIntent = _depositIntent("idleDai.usdt");
    usdtIdleDaiSipa = _sweptDepositSIPA(usdtIdleDaiIntent);
    deal(address(USDT), address(usdtIdleDaiSipa), STABLE_DEPOSIT);
    _dealDai(address(usdtIdleDaiSipa), DEPOSIT);
  }

  function test_GivenAResweepRelayedByAnEOA_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) = _relayFrom(address(resweepSipa), _resweepCd(resweepSipa, DAI, resweepIntent));
    console2.log("resweep on mainnet DAI and Chainlink: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAFirstSweepRelayedByAnEOA_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) = _relayFrom(firstSipa, _deployCd(DAI, firstIntent));
    console2.log("first sweep on mainnet DAI and Chainlink: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAFirstUsdcSweepRelayedByAnEOA_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) = _relayFrom(firstUsdcSipa, _deployCd(USDC, firstUsdcIntent));
    console2.log("first USDC sweep through the 3pool: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAFirstUsdtSweepRelayedByAnEOA_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) = _relayFrom(firstUsdtSipa, _deployCd(USDT, firstUsdtIntent));
    console2.log("first USDT sweep through the 3pool: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAFirstUsdcSweepOfASipaWithIdleDai_ThenItIsPricedAtMostAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) = _relayFrom(firstUsdcIdleDaiSipa, _deployCd(USDC, firstUsdcIdleDaiIntent));
    console2.log("first USDC sweep with idle DAI: tx gas", txGas, "priced", priced);
    assertLe(priced, txGas, "the subsidy priced more gas than the transaction used: a self-relay farms it");
  }

  function test_GivenAUsdcResweepRelayedByAnEOA_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(address(usdcResweepSipa), _resweepCd(usdcResweepSipa, USDC, usdcResweepIntent));
    console2.log("USDC resweep through the 3pool: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAUsdtResweepRelayedByAnEOA_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(address(usdtResweepSipa), _resweepCd(usdtResweepSipa, USDT, usdtResweepIntent));
    console2.log("USDT resweep through the 3pool: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAUsdcResweepOfASipaWithIdleDai_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(address(usdcIdleDaiSipa), _resweepCd(usdcIdleDaiSipa, USDC, usdcIdleDaiIntent));
    console2.log("USDC resweep with idle DAI: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenAUsdtResweepOfASipaWithIdleDai_ThenItIsPricedAtTheTransactionGas() external {
    (uint256 txGas, uint256 priced) =
      _relayFrom(address(usdtIdleDaiSipa), _resweepCd(usdtIdleDaiSipa, USDT, usdtIdleDaiIntent));
    console2.log("USDT resweep with idle DAI: tx gas", txGas, "priced", priced);
    _assertPricedAtTheTransactionGas(txGas, priced);
  }

  function test_GivenATypicalResweepRelay_ThenTheDepositCeilingSitsAtOrAboveIt() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrom(address(resweepSipa), _resweepCd(resweepSipa, DAI, resweepIntent));
    _assertCeilingSitsAtOrAbove("deposit resweep relay (chain)", txGas, sm.SWEEP_GAS_DEPOSIT_CEILING());
  }

  function test_GivenATypicalUsdcResweepRelay_ThenTheCeilingWithTheUsdcHopSitsAtOrAboveIt() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrom(address(usdcResweepSipa), _resweepCd(usdcResweepSipa, USDC, usdcResweepIntent));
    _assertCeilingSitsAtOrAbove(
      "USDC resweep relay (chain)", txGas, sm.SWEEP_GAS_DEPOSIT_CEILING() + sm.SWEEP_GAS_SWAP_USDC_HOP()
    );
  }

  function test_GivenATypicalUsdtResweepRelay_ThenTheCeilingWithTheUsdtHopSitsAtOrAboveIt() external {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrom(address(usdtResweepSipa), _resweepCd(usdtResweepSipa, USDT, usdtResweepIntent));
    _assertCeilingSitsAtOrAbove(
      "USDT resweep relay (chain)", txGas, sm.SWEEP_GAS_DEPOSIT_CEILING() + sm.SWEEP_GAS_SWAP_USDT_HOP()
    );
  }

  function test_GivenATypicalFirstUsdcSweepRelay_ThenTheCeilingWithTheDeployAllowanceAndTheUsdcHopSitsAtOrAboveIt()
    external
  {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrom(firstUsdcSipa, _deployCd(USDC, firstUsdcIntent));
    _assertCeilingSitsAtOrAbove(
      "first USDC sweep relay (chain)",
      txGas,
      sm.SWEEP_GAS_DEPOSIT_CEILING() + sm.SWEEP_GAS_DEPLOY_ALLOWANCE() + sm.SWEEP_GAS_SWAP_USDC_HOP()
    );
  }

  function test_GivenATypicalFirstUsdtSweepRelay_ThenTheCeilingWithTheDeployAllowanceAndTheUsdtHopSitsAtOrAboveIt()
    external
  {
    _openNextInboxBucket();
    (uint256 txGas,) = _relayFrom(firstUsdtSipa, _deployCd(USDT, firstUsdtIntent));
    _assertCeilingSitsAtOrAbove(
      "first USDT sweep relay (chain)",
      txGas,
      sm.SWEEP_GAS_DEPOSIT_CEILING() + sm.SWEEP_GAS_DEPLOY_ALLOWANCE() + sm.SWEEP_GAS_SWAP_USDT_HOP()
    );
  }

  function _assertCeilingSitsAtOrAbove(string memory _label, uint256 _txGas, uint256 _ceiling) internal pure {
    uint256 chainCost = _txGas + FORK_TO_CHAIN_RELAY;
    console2.log(_label, chainCost, "ceiling", _ceiling);
    assertGe(_ceiling, chainCost, string.concat(_label, ": the ceiling sits under a typical relay, so it is clipped"));
    assertLe(_ceiling, (chainCost * 110) / 100, string.concat(_label, ": the ceiling has drifted well above the relay"));
  }

  function _assertPricedAtTheTransactionGas(uint256 _txGas, uint256 _priced) internal pure {
    assertLe(_priced, _txGas, "the subsidy priced more gas than the transaction used: a self-relay farms it");
    assertGe(_priced + UNDERPAY_TOLERANCE, _txGas, "the subsidy priced well below the transaction gas");
  }

  function _relayFrom(address _sipa, bytes memory _inner) internal returns (uint256 txGas, uint256 priced) {
    bytes memory outer = abi.encodeCall(OperationExecutor.execute, (address(sm), _inner, DAI_TOKEN, 0, 0, 0));
    _coolAll(_sipa);
    VmCooling(address(vm)).cool(payer);
    vm.prank(payer, payer);
    (bool ok, bytes memory ret) = address(operationExecutor).call(outer);
    require(ok, "relay reverted");
    txGas = RelayerTransaction.lastTxGas(outer);
    uint256 subsidy = abi.decode(ret, (uint256)) - DEPOSIT_SWEEP_TIP;
    priced = (subsidy * 1e18) / (PRICED_BASEFEE * _chainlinkTokenWeiPerEth());
  }

  function _resweepCd(DepositSIPA _sipa, IERC20 _token, bytes memory _intent) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.sweepForSubsidy, (ISIPA(address(_sipa)), address(_token), address(operationExecutor), _intent, "")
    );
  }

  function _deployCd(IERC20 _token, bytes memory _intent) internal view returns (bytes memory) {
    return abi.encodeCall(
      DepositSubsidy.deployAndSweepForSubsidy,
      (
        forwardingTable,
        SIPABase.Intent.Deposit,
        _recoveryCommitment("recovery"),
        true,
        address(_token),
        address(operationExecutor),
        _intent,
        bytes("")
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

  function _sweptDepositSIPA(bytes memory _intent) internal returns (DepositSIPA sipa) {
    sipa = _depositSIPA(_intent);
    _dealDai(address(sipa), DEPOSIT);
    sipa.sweep(address(DAI), payer, _intent, "");
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
      _dealDai(address(s), DEPOSIT);
      s.sweep(address(DAI), payer, _depositIntent("inboxWarm"), "");
    }
  }

  function _coolAll(address _sipa) internal {
    address[17] memory a = [
      _sipa,
      address(sipaFactory),
      address(depositSIPAImplementation),
      address(portal),
      address(forwardingTable),
      address(wiredInbox),
      address(rollup),
      address(registry),
      address(DAI),
      address(sm),
      address(CHAINLINK_ETH_USD),
      chainlinkAggregator,
      address(operationExecutor),
      address(USDC),
      address(uint160(uint256(vm.load(address(USDC), USDC_IMPLEMENTATION_SLOT)))),
      address(USDT),
      address(THREE_POOL)
    ];
    for (uint256 i = 0; i < a.length; i++) {
      VmCooling(address(vm)).cool(a[i]);
    }
  }
}
