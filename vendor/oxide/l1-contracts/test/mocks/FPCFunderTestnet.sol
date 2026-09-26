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
import {UniversalRouterLib} from "@periphery/fpc_funder/UniversalRouterLib.sol";
import {IFPCFunder} from "@periphery/interfaces/IFPCFunder.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {Errors} from "@periphery/Errors.sol";

contract FPCFunderTestnet is IFPCFunder {
  using SafeERC20 for IERC20;

  uint256 internal constant BPS_DENOMINATOR = 10_000;

  uint256 internal constant MIN_FUNDABLE_BALANCE = 5e18;
  uint256 internal constant MAX_FUNDABLE_BALANCE = 500e18;
  uint256 internal constant MIN_BOUNTY_BPS = 1;
  uint256 internal constant MAX_BOUNTY_BPS = 1000;
  uint256 internal constant BOUNTY_RAMP_DURATION = 24 hours;

  IUniversalRouter internal constant UNISWAP_UNIVERSAL_ROUTER =
    IUniversalRouter(0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b);

  uint24 internal constant POOL_FEE = 2500;
  int24 internal constant POOL_TICK_SPACING = 25;
  address internal constant POOL_HOOKS = address(0);

  IERC20 public immutable TESTNET_TOKEN;

  IERC20 public immutable FEE_ASSET;
  IFeeJuicePortal public immutable FEE_JUICE_PORTAL;

  bytes32 public immutable L2_BENEFICIARY;

  uint256 internal $lastFundedAt;

  uint256 internal $lastFundedBlock;

  constructor(IRegistry _registry, uint256 _rollupVersion, bytes32 _l2Beneficiary, IERC20 _testnetToken) {
    require(_l2Beneficiary != bytes32(0), Errors.FPCFunder__ZeroBeneficiary());
    IRollup rollup = IRollup(address(_registry.getRollup(_rollupVersion)));
    FEE_ASSET = rollup.getFeeAsset();
    FEE_JUICE_PORTAL = rollup.getFeeAssetPortal();
    L2_BENEFICIARY = _l2Beneficiary;
    TESTNET_TOKEN = _testnetToken;
    $lastFundedAt = block.timestamp;
    $lastFundedBlock = block.number;

    FEE_ASSET.forceApprove(address(FEE_JUICE_PORTAL), type(uint256).max);
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
    TESTNET_TOKEN.safeTransfer(msg.sender, bounty);
  }

  function inputToken() public view override returns (IERC20) {
    return TESTNET_TOKEN;
  }

  function quoteBalanceAndBounty() public view override returns (uint256 balance, uint256 bounty) {
    if (block.number == $lastFundedBlock) {
      balance = 0;
    } else {
      balance = TESTNET_TOKEN.balanceOf(address(this));
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
    TESTNET_TOKEN.safeTransfer(address(UNISWAP_UNIVERSAL_ROUTER), _amountIn);
    bytes[] memory inputs = new bytes[](1);
    inputs[0] = UniversalRouterLib.v4SwapAllInput(
      address(TESTNET_TOKEN), address(FEE_ASSET), 0, POOL_FEE, POOL_TICK_SPACING, POOL_HOOKS
    );
    UNISWAP_UNIVERSAL_ROUTER.execute(abi.encodePacked(uint8(Commands.V4_SWAP)), inputs, block.timestamp);
  }
}
