// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20 as IERC20Oz} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {MigrationSubsidy} from "@periphery/migration/MigrationSubsidy.sol";
import {Intent} from "@periphery/Intent.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";

contract PotToken {
  uint8 internal immutable DECIMALS;
  address public pot;
  uint256 public potBalance;
  uint256 public otherBalance;

  constructor(uint8 _decimals) {
    DECIMALS = _decimals;
  }

  function decimals() external view returns (uint8) {
    return DECIMALS;
  }

  function set(address _pot, uint256 _potBalance, uint256 _otherBalance) external {
    pot = _pot;
    potBalance = _potBalance;
    otherBalance = _otherBalance;
  }

  function balanceOf(address _account) external view returns (uint256) {
    return _account == pot ? potBalance : otherBalance;
  }

  function transfer(address, uint256) external pure returns (bool) {
    return true;
  }
}

contract PortalStub {
  IERC20 public immutable UNDERLYING;

  constructor(IERC20 _underlying) {
    UNDERLYING = _underlying;
  }

  function ROLLUP_VERSION() external pure returns (uint256) {
    return 1;
  }
}

contract FeedStub is AggregatorV3Interface {
  int256 public answer;
  uint256 public updatedAt;

  function set(int256 _answer, uint256 _updatedAt) external {
    answer = _answer;
    updatedAt = _updatedAt;
  }

  function decimals() external pure returns (uint8) {
    return 8;
  }

  function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
    return (0, answer, 0, updatedAt, 0);
  }
}

contract ExecutorStub {
  IOperationExecutor.ExecutionContext internal $context;

  function set(bool _direct, bool _startedEmpty, address _payoutToken, uint256 _headGas) external {
    $context = IOperationExecutor.ExecutionContext({
      direct: _direct, startedEmpty: _startedEmpty, payoutToken: IERC20Oz(_payoutToken), headGas: _headGas
    });
  }

  function executionContext() external view returns (IOperationExecutor.ExecutionContext memory) {
    return $context;
  }
}

contract DepositSubsidyHarness is DepositSubsidy {
  constructor(address _owner, address _portal, address _executor, AggregatorV3Interface _feed)
    DepositSubsidy(
      _owner, _portal, IOperationExecutor(_executor), _feed, SIPAFactory(address(0xF0)), new SweepGasCeiling[](0)
    )
  {}

  function exposedQuote(uint256 _fee, uint256 _gas, uint256 _tokenPerEth) external view returns (uint256) {
    return _quoteSubsidy(_fee, _gas, _tokenPerEth);
  }

  function exposedPricedGas(uint256 _ceiling, address _token, Meter memory _meter) external view returns (uint256) {
    return _pricedGas(_ceiling, _token, _meter);
  }

  function exposedSweepGasCeilingFor(Intent _intent, address _token, bool _deployed) external view returns (uint256) {
    return _sweepGasCeilingFor(_intent, _token, _deployed);
  }

  function exposedOpenMeter(uint256 _startGas, address _relayer) external view returns (Meter memory) {
    return _openMeter(_startGas, _relayer);
  }

  function exposedTokenWeiPerEth() external view returns (uint256) {
    return _tokenWeiPerEth();
  }
}

contract MigrationSubsidyHarness is MigrationSubsidy {
  constructor(address _owner, IERC20 _token, address _sourcePortal, address _executor, AggregatorV3Interface _feed)
    MigrationSubsidy(_owner, _token, _sourcePortal, address(0xD0), _executor, bytes32(0), _feed)
  {}

  function exposedQuote(uint256 _gas, uint256 _tokenPerEth) external view returns (uint256) {
    return _quoteSubsidy(_gas, _tokenPerEth);
  }

  function exposedCappedGasPrice() external view returns (uint256) {
    return _cappedGasPrice();
  }

  function exposedTokenWeiPerEth() external view returns (uint256) {
    return _tokenWeiPerEth();
  }
}
