// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Aztec Labs.
pragma solidity >=0.8.27;

import {Ownable} from "@oz/access/Ownable.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {EthUsdMinOutLib} from "./EthUsdMinOutLib.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {Errors} from "@periphery/Errors.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";

contract PlainWithdrawalSubsidy is Ownable {
  using SafeERC20 for IERC20;

  struct FlowPricing {
    uint256 startPriceWei;
    uint256 maxSubsidy;
  }

  address public immutable EXECUTOR;
  IERC20 public immutable TOKEN;
  uint8 public immutable TOKEN_DECIMALS;

  AggregatorV3Interface public immutable PRICE_FEED;
  uint256 internal constant MAX_PRICE_AGE = EthUsdMinOutLib.MAX_PRICE_AGE;

  uint8 public constant FEED_DECIMALS = 8;

  uint256 public constant WITHDRAWAL_TX_GAS = 125_000;
  uint256 public constant FROZEN_NOTES_REFUND_TX_GAS = 1_015_000;
  uint256 public constant FROZEN_DEPOSITS_REFUND_TX_GAS = 1_005_000;
  uint256 public constant UNPROCESSED_DEPOSIT_REFUND_TX_GAS = 980_000;

  mapping(IExecutor.Flow flow => FlowPricing pricing) public $flowPricing;

  constructor(address _owner, IERC20 _token, address _executor, AggregatorV3Interface _priceFeed) Ownable(_owner) {
    require(address(_priceFeed).code.length > 0, Errors.PlainWithdrawalSubsidy__FeedWithoutCode());
    // solhint-disable oxide/no-comments
    // The subsidy expects a Chainlink ETH/USD feed, which has 8 decimals.
    // solhint-enable oxide/no-comments
    uint8 feedDecimals = _priceFeed.decimals();
    require(feedDecimals == FEED_DECIMALS, Errors.PlainWithdrawalSubsidy__UnexpectedFeedDecimals(feedDecimals));
    require(_executor != address(0), Errors.PlainWithdrawalSubsidy__ZeroExecutor());
    EXECUTOR = _executor;
    TOKEN = _token;
    TOKEN_DECIMALS = IERC20Metadata(address(_token)).decimals();
    PRICE_FEED = _priceFeed;
  }

  function setFlowPricing(IExecutor.Flow _flow, FlowPricing calldata _pricing) external onlyOwner {
    $flowPricing[_flow] = _pricing;
  }

  function paySubsidy(IExecutor.Flow _flow, address _tipRecipient) external returns (uint256 subsidy) {
    require(msg.sender == EXECUTOR, Errors.PlainWithdrawalSubsidy__UnauthorizedExecutor());
    require(_tipRecipient != address(0), Errors.PlainWithdrawalSubsidy__ZeroTipRecipient());

    subsidy = quoteSubsidy(_flow);
    if (subsidy > 0) {
      TOKEN.safeTransfer(_tipRecipient, subsidy);
    }
  }

  function quoteSubsidy(IExecutor.Flow _flow) public view returns (uint256) {
    FlowPricing memory pricing = $flowPricing[_flow];
    uint256 gasPrice = Math.min(tx.gasprice, block.basefee + OxideConstants.MAX_PRIORITY_FEE_WEI);
    if (gasPrice <= pricing.startPriceWei) {
      return 0;
    }

    uint256 quoted = Math.mulDiv(modeledTxGas(_flow) * (gasPrice - pricing.startPriceWei), _tokenWeiPerEth(), 1e18);
    quoted = Math.min(quoted, pricing.maxSubsidy);
    return Math.min(TOKEN.balanceOf(address(this)), quoted);
  }

  function modeledTxGas(IExecutor.Flow _flow) public pure returns (uint256) {
    if (_flow == IExecutor.Flow.Withdrawal) {
      return WITHDRAWAL_TX_GAS;
    }
    if (_flow == IExecutor.Flow.FrozenNotesRefund) {
      return FROZEN_NOTES_REFUND_TX_GAS;
    }
    if (_flow == IExecutor.Flow.FrozenDepositsRefund) {
      return FROZEN_DEPOSITS_REFUND_TX_GAS;
    }
    return UNPROCESSED_DEPOSIT_REFUND_TX_GAS;
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
