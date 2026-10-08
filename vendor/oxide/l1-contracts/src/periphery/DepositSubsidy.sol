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
import {SIPAFactory} from "./SIPAFactory.sol";
import {SIPABase} from "./SIPABase.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {USDC, USDT} from "./ThreePoolLib.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {Errors} from "@periphery/Errors.sol";

contract DepositSubsidy is Ownable, ReentrancyGuardTransient {
  using SafeERC20 for IERC20;

  // solhint-disable oxide/no-comments
  struct Config {
    // Relayer profit on top of the priced gas, in token units. Must not be more than minFee.
    uint128 approximateMinProfit;
    // Maximum subsidy for one sweep, in token units.
    uint128 max;
    // Minimum SIPA fee for a sweep to get a subsidy, in token units.
    uint128 minFee;
    // Minimum amount the portal credits on L2 for a sweep to get a subsidy, in token units.
    uint128 minCreditedAmount;
    // Gas added to each subsidized sweep for the costs that the meter does not see.
    uint128 overheadGas;
  }
  // solhint-enable oxide/no-comments

  address public immutable PORTAL;
  IERC20 public immutable TOKEN;
  uint8 public immutable TOKEN_DECIMALS;
  uint256 public immutable ROLLUP_VERSION;

  SIPAFactory public immutable SIPA_FACTORY;

  AggregatorV3Interface public immutable PRICE_FEED;

  uint256 internal constant MAX_PRICE_AGE = 1 hours;

  uint8 internal constant MAX_FEED_DECIMALS = 77;

  uint256 public constant REFUND_ALLOWANCE = 60_000;

  uint256 public constant SWEEP_GAS_DEPOSIT_CEILING = 202_000;
  uint256 public constant SWEEP_GAS_REGISTRATION_CEILING = 740_000;
  uint256 public constant SWEEP_GAS_METADATA_UPDATE_CEILING = 600_000;

  uint256 public constant SWEEP_GAS_SWAP_USDC_HOP = 126_000;
  uint256 public constant SWEEP_GAS_SWAP_USDT_HOP = 129_000;

  uint256 public constant SWEEP_GAS_DEPLOY_ALLOWANCE = 66_000;

  Config public $depositConfig;

  event DepositConfigSet(
    uint128 approximateMinProfit, uint128 max, uint128 minFee, uint128 minCreditedAmount, uint128 overheadGas
  );

  constructor(address _owner, address _portal, AggregatorV3Interface _priceFeed, SIPAFactory _sipaFactory)
    Ownable(_owner)
  {
    require(address(_priceFeed).code.length > 0, Errors.DepositSubsidy__FeedWithoutCode());

    PORTAL = _portal;
    SIPA_FACTORY = _sipaFactory;
    IERC20 token = IOxidePortal(_portal).UNDERLYING();
    TOKEN = token;
    TOKEN_DECIMALS = IERC20Metadata(address(token)).decimals();
    ROLLUP_VERSION = IOxidePortal(_portal).ROLLUP_VERSION();
    PRICE_FEED = _priceFeed;
  }

  function setDepositConfig(
    uint128 _approximateMinProfit,
    uint128 _max,
    uint128 _minFee,
    uint128 _minCreditedAmount,
    uint128 _overheadGas
  ) external onlyOwner {
    require(
      _approximateMinProfit <= _minFee, Errors.DepositSubsidy__ProfitAboveFeeFloor(_approximateMinProfit, _minFee)
    );

    $depositConfig = Config({
      approximateMinProfit: _approximateMinProfit,
      max: _max,
      minFee: _minFee,
      minCreditedAmount: _minCreditedAmount,
      overheadGas: _overheadGas
    });
    emit DepositConfigSet(_approximateMinProfit, _max, _minFee, _minCreditedAmount, _overheadGas);
  }

  function deployAndSweepForSubsidy(
    SIPABase.Intent _intent,
    bytes32 _recoveryCommitment,
    bool _resweepable,
    address _token,
    address _relayer,
    bytes calldata _intentData,
    bytes calldata _proofs
  ) external nonReentrant returns (uint256 subsidy) {
    uint256 startGas = gasleft();
    (address sipa, bool deployed) =
      _deploySIPAIfAbsent(_intent, keccak256(_intentData), _recoveryCommitment, _resweepable);
    subsidy = _sweepForSubsidy(ISIPA(sipa), _token, _relayer, _intentData, _proofs, startGas, deployed);
  }

  function sweepForSubsidy(
    ISIPA _sipa,
    address _token,
    address _relayer,
    bytes calldata _intentData,
    bytes calldata _proofs
  ) external nonReentrant returns (uint256 subsidy) {
    uint256 startGas = gasleft();
    subsidy = _sweepForSubsidy(_sipa, _token, _relayer, _intentData, _proofs, startGas, false);
  }

  function _sweepForSubsidy(
    ISIPA _sipa,
    address _token,
    address _relayer,
    bytes calldata _intentData,
    bytes calldata _proofs,
    uint256 _startGas,
    bool _deployed
  ) internal returns (uint256 subsidy) {
    SIPABase.Intent intent = SIPA_FACTORY.sipaIntentOf(address(_sipa));
    require(intent != SIPABase.Intent.None, Errors.DepositSubsidy__NotASIPA(address(_sipa)));
    require(address(_sipa.portal()) == PORTAL, Errors.DepositSubsidy__SIPABoundToAnotherPortal(address(_sipa)));

    uint256 fee = _sipa.depositFee();
    uint256 credited = _sweepAndMeasureCredit(_sipa, _token, _relayer, _intentData, _proofs);
    uint256 sweepGas = credited >= $depositConfig.minCreditedAmount
      ? _pricedSweepGas(intent, _token, _deployed, _startGas - gasleft())
      : 0;
    subsidy = quoteSubsidy(fee, sweepGas);

    if (subsidy > 0) {
      TOKEN.safeTransfer(_relayer, subsidy);
    }
  }

  function _deploySIPAIfAbsent(
    SIPABase.Intent _intent,
    bytes32 _intentHash,
    bytes32 _recoveryCommitment,
    bool _resweepable
  ) internal returns (address sipa, bool deployed) {
    address implementation = SIPA_FACTORY.implementationFor(PORTAL, _intent);
    require(implementation != address(0), Errors.DepositSubsidy__NoImplementationForIntent(uint8(_intent)));

    sipa = SIPA_FACTORY.predictSIPA(implementation, _intentHash, _recoveryCommitment, ROLLUP_VERSION, _resweepable);

    deployed = sipa.code.length == 0;
    if (deployed) {
      SIPA_FACTORY.deploySIPA(implementation, _intentHash, _recoveryCommitment, ROLLUP_VERSION, _resweepable);
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

  function _pricedSweepGas(SIPABase.Intent _intent, address _token, bool _deployed, uint256 _measured)
    internal
    view
    returns (uint256)
  {
    uint256 ceiling = _sweepGasCeilingFor(_intent, _token, _deployed);
    if (ceiling == 0) {
      return 0;
    }
    return Math.min(_measured - Math.min(REFUND_ALLOWANCE, _measured / 5), ceiling) + $depositConfig.overheadGas;
  }

  function _sweepGasCeilingFor(SIPABase.Intent _intent, address _token, bool _deployed)
    internal
    view
    returns (uint256)
  {
    uint256 ceiling = _intent == SIPABase.Intent.Registration
      ? SWEEP_GAS_REGISTRATION_CEILING
      : SWEEP_GAS_DEPOSIT_CEILING;
    if (_intent == SIPABase.Intent.UpdateMetadata) ceiling = SWEEP_GAS_METADATA_UPDATE_CEILING;
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

  function quoteSubsidy(uint256 _fee, uint256 _sweepGas) public view returns (uint256) {
    Config memory cfg = $depositConfig;

    if (_sweepGas == 0 || _fee < cfg.minFee) {
      return 0;
    }

    uint256 gasPrice = Math.min(tx.gasprice, block.basefee);

    uint256 depositGasCostUsd = Math.mulDiv(_sweepGas * gasPrice, _tokenWeiPerEth(), 1e18);

    uint256 minRelayerPayout = depositGasCostUsd + cfg.approximateMinProfit;
    if (minRelayerPayout <= _fee) {
      return 0;
    }

    uint256 subsidy = Math.min(minRelayerPayout - _fee, cfg.max);
    return Math.min(subsidy, TOKEN.balanceOf(address(this)));
  }

  function _tokenWeiPerEth() internal view returns (uint256) {
    (, int256 usdPerEth,, uint256 updatedAt,) = PRICE_FEED.latestRoundData();
    uint8 feedDecimals = PRICE_FEED.decimals();
    if (
      usdPerEth < 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_PRICE_AGE
        || feedDecimals > MAX_FEED_DECIMALS
    ) {
      return 0;
    }
    return Math.mulDiv(uint256(usdPerEth), 10 ** TOKEN_DECIMALS, 10 ** feedDecimals);
  }

  function defund() external onlyOwner {
    TOKEN.safeTransfer(owner(), TOKEN.balanceOf(address(this)));
  }
}
