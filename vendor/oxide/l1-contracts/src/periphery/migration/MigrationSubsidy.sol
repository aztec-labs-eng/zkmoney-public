// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;

import {Ownable} from "@oz/access/Ownable.sol";
import {ReentrancyGuardTransient} from "@oz/utils/ReentrancyGuardTransient.sol";
import {Address} from "@oz/utils/Address.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {Caps} from "@core/Caps.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {Errors} from "@periphery/Errors.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";

contract MigrationSubsidy is Ownable, ReentrancyGuardTransient {
  using SafeERC20 for IERC20;

  // solhint-disable oxide/no-comments
  // `targetRelayerProfit` is the relayer's whole profit. This subsidy expects to pay the relayer in full for the gas
  // of the transaction, so unlike PlainWithdrawalSubsidy, which leaves the profit to the wallet's tip and prices only
  // gas above a start price, this subsidy adds a fixed profit to each payment.
  // solhint-enable oxide/no-comments
  struct Config {
    uint128 targetRelayerProfit;
    uint128 maxSubsidyPerOperation;
    uint128 minMigratedAmount;
  }

  struct Meter {
    uint256 startGas;
    uint256 frameGas;
    bool relayerTransaction;
    bool operationExecutorStartedEmpty;
    uint256 operationExecutorStartBalance;
    bool operationExecutorCredited;
    bool migrationExecutorStartedEmpty;
    uint256 destinationCachedAvailable;
    bool destinationCapsCleared;
    uint256 executorHeadGas;
    uint256 calldataGas;
  }

  address public immutable SOURCE_PORTAL;
  address public immutable DESTINATION_PORTAL;
  address public immutable EXECUTOR;
  bytes32 public immutable OPERATION_EXECUTOR_CODEHASH;
  IERC20 public immutable TOKEN;
  uint8 public immutable TOKEN_DECIMALS;
  IERC20 public immutable ASSET;

  AggregatorV3Interface public immutable PRICE_FEED;
  uint256 internal constant MAX_PRICE_AGE = EthUsdMinOutLib.MAX_PRICE_AGE;

  uint8 public constant FEED_DECIMALS = 8;

  uint256 public constant WITHDRAWAL_GAS_CEILING = 427_000;
  uint256 public constant FROZEN_NOTES_REFUND_GAS_CEILING = 3_110_000;
  uint256 public constant FROZEN_DEPOSITS_REFUND_GAS_CEILING = 2_760_000;
  uint256 public constant UNPROCESSED_DEPOSIT_REFUND_GAS_CEILING = 2_830_000;

  uint256 public constant TX_INTRINSIC_GAS = 21_000;
  uint256 public constant EXIT_PATH_GAS = 31_700;
  uint256 public constant FRESH_BALANCE_GAS = 17_100;

  uint256 public constant RESTORED_ZERO_SLOT_REFUND = 19_900;
  uint256 public constant RESTORED_SLOT_REFUND = 2800;
  uint256 public constant CLEARED_SLOT_REFUND = 4800;

  Config public $config;

  address internal transient $relayExecutor;
  bool internal transient $recorded;
  IExecutor.Flow internal transient $recordedFlow;

  event ConfigSet(uint128 targetRelayerProfit, uint128 maxSubsidyPerOperation, uint128 minMigratedAmount);
  event Defunded(IERC20 indexed token, address indexed to, uint256 amount);

  constructor(
    address _owner,
    IERC20 _token,
    address _sourcePortal,
    address _destinationPortal,
    address _executor,
    bytes32 _operationExecutorCodeHash,
    AggregatorV3Interface _priceFeed
  ) Ownable(_owner) {
    require(address(_priceFeed).code.length > 0, Errors.MigrationSubsidy__FeedWithoutCode());
    uint8 feedDecimals = _priceFeed.decimals();
    require(feedDecimals == FEED_DECIMALS, Errors.MigrationSubsidy__UnexpectedFeedDecimals(feedDecimals));
    require(_executor != address(0), Errors.MigrationSubsidy__ZeroExecutor());
    SOURCE_PORTAL = _sourcePortal;
    DESTINATION_PORTAL = _destinationPortal;
    EXECUTOR = _executor;
    OPERATION_EXECUTOR_CODEHASH = _operationExecutorCodeHash;
    TOKEN = _token;
    TOKEN_DECIMALS = IERC20Metadata(address(_token)).decimals();
    ASSET = IOxidePortal(_sourcePortal).UNDERLYING();
    PRICE_FEED = _priceFeed;
  }

  function setConfig(uint128 _targetRelayerProfit, uint128 _maxSubsidyPerOperation, uint128 _minMigratedAmount)
    external
    onlyOwner
  {
    $config = Config({
      targetRelayerProfit: _targetRelayerProfit,
      maxSubsidyPerOperation: _maxSubsidyPerOperation,
      minMigratedAmount: _minMigratedAmount
    });
    emit ConfigSet(_targetRelayerProfit, _maxSubsidyPerOperation, _minMigratedAmount);
  }

  fallback(bytes calldata) external nonReentrant returns (bytes memory) {
    uint256 startGas = gasleft();
    require(
      msg.sender.codehash == OPERATION_EXECUTOR_CODEHASH, Errors.MigrationSubsidy__NotOperationExecutor(msg.sender)
    );
    Meter memory meter = _openMeter(startGas);
    if (meter.relayerTransaction) {
      $relayExecutor = msg.sender;
    }
    Address.functionCall(SOURCE_PORTAL, msg.data);
    bool recorded = $recorded;
    IExecutor.Flow flow = $recordedFlow;
    $relayExecutor = address(0);
    $recorded = false;
    if (!recorded) {
      return abi.encode(uint256(0));
    }

    uint256 tokenWeiPerEth = _tokenWeiPerEth();
    meter.operationExecutorCredited = TOKEN.balanceOf(msg.sender) != meter.operationExecutorStartBalance;
    meter.destinationCapsCleared =
      meter.destinationCachedAvailable != 0 && Caps(DESTINATION_PORTAL).$cachedAvailable() == 0;
    meter.frameGas = meter.startGas - gasleft();
    uint256 subsidy = _quoteSubsidy(_pricedGas(flow, meter), tokenWeiPerEth);
    if (subsidy > 0) {
      TOKEN.safeTransfer(msg.sender, subsidy);
    }
    return abi.encode(subsidy);
  }

  // solhint-disable oxide/no-comments
  // This contract forwards the relayer's calldata to the old portal without reading it, so it cannot tell on its own
  // whether the call migrated anything, which flow ran, or how much moved. `recordMigration` is how the executor
  // reports them back.
  // solhint-enable oxide/no-comments
  function recordMigration(IExecutor.Flow _flow, uint256 _migrated) external {
    require(msg.sender == EXECUTOR, Errors.MigrationSubsidy__UnauthorizedExecutor());
    if ($relayExecutor != address(0) && _migrated >= $config.minMigratedAmount) {
      $recorded = true;
      $recordedFlow = _flow;
    }
  }

  function migrationGasCeiling(IExecutor.Flow _flow) public pure returns (uint256) {
    if (_flow == IExecutor.Flow.Withdrawal) {
      return WITHDRAWAL_GAS_CEILING;
    }
    if (_flow == IExecutor.Flow.FrozenNotesRefund) {
      return FROZEN_NOTES_REFUND_GAS_CEILING;
    }
    if (_flow == IExecutor.Flow.FrozenDepositsRefund) {
      return FROZEN_DEPOSITS_REFUND_GAS_CEILING;
    }
    return UNPROCESSED_DEPOSIT_REFUND_GAS_CEILING;
  }

  function defund(IERC20 _token) external onlyOwner {
    address to = owner();
    uint256 amount = _token.balanceOf(address(this));
    _token.safeTransfer(to, amount);
    emit Defunded(_token, to, amount);
  }

  function _openMeter(uint256 _startGas) internal view returns (Meter memory meter) {
    meter.startGas = _startGas;
    IOperationExecutor.ExecutionContext memory context = IOperationExecutor(msg.sender).executionContext();
    if (!context.direct || address(context.payoutToken) != address(TOKEN) || !_sourceFrozen()) {
      return meter;
    }
    meter.relayerTransaction = true;
    meter.operationExecutorStartedEmpty = context.startedEmpty;
    meter.executorHeadGas = context.headGas;
    meter.calldataGas = _calldataGas();
    meter.operationExecutorStartBalance = TOKEN.balanceOf(msg.sender);
    meter.migrationExecutorStartedEmpty = ASSET.balanceOf(EXECUTOR) == 0;
    meter.destinationCachedAvailable = Caps(DESTINATION_PORTAL).$cachedAvailable();
  }

  function _relayerHoldsNoToken() internal view returns (bool) {
    return TOKEN.balanceOf(tx.origin) == 0;
  }

  // solhint-disable oxide/no-comments
  // Subsidy is paid only when the old portal is frozen. Before the freeze a deposit into the old portal and a
  // withdrawal back out through this executor would form a cycle that a farmer could run against the pot.
  // solhint-enable oxide/no-comments
  function _sourceFrozen() internal view returns (bool) {
    return IOxidePortal(SOURCE_PORTAL).$frozen();
  }

  function _pricedGas(IExecutor.Flow _flow, Meter memory _meter) internal view returns (uint256) {
    uint256 ceiling = migrationGasCeiling(_flow);
    uint256 gross = _meter.frameGas + TX_INTRINSIC_GAS + _meter.calldataGas + _meter.executorHeadGas + EXIT_PATH_GAS;
    if (_relayerHoldsNoToken()) {
      gross += FRESH_BALANCE_GAS;
      ceiling += FRESH_BALANCE_GAS;
    }
    uint256 operationExecutorRefund =
      _meter.operationExecutorStartedEmpty ? RESTORED_ZERO_SLOT_REFUND : RESTORED_SLOT_REFUND;
    if (!_meter.operationExecutorCredited) {
      gross += operationExecutorRefund;
    }
    uint256 refund = operationExecutorRefund
      + (_meter.migrationExecutorStartedEmpty ? RESTORED_ZERO_SLOT_REFUND : RESTORED_SLOT_REFUND);
    if (_meter.destinationCapsCleared) {
      refund += CLEARED_SLOT_REFUND;
    }
    refund = Math.min(refund, gross / 5);
    return Math.min(gross - refund, ceiling);
  }

  function _quoteSubsidy(uint256 _gas, uint256 _tokenPerEth) internal view returns (uint256) {
    if (_gas == 0 || _tokenPerEth == 0) {
      return 0;
    }
    Config memory cfg = $config;
    uint256 gasCost = Math.mulDiv(_gas * _cappedGasPrice(), _tokenPerEth, 1e18);
    uint256 subsidy = Math.min(gasCost + cfg.targetRelayerProfit, cfg.maxSubsidyPerOperation);
    return Math.min(subsidy, TOKEN.balanceOf(address(this)));
  }

  function _cappedGasPrice() internal view returns (uint256) {
    return Math.min(tx.gasprice, block.basefee + OxideConstants.MAX_PRIORITY_FEE_WEI);
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

  function _tokenWeiPerEth() internal view returns (uint256) {
    (, int256 usdPerEth,, uint256 updatedAt,) = PRICE_FEED.latestRoundData();
    if (usdPerEth < 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_PRICE_AGE) {
      return 0;
    }
    return Math.mulDiv(uint256(usdPerEth), 10 ** TOKEN_DECIMALS, 10 ** FEED_DECIMALS);
  }
}
