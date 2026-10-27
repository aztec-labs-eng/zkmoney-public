// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;

import {Ownable} from "@oz/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {ISIPA} from "./interfaces/ISIPA.sol";
import {IOperationExecutor} from "./interfaces/IOperationExecutor.sol";
import {SIPAFactory} from "./SIPAFactory.sol";
import {SIPABase} from "./SIPABase.sol";
import {IForwardingTable} from "./interfaces/IForwardingTable.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {USDC, USDT} from "./ThreePoolLib.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {EthUsdMinOutLib} from "./EthUsdMinOutLib.sol";
import {Errors} from "@periphery/Errors.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";

contract DepositSubsidy is Ownable, ReentrancyGuardTransient {
  using SafeERC20 for IERC20;

  // solhint-disable oxide/no-comments
  struct Config {
    // Relayer profit on top of the priced gas, in token units.
    uint128 targetRelayerProfit;
    // Maximum subsidy for one sweep, in token units.
    uint128 maxSubsidyPerOperation;
    // Minimum amount the portal credits on L2 for a sweep to get a subsidy, in token units.
    uint128 minCreditedAmount;
  }

  // What the subsidy reads during one call. _pricedGas prices the call from it.
  struct Meter {
    // Gas left when the call starts.
    uint256 startGas;
    // Gas that the call used from its start to the end of the sweep, the eligibility check and, for an eligible sweep,
    // the price feed read.
    uint256 frameGas;
    // The call deployed the SIPA, so the ceiling includes SWEEP_GAS_DEPLOY_ALLOWANCE.
    bool deployed;
    // The call is a relayer transaction: a code-free EOA sent the sweep through EXECUTOR, with the payout in TOKEN.
    // The subsidy pays only a relayer transaction, for all of its gas.
    bool relayerTransaction;
    // The executor held no TOKEN before the sweep. This selects the refund of the executor's TOKEN balance.
    bool executorStartedEmpty;
    // Gas that the executor used before it called the subsidy.
    uint256 executorHeadGas;
    // Gas of the calldata of this call. The transaction carries this calldata inside the executor call.
    uint256 calldataGas;
  }
  // solhint-enable oxide/no-comments

  address public immutable PORTAL;
  IERC20 public immutable TOKEN;
  uint8 public immutable TOKEN_DECIMALS;
  uint256 public immutable ROLLUP_VERSION;

  IOperationExecutor public immutable EXECUTOR;

  SIPAFactory public immutable SIPA_FACTORY;

  AggregatorV3Interface public immutable PRICE_FEED;

  uint256 internal constant MAX_PRICE_AGE = EthUsdMinOutLib.MAX_PRICE_AGE;

  uint8 public constant FEED_DECIMALS = 8;

  uint256 public constant SWEEP_GAS_DEPOSIT_CEILING = 290_000;
  uint256 public constant SWEEP_GAS_REGISTRATION_CEILING = 810_000;
  uint256 public constant SWEEP_GAS_USER_OP_CEILING = 740_000;

  uint256 public constant SWEEP_GAS_SWAP_USDC_HOP = 132_000;
  uint256 public constant SWEEP_GAS_SWAP_USDT_HOP = 136_000;

  uint256 public constant SWEEP_GAS_DEPLOY_ALLOWANCE = 82_000;

  // solhint-disable oxide/no-comments
  // Gas of a relayer transaction that no meter reads.
  // The base gas of every transaction.
  uint256 public constant TX_INTRINSIC_GAS = 21_000;
  // The executor's entry, the executor's calldata outside the sweep call, the call to the subsidy, the subsidy's
  // pricing and payment after frameGas, and the executor's payout to the relayer. DepositSubsidy.executorPath.t.sol
  // calibrates it against relayer transactions to a relayer that already holds TOKEN.
  uint256 public constant EXECUTOR_PATH_GAS = 32_500;
  // The executor's payout to a relayer that holds no TOKEN writes a new balance (20,000 gas) instead of changing one
  // (2,900 gas). EXECUTOR_PATH_GAS does not include this difference.
  uint256 public constant FRESH_BALANCE_GAS = 17_100;

  // EIP-3529 gas refunds for one storage slot. The EVM gives them back at the end of the transaction, and no contract
  // can read them, so the subsidy subtracts them from the gas that it measures. See "Gas refunds" in README.md.
  // A slot that held a value at the start of the transaction is zero at the end.
  uint256 public constant CLEARED_SLOT_REFUND = 4800;
  // A slot that was zero at the start of the transaction gets a value and goes back to zero: 20,000 - 100.
  uint256 public constant RESTORED_ZERO_SLOT_REFUND = 19_900;
  // A slot that held a value at the start of the transaction changes and goes back to that value: 5,000 - 2,100 - 100.
  uint256 public constant RESTORED_SLOT_REFUND = 2800;
  // solhint-enable oxide/no-comments

  Config public $depositConfig;

  event DepositConfigSet(uint128 targetRelayerProfit, uint128 maxSubsidyPerOperation, uint128 minCreditedAmount);

  constructor(
    address _owner,
    address _portal,
    IOperationExecutor _executor,
    AggregatorV3Interface _priceFeed,
    SIPAFactory _sipaFactory
  ) Ownable(_owner) {
    require(address(_priceFeed).code.length > 0, Errors.DepositSubsidy__FeedWithoutCode());
    // solhint-disable oxide/no-comments
    // The subsidy expects a Chainlink ETH/USD feed, which has 8 decimals.
    // solhint-enable oxide/no-comments
    uint8 feedDecimals = _priceFeed.decimals();
    require(feedDecimals == FEED_DECIMALS, Errors.DepositSubsidy__UnexpectedFeedDecimals(feedDecimals));

    PORTAL = _portal;
    EXECUTOR = _executor;
    SIPA_FACTORY = _sipaFactory;
    IERC20 token = IOxidePortal(_portal).UNDERLYING();
    TOKEN = token;
    TOKEN_DECIMALS = IERC20Metadata(address(token)).decimals();
    ROLLUP_VERSION = IOxidePortal(_portal).ROLLUP_VERSION();
    PRICE_FEED = _priceFeed;
  }

  function setDepositConfig(uint128 _targetRelayerProfit, uint128 _maxSubsidyPerOperation, uint128 _minCreditedAmount)
    external
    onlyOwner
  {
    $depositConfig = Config({
      targetRelayerProfit: _targetRelayerProfit,
      maxSubsidyPerOperation: _maxSubsidyPerOperation,
      minCreditedAmount: _minCreditedAmount
    });
    emit DepositConfigSet(_targetRelayerProfit, _maxSubsidyPerOperation, _minCreditedAmount);
  }

  function deployAndSweepForSubsidy(
    IForwardingTable _table,
    SIPABase.Intent _intent,
    bytes32 _recoveryCommitment,
    bool _resweepable,
    address _token,
    address _relayer,
    bytes calldata _intentData,
    bytes calldata _proofs
  ) external nonReentrant returns (uint256 subsidy) {
    Meter memory meter = _openMeter(gasleft(), _relayer);
    address sipa;
    (sipa, meter.deployed) =
      _deploySIPAIfAbsent(_table, _intent, keccak256(_intentData), _recoveryCommitment, _resweepable);
    subsidy = _sweepForSubsidy(ISIPA(sipa), _token, _relayer, _intentData, _proofs, meter);
  }

  function sweepForSubsidy(
    ISIPA _sipa,
    address _token,
    address _relayer,
    bytes calldata _intentData,
    bytes calldata _proofs
  ) external nonReentrant returns (uint256 subsidy) {
    Meter memory meter = _openMeter(gasleft(), _relayer);
    subsidy = _sweepForSubsidy(_sipa, _token, _relayer, _intentData, _proofs, meter);
  }

  function _openMeter(uint256 _startGas, address _relayer) internal view returns (Meter memory meter) {
    meter.startGas = _startGas;
    if (msg.sender != address(EXECUTOR) || _relayer != address(EXECUTOR)) {
      return meter;
    }
    IOperationExecutor.ExecutionContext memory context = EXECUTOR.executionContext();
    if (!context.direct || address(context.payoutToken) != address(TOKEN)) {
      return meter;
    }
    meter.relayerTransaction = true;
    meter.executorStartedEmpty = context.startedEmpty;
    meter.executorHeadGas = context.headGas;
    meter.calldataGas = _calldataGas();
  }

  function _sweepForSubsidy(
    ISIPA _sipa,
    address _token,
    address _relayer,
    bytes calldata _intentData,
    bytes calldata _proofs,
    Meter memory _meter
  ) internal returns (uint256 subsidy) {
    SIPABase.Intent intent = SIPA_FACTORY.sipaIntentOf(address(_sipa));
    require(intent != SIPABase.Intent.None, Errors.DepositSubsidy__NotASIPA(address(_sipa)));
    uint256 fee = _routedFee(_sipa);

    uint256 credited = _sweepAndMeasureCredit(_sipa, _token, _relayer, _intentData, _proofs);
    bool eligible = credited >= $depositConfig.minCreditedAmount && _meter.relayerTransaction
      && _sweepGasCeilingFor(intent, _token, _meter.deployed) != 0;
    uint256 tokenWeiPerEth = eligible ? _tokenWeiPerEth() : 0;
    _meter.frameGas = _meter.startGas - gasleft();
    uint256 pricedGas = eligible ? _pricedGas(intent, _token, _meter) : 0;
    subsidy = _quoteSubsidy(fee, pricedGas, tokenWeiPerEth);

    if (subsidy > 0) {
      TOKEN.safeTransfer(_relayer, subsidy);
    }
  }

  function _routedFee(ISIPA _sipa) internal view returns (uint256 fee) {
    IOxidePortal portal;
    (portal, fee,) = _sipa.route(address(TOKEN));
    require(address(portal) == PORTAL, Errors.DepositSubsidy__SIPABoundToAnotherPortal(address(_sipa)));
  }

  function _deploySIPAIfAbsent(
    IForwardingTable _table,
    SIPABase.Intent _intent,
    bytes32 _intentHash,
    bytes32 _recoveryCommitment,
    bool _resweepable
  ) internal returns (address sipa, bool deployed) {
    require(SIPA_FACTORY.approvedTable(address(_table)), Errors.DepositSubsidy__TableNotApproved(address(_table)));
    address implementation = SIPA_FACTORY.implementationFor(_intent);
    require(implementation != address(0), Errors.DepositSubsidy__NoImplementationForIntent(uint8(_intent)));

    sipa =
      SIPA_FACTORY.predictSIPA(implementation, _intentHash, _recoveryCommitment, ROLLUP_VERSION, _resweepable, _table);

    deployed = sipa.code.length == 0;
    if (deployed) {
      SIPA_FACTORY.deploySIPA(implementation, _intentHash, _recoveryCommitment, ROLLUP_VERSION, _resweepable, _table);
    }
  }

  function _sweepAndMeasureCredit(
    ISIPA _sipa,
    address _token,
    address _relayer,
    bytes calldata _intentData,
    bytes calldata _proofs
  ) internal returns (uint256) {
    uint256 portalBefore = TOKEN.balanceOf(PORTAL);
    _sipa.sweep(_token, _relayer, _intentData, _proofs);
    uint256 portalAfter = TOKEN.balanceOf(PORTAL);
    return portalAfter > portalBefore ? portalAfter - portalBefore : 0;
  }

  function _pricedGas(SIPABase.Intent _intent, address _token, Meter memory _meter) internal view returns (uint256) {
    uint256 ceiling = _sweepGasCeilingFor(_intent, _token, _meter.deployed);
    if (!_meter.relayerTransaction || ceiling == 0) {
      return 0;
    }
    // solhint-disable-next-line oxide/no-comments
    // A relayer transaction is paid its whole gas, so add the gas outside this call.
    uint256 gross = _meter.frameGas + TX_INTRINSIC_GAS + _meter.calldataGas + _meter.executorHeadGas + EXECUTOR_PATH_GAS;
    if (TOKEN.balanceOf(tx.origin) == 0) {
      // solhint-disable-next-line oxide/no-comments
      // The payout writes a new balance for a relayer with no TOKEN, outside the sweep, so the ceiling grows too.
      gross += FRESH_BALANCE_GAS;
      ceiling += FRESH_BALANCE_GAS;
    }
    // solhint-disable-next-line oxide/no-comments
    // The refunds of the sweep, and of the executor's TOKEN balance, which pays the fee and the subsidy out.
    uint256 refund =
      _sweepRefund(_token) + (_meter.executorStartedEmpty ? RESTORED_ZERO_SLOT_REFUND : RESTORED_SLOT_REFUND);
    // solhint-disable-next-line oxide/no-comments
    // The EVM gives back at most one fifth of the gas that the transaction used.
    refund = Math.min(refund, gross / 5);
    return Math.min(gross - refund, ceiling);
  }

  function _sweepRefund(address _token) internal view returns (uint256 refund) {
    // solhint-disable oxide/no-comments
    // The SIPA's TOKEN balance: cleared if the SIPA held TOKEN, or zero again if the swap brought TOKEN in.
    // The SIPA's allowance to the portal, which the portal spends in full.
    // solhint-enable oxide/no-comments
    refund = (_token == address(TOKEN) ? CLEARED_SLOT_REFUND : RESTORED_ZERO_SLOT_REFUND) + RESTORED_ZERO_SLOT_REFUND;
    if (_token != address(TOKEN)) {
      // solhint-disable-next-line oxide/no-comments
      // The SIPA's balance of the swapped token is cleared, and the 3pool spends the SIPA's allowance in full.
      refund += CLEARED_SLOT_REFUND + RESTORED_ZERO_SLOT_REFUND + RESTORED_ZERO_SLOT_REFUND;
    }
  }

  function _sweepGasCeilingFor(SIPABase.Intent _intent, address _token, bool _deployed)
    internal
    view
    returns (uint256)
  {
    uint256 ceiling;
    if (_intent == SIPABase.Intent.Deposit) {
      ceiling = SWEEP_GAS_DEPOSIT_CEILING;
    } else if (_intent == SIPABase.Intent.Registration) {
      ceiling = SWEEP_GAS_REGISTRATION_CEILING;
    } else if (_intent == SIPABase.Intent.UserOp) {
      ceiling = SWEEP_GAS_USER_OP_CEILING;
    } else {
      return 0;
    }
    if (_deployed) {
      ceiling += SWEEP_GAS_DEPLOY_ALLOWANCE;
    }
    if (_token == address(TOKEN)) {
      return ceiling;
    }
    if (_token == address(USDC)) {
      return ceiling + SWEEP_GAS_SWAP_USDC_HOP;
    }
    if (_token == address(USDT)) {
      return ceiling + SWEEP_GAS_SWAP_USDT_HOP;
    }
    return 0;
  }

  function _calldataGas() internal pure returns (uint256) {
    uint256 size = msg.data.length;
    uint256 nonZero;
    assembly ("memory-safe") {
      let lowBits := 0x0101010101010101010101010101010101010101010101010101010101010101
      for { let offset := 0 } lt(offset, size) { offset := add(offset, 32) } {
        let word := calldataload(offset)
        word := or(word, shr(4, word))
        word := or(word, shr(2, word))
        word := or(word, shr(1, word))
        nonZero := add(nonZero, shr(248, mul(and(word, lowBits), lowBits)))
      }
    }
    return nonZero * 16 + (size - nonZero) * 4;
  }

  function quoteSubsidy(uint256 _fee, uint256 _reimbursableGas) public view returns (uint256) {
    if (_reimbursableGas == 0) {
      return 0;
    }
    return _quoteSubsidy(_fee, _reimbursableGas, _tokenWeiPerEth());
  }

  function _quoteSubsidy(uint256 _fee, uint256 _reimbursableGas, uint256 _tokenPerEth) internal view returns (uint256) {
    Config memory cfg = $depositConfig;

    if (_reimbursableGas == 0) {
      return 0;
    }

    uint256 gasPrice = Math.min(tx.gasprice, block.basefee + OxideConstants.MAX_PRIORITY_FEE_WEI);

    uint256 gasCost = Math.mulDiv(_reimbursableGas * gasPrice, _tokenPerEth, 1e18);

    // solhint-disable oxide/no-comments
    // The fee caps the profit, so a farmer who relays their own sweep gains nothing. One targetRelayerProfit
    // applies to every SIPA implementation, and each implementation has its own DEPOSIT_FEE. Thus the cap is
    // here, for each sweep, and not in setDepositConfig.
    // solhint-enable oxide/no-comments
    uint256 targetPayout = gasCost + Math.min(cfg.targetRelayerProfit, _fee);
    if (targetPayout <= _fee) {
      return 0;
    }

    uint256 subsidy = Math.min(targetPayout - _fee, cfg.maxSubsidyPerOperation);
    return Math.min(subsidy, TOKEN.balanceOf(address(this)));
  }

  function _tokenWeiPerEth() internal view returns (uint256) {
    (, int256 usdPerEth,, uint256 updatedAt,) = PRICE_FEED.latestRoundData();
    if (usdPerEth < 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_PRICE_AGE) {
      return 0;
    }
    return Math.mulDiv(uint256(usdPerEth), 10 ** TOKEN_DECIMALS, 10 ** FEED_DECIMALS);
  }

  function defund() external onlyOwner {
    TOKEN.safeTransfer(owner(), TOKEN.balanceOf(address(this)));
  }
}
