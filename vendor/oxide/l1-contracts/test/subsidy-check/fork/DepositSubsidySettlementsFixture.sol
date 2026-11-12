// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {IERC20 as IERC20OZ} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {Intents} from "@periphery/Intent.sol";
import {DepositSubsidyGasRowsFixture} from "@test/subsidy-check/fork/DepositSubsidyGasRowsFixture.sol";
import {RelayerCoverRule} from "@test/subsidy-check/fork/RelayerCoverRule.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";

interface IShares {
  function convertToAssets(uint256 _shares) external view returns (uint256);
}

abstract contract DepositSubsidySettlementsFixture is DepositSubsidyGasRowsFixture {
  uint256 internal constant BASE_FEE = 5 gwei;
  uint256 internal constant TIP = OxideConstants.MAX_PRIORITY_FEE_WEI;
  uint256 internal constant CORNER_USD_PER_ETH = 5000e8;
  uint256 internal constant FEED_TO_TOKEN_WEI = 1e10;

  struct Settlement {
    IERC20OZ token;
    uint256 fee;
    uint128 profit;
    uint128 cap;
    uint256 potBefore;
    uint256 subsidyTokenWeiPerEth;
    uint256 gasPrice;
    uint256 pricedGasPrice;
    uint256 escalations;
    uint256 simulatedPayout;
    uint256 zeroCoverGas;
    uint256 zeroCoverGross;
    uint256 zeroCoverRefund;
    uint256 simulatedGas;
    uint256 confirmationLimit;
    uint256 gasToCover;
    uint256 tokenWeiPerEth;
    uint256 quoted;
    bool sent;
    uint256 payout;
  }

  struct Corner {
    uint256 priced;
    uint256 chainCover;
    uint256 chainPriced;
    uint256 subsidy;
    uint256 payout;
    uint256 required;
  }

  uint256 internal lastGross;
  uint256 internal lastRefund;

  function setUp() public virtual override {
    super.setUp();
    _applyDepositPolicy(daiSubsidy, "bridges/brg-dai-v6.json");
    _applyDepositPolicy(susdsSubsidy, "bridges/brg-susds-v6.json");
    _assertTheFeesAreTheSeedFees();
    vm.fee(BASE_FEE);
    vm.txGasPrice(BASE_FEE + TIP);
  }

  function _applyDepositPolicy(DepositSubsidy _subsidy, string memory _bridge) internal {
    string memory json = _seed(_bridge);
    uint256 profit = vm.parseJsonUint(json, ".policies.deposits.targetRelayerProfit");
    uint256 cap = vm.parseJsonUint(json, ".policies.deposits.maxSubsidyPerOperation");
    uint256 minCredit = vm.parseJsonUint(json, ".policies.deposits.minCreditedAmount");
    vm.prank(OWNER);
    _subsidy.setDepositConfig(uint128(profit), uint128(cap), uint128(minCredit));
  }

  function _assertTheFeesAreTheSeedFees() internal view {
    string memory json = _seed("forwarding-tables/ftb-v6a.json");
    assertEq(DAI_DEPOSIT_SWEEP_TIP, vm.parseJsonUint(json, ".rows.dai.intents.deposit.sweepTip"), "DAI deposit tip");
    assertEq(
      DAI_DEPOSIT_BENEFICIARY_FEE,
      vm.parseJsonUint(json, ".rows.dai.intents.deposit.beneficiaryFee"),
      "DAI deposit beneficiary fee"
    );
    assertEq(
      DAI_REGISTRATION_SWEEP_TIP, vm.parseJsonUint(json, ".rows.dai.intents.registration.sweepTip"), "registration tip"
    );
    assertEq(SUSDS_DEPOSIT_SWEEP_TIP, vm.parseJsonUint(json, ".rows.susds.intents.deposit.sweepTip"), "sUSDS tip");
  }

  function _outer(
    Relay memory _r,
    Settlement memory _s,
    uint256 _minPayout,
    uint256 _gasToCover,
    uint256 _tokenWeiPerEth
  ) internal pure returns (bytes memory) {
    return abi.encodeCall(
      OperationExecutor.execute, (address(_r.subsidy), _r.inner, _s.token, _minPayout, _gasToCover, _tokenWeiPerEth)
    );
  }

  function _send(address _from, address _sipa, bytes memory _outerCall, uint256 _limit)
    internal
    returns (bool ok, uint256 payout, uint256 txGas)
  {
    _coolAll(_sipa);
    vm.prank(_from, _from);
    bytes memory ret;
    (ok, ret) = address(operationExecutor).call{gas: _limit}(_outerCall);
    if (ok) {
      Vm.Gas memory g = vm.lastCallGas();
      lastGross = g.gasTotalUsed;
      lastRefund = uint256(int256(g.gasRefunded));
      payout = abi.decode(ret, (uint256));
      txGas = RelayerTransaction.lastIsolatedTxGas();
    }
  }

  function _ethUsd18() internal view returns (uint256) {
    (, int256 usdPerEth,,,) = CHAINLINK_ETH_USD.latestRoundData();
    return uint256(usdPerEth) * FEED_TO_TOKEN_WEI;
  }

  function _tokenUsd18(IERC20 _token) internal view returns (uint256) {
    return address(_token) == address(SUSDS) ? IShares(address(SUSDS)).convertToAssets(1e18) : 1e18;
  }

  function _quote(string memory _row, address _relayer) internal returns (Relay memory r, Settlement memory s) {
    r = relays[_row];
    _openNextInboxBucket();
    uint256 snapshot = vm.snapshotState();
    _readBeforeTheRelay(r, s);
    vm.revertToState(snapshot);
    _simulate(r, s, _relayer, snapshot);
    s.quoted = RelayerCoverRule.quotedGasCost(s.gasToCover, s.gasPrice, s.tokenWeiPerEth);
  }

  function _settle(string memory _row, address _relayer) internal returns (Relay memory r, Settlement memory s) {
    (r, s) = _quote(_row, _relayer);
    if (s.simulatedPayout >= s.quoted) {
      _submit(r, s, _relayer);
    }
  }

  function _readBeforeTheRelay(Relay memory _r, Settlement memory _s) internal view {
    _s.token = IERC20OZ(address(_r.subsidy.TOKEN()));
    (,,, uint128 tip) = forwardingTable.rowFor(address(_s.token), _r.intent);
    _s.fee = tip;
    (_s.profit, _s.cap,) = _r.subsidy.$depositConfig();
    _s.potBefore = _s.token.balanceOf(address(_r.subsidy));
    _s.tokenWeiPerEth = RelayerCoverRule.tokenWeiPerEth(_ethUsd18(), 18, _tokenUsd18(IERC20(address(_s.token))));
    _s.subsidyTokenWeiPerEth = _chainlinkTokenWeiPerEth();
    _s.gasPrice = tx.gasprice;
    _s.pricedGasPrice = Math.min(tx.gasprice, block.basefee + TIP);
  }

  function _simulate(Relay memory _r, Settlement memory _s, address _relayer, uint256 _snapshot) internal {
    bool ok;
    (ok, _s.simulatedPayout, _s.zeroCoverGas) =
      _send(_relayer, _r.sipa, _outer(_r, _s, 0, 0, 0), RelayerCoverRule.SIMULATION_GAS_LIMIT);
    require(ok, "the payout simulation reverted");
    _s.zeroCoverGross = lastGross;
    _s.zeroCoverRefund = lastRefund;
    vm.revertToState(_snapshot);

    bytes memory withPayout = _outer(_r, _s, _s.simulatedPayout, 0, 0);
    (ok,, _s.simulatedGas) = _send(_relayer, _r.sipa, withPayout, RelayerCoverRule.SIMULATION_GAS_LIMIT);
    require(ok, "the gas simulation reverted");
    vm.revertToState(_snapshot);

    _s.confirmationLimit = RelayerCoverRule.confirmationLimit(_s.simulatedGas);
    (ok,,) = _send(_relayer, _r.sipa, withPayout, _s.confirmationLimit);
    vm.revertToState(_snapshot);
    while (!ok) {
      require(_s.confirmationLimit < RelayerCoverRule.SIMULATION_GAS_LIMIT, "no gas limit confirms the relay");
      _s.confirmationLimit = Math.min(2 * _s.confirmationLimit, RelayerCoverRule.SIMULATION_GAS_LIMIT);
      _s.escalations++;
      (ok,,) = _send(_relayer, _r.sipa, withPayout, _s.confirmationLimit);
      vm.revertToState(_snapshot);
    }
    _s.gasToCover = RelayerCoverRule.gasToCover(_s.simulatedGas, RelayerCoverRule.submissionLimit(_s.confirmationLimit));
  }

  function _submit(Relay memory _r, Settlement memory _s, address _relayer) internal {
    bytes memory submitted = _outer(_r, _s, 0, _s.gasToCover, _s.tokenWeiPerEth);
    bool ok;
    (ok, _s.payout,) = _send(_relayer, _r.sipa, submitted, RelayerCoverRule.submissionLimit(_s.confirmationLimit));
    assertTrue(ok, "the executor refuses the relayer's transaction");
    _s.sent = true;
  }

  function _assertSettles(string memory _row) internal returns (Relay memory r, Settlement memory s) {
    (r, s) = _settle(_row, gasRelayer);
    console2.log("settlement", _row);
    console2.log("  zero-cover gas", s.zeroCoverGas, "simulated gas", s.simulatedGas);
    console2.log("  gas to cover", s.gasToCover, "quoted", s.quoted);
    console2.log("  simulated payout", s.simulatedPayout, "payout", s.payout);
    console2.log("  zero-cover gross", s.zeroCoverGross, "zero-cover refund", s.zeroCoverRefund);
    console2.log("  confirmation limit", s.confirmationLimit, "escalations", s.escalations);
    assertEq(s.escalations, 0, "the relayer's first gas limit does not confirm, so it raises the limit");
    assertTrue(s.sent, "the relayer defers this flow at the fork's ETH price");
    assertGe(s.simulatedPayout, s.quoted + 1, "the payout does not clear the relayer's cost by 1 token-wei");
    assertGe(s.payout, s.quoted + 1, "the submitted payout does not clear the relayer's cost by 1 token-wei");
  }

  function _corner(Relay memory _r, Settlement memory _s) internal returns (Corner memory c) {
    c.priced = _readBackPricedGas(_s);
    string memory json = vm.readFile(GAS_ROWS);
    c.chainCover = Math.max(_s.zeroCoverGas + vm.parseJsonUint(json, ".relayerCalldataPadding"), _s.gasToCover);
    c.chainPriced = c.priced;

    vm.mockCall(
      address(CHAINLINK_ETH_USD),
      abi.encodeWithSelector(AggregatorV3Interface.latestRoundData.selector),
      abi.encode(uint80(1), int256(CORNER_USD_PER_ETH), block.timestamp, block.timestamp, uint80(1))
    );
    c.subsidy = _r.subsidy.quoteSubsidy(_s.fee, c.chainPriced);
    assertGt(c.subsidy, 0, "no subsidy at the corner: the corner pays on another path than the measurement");
    assertLt(c.subsidy, _s.token.balanceOf(address(_r.subsidy)), "the pot binds at the corner");
    c.payout = _s.fee + c.subsidy;
    c.required =
      RelayerCoverRule.quotedGasCost(c.chainCover, BASE_FEE + TIP, CORNER_USD_PER_ETH * FEED_TO_TOKEN_WEI) + 1;
    console2.log("  fork priced", c.priced, "estimated refund", _maxRefundEstimate(_r.subsidy, _r.input));
    console2.log("  chain cover", c.chainCover, "chain priced", c.chainPriced);
    console2.log("  corner payout", c.payout, "corner required", c.required);
  }

  function _readBackPricedGas(Settlement memory _s) internal pure returns (uint256) {
    uint256 simulatedSubsidy = _s.simulatedPayout - _s.fee;
    assertGt(simulatedSubsidy, 0, "no subsidy at the fork's price: the corner pays on another path");
    assertLt(simulatedSubsidy, _s.cap, "the cap bounds the subsidy, so its priced gas cannot be read back");
    assertLt(simulatedSubsidy, _s.potBefore, "the pot bounds the subsidy, so its priced gas cannot be read back");
    uint256 price = _s.pricedGasPrice;
    uint256 gasCost = _s.simulatedPayout - Math.min(_s.profit, _s.fee);
    uint256 priced = Math.mulDiv(gasCost, 1e18, price * _s.subsidyTokenWeiPerEth, Math.Rounding.Ceil);
    assertEq(Math.mulDiv(priced * price, _s.subsidyTokenWeiPerEth, 1e18), gasCost, "the payout is not whole gas");
    return priced;
  }

  function _assertLiveAtTheCorner(string memory _row) internal {
    (Relay memory r, Settlement memory s) = _assertSettles(_row);
    Corner memory c = _corner(r, s);
    assertGe(c.payout, c.required, "the flow is not live at the target corner on its measured chain gas");
  }

  function _assertShortAtTheCorner(string memory _row, bool _escalates) internal {
    (Relay memory r, Settlement memory s) = _settle(_row, gasRelayer);
    console2.log("settlement", _row);
    console2.log("  zero-cover gas", s.zeroCoverGas, "simulated gas", s.simulatedGas);
    console2.log("  gas to cover", s.gasToCover, "quoted", s.quoted);
    console2.log("  zero-cover gross", s.zeroCoverGross, "zero-cover refund", s.zeroCoverRefund);
    console2.log("  confirmation limit", s.confirmationLimit, "escalations", s.escalations);
    assertEq(s.escalations > 0, _escalates, "the gap's issue does not state whether the relayer raises its gas limit");
    Corner memory c = _corner(r, s);
    assertLt(c.payout, c.required, "a known gap is live at the corner: remove it from flows.SETTLEMENT_GAP_FLOWS");
  }

  function _farmingGain(string memory _row) internal returns (int256 gain, uint256 paid) {
    Relay memory r = relays[_row];
    _openNextInboxBucket();
    uint256 snapshot = vm.snapshotState();
    Settlement memory s;
    _readBeforeTheRelay(r, s);
    uint256 tokenUsd = _tokenUsd18(IERC20(address(s.token)));
    uint256 ethUsd = _ethUsd18();
    vm.revertToState(snapshot);
    (bool ok,, uint256 txGas) = _send(holderRelayer, r.sipa, r.outer, RelayerCoverRule.SIMULATION_GAS_LIMIT);
    require(ok, "the farmer's relay reverted");
    paid = s.potBefore - s.token.balanceOf(address(r.subsidy));
    uint256 value = paid * tokenUsd / 1e18;
    uint256 cost = txGas * tx.gasprice * ethUsd / 1e18;
    gain = int256(value) - int256(cost);
    console2.log("farming", _row);
    console2.log("  paid", paid, "tx gas", txGas);
    console2.log("  value", value, "gas cost", cost);
  }

  function _assertGainsNothing(string memory _row) internal {
    (int256 gain, uint256 paid) = _farmingGain(_row);
    assertGt(paid, 0, "the farmer's relay got no subsidy, so the check tests nothing");
    assertLe(gain, 0, "a relayer that holds the token gains from relaying its own sweep");
  }

  function _assertFarms(string memory _row) internal {
    (int256 gain,) = _farmingGain(_row);
    assertGt(gain, 0, "a known farming gap gains nothing: remove it from flows.FARMING_GAP_FLOWS");
  }
}
