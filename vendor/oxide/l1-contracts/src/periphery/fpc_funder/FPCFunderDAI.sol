// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Aztec Labs.
pragma solidity >=0.8.27;

import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Commands} from "@uniswap/universal-router/contracts/libraries/Commands.sol";
import {IUniversalRouter} from "@uniswap/universal-router/contracts/interfaces/IUniversalRouter.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {UniversalRouterLib} from "./UniversalRouterLib.sol";
import {IFPCFunder} from "../interfaces/IFPCFunder.sol";
import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";
import {DAI, USDC, THREE_POOL, POOL3_DAI_IDX, POOL3_USDC_IDX} from "../ThreePoolLib.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Errors} from "@periphery/Errors.sol";

contract FPCFunderDAI is IFPCFunder {
  using SafeERC20 for IERC20;

  uint256 internal constant BPS_DENOMINATOR = 10_000;

  uint256 internal constant MIN_FUNDABLE_BALANCE = 5e18;
  uint256 internal constant MAX_FUNDABLE_BALANCE = 500e18;
  uint256 internal constant MIN_BOUNTY_BPS = 1;
  uint256 internal constant MAX_BOUNTY_BPS = 1000;
  uint256 internal constant BOUNTY_RAMP_DURATION = 24 hours;

  IUniversalRouter internal constant UNISWAP_UNIVERSAL_ROUTER =
    IUniversalRouter(0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af);

  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

  uint24 internal constant USDC_WETH_POOL_FEE = 500;

  uint24 internal constant AZTEC_ETH_POOL_FEE = 500;
  int24 internal constant AZTEC_ETH_POOL_TICK_SPACING = 10;
  address internal constant AZTEC_ETH_POOL_HOOKS = 0xd53006d1e3110fD319a79AEEc4c527a0d265E080;

  uint256 internal constant ETH_MAX_SLIPPAGE_BPS = 200;

  IERC20 public immutable FEE_ASSET;
  IFeeJuicePortal public immutable FEE_JUICE_PORTAL;
  AggregatorV3Interface public immutable ETH_USD_FEED;

  bytes32 public immutable L2_BENEFICIARY;

  uint256 internal $lastFundedAt;

  uint256 internal $lastFundedBlock;

  constructor(IRegistry _registry, uint256 _rollupVersion, bytes32 _l2Beneficiary, AggregatorV3Interface _ethUsdFeed) {
    require(_l2Beneficiary != bytes32(0), Errors.FPCFunder__ZeroBeneficiary());
    require(address(_ethUsdFeed).code.length > 0, Errors.FPCFunder__FeedWithoutCode());
    IRollup rollup = IRollup(address(_registry.getRollup(_rollupVersion)));
    FEE_ASSET = rollup.getFeeAsset();
    FEE_JUICE_PORTAL = rollup.getFeeAssetPortal();
    L2_BENEFICIARY = _l2Beneficiary;
    ETH_USD_FEED = _ethUsdFeed;
    $lastFundedAt = block.timestamp;
    $lastFundedBlock = block.number;

    FEE_ASSET.forceApprove(address(FEE_JUICE_PORTAL), type(uint256).max);
    DAI.forceApprove(address(THREE_POOL), type(uint256).max);
  }

  function swapAndDepositAsFeeJuice() external override returns (bytes32 key, uint256 index) {
    require(block.number != $lastFundedBlock, Errors.FPCFunder__AlreadyFundedThisBlock());
    (uint256 balance, uint256 bounty) = quoteBalanceAndBounty();
    require(balance >= MIN_FUNDABLE_BALANCE, Errors.FPCFunder__BalanceBelowMinimum(balance, MIN_FUNDABLE_BALANCE));

    $lastFundedBlock = block.number;
    $lastFundedAt = block.timestamp;
    _swapToFeeAsset(balance - bounty);

    uint256 amount = FEE_ASSET.balanceOf(address(this));
    require(amount > 0, Errors.FPCFunder__NothingToDeposit());
    (key, index) =
      FEE_JUICE_PORTAL.depositToAztecPublic(L2_BENEFICIARY, amount, OxideConstants.PORTAL_CONSTANT_SECRET_HASH);

    emit Funded(amount, bounty, key, index);
    DAI.safeTransfer(msg.sender, bounty);
  }

  function inputToken() public pure override returns (IERC20) {
    return DAI;
  }

  function quoteBalanceAndBounty() public view override returns (uint256 balance, uint256 bounty) {
    if (block.number == $lastFundedBlock) {
      balance = 0;
    } else {
      balance = DAI.balanceOf(address(this));
      if (balance > MAX_FUNDABLE_BALANCE) {
        balance = MAX_FUNDABLE_BALANCE;
      }
    }

    if (balance < MIN_FUNDABLE_BALANCE) {
      bounty = 0;
    } else {
      bounty = (balance * _bountyBps()) / BPS_DENOMINATOR;
    }
  }

  function _bountyBps() internal view returns (uint256) {
    uint256 elapsed = block.timestamp - $lastFundedAt;
    if (elapsed >= BOUNTY_RAMP_DURATION) {
      return MAX_BOUNTY_BPS;
    }
    return MIN_BOUNTY_BPS + ((MAX_BOUNTY_BPS - MIN_BOUNTY_BPS) * elapsed) / BOUNTY_RAMP_DURATION;
  }

  function _swapToFeeAsset(uint256 _amountIn) private {
    uint256 ethMinOut = EthUsdMinOutLib.ethMinOut(ETH_USD_FEED, _amountIn, ETH_MAX_SLIPPAGE_BPS);

    THREE_POOL.exchange(POOL3_DAI_IDX, POOL3_USDC_IDX, _amountIn, 0);
    uint256 usdcAmount = USDC.balanceOf(address(this));
    USDC.safeTransfer(address(UNISWAP_UNIVERSAL_ROUTER), usdcAmount);

    bytes memory commands =
      abi.encodePacked(uint8(Commands.V3_SWAP_EXACT_IN), uint8(Commands.UNWRAP_WETH), uint8(Commands.V4_SWAP));
    bytes[] memory inputs = new bytes[](3);
    inputs[0] = UniversalRouterLib.v3SwapExactInInput(
      ActionConstants.ADDRESS_THIS, usdcAmount, ethMinOut, abi.encodePacked(address(USDC), USDC_WETH_POOL_FEE, WETH)
    );
    inputs[1] = UniversalRouterLib.unwrapWethInput(ActionConstants.ADDRESS_THIS, ethMinOut);
    inputs[2] = UniversalRouterLib.v4SwapAllInput(
      address(0), address(FEE_ASSET), 0, AZTEC_ETH_POOL_FEE, AZTEC_ETH_POOL_TICK_SPACING, AZTEC_ETH_POOL_HOOKS
    );

    UNISWAP_UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp);
  }
}
