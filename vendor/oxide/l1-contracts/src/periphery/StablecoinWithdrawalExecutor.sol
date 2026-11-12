// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@oz/utils/math/Math.sol";
import {TransientSlot} from "@oz/utils/TransientSlot.sol";
import {UniswapV2Library} from "@uniswap/universal-router/contracts/modules/uniswap/v2/UniswapV2Library.sol";
import {IUniswapV2Pair} from "@uniswap/v2-core/contracts/interfaces/IUniswapV2Pair.sol";
import {IWETH9} from "@uniswap/v4-periphery/src/interfaces/external/IWETH9.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";
import {EthUsdMinOutLib} from "@periphery/EthUsdMinOutLib.sol";
import {FeeChargingExecutorBase} from "@periphery/FeeChargingExecutorBase.sol";
import {RecoveryAuthLib} from "@periphery/RecoveryAuthLib.sol";
import {
  ThreePoolLib,
  USDT,
  THREE_POOL,
  POOL3_DAI_IDX,
  POOL3_USDT_IDX,
  MAINNET_CHAIN_ID
} from "@periphery/ThreePoolLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {IMakerPsm} from "@periphery/interfaces/IMakerPsm.sol";
import {Errors} from "@periphery/Errors.sol";

IMakerPsm constant LITE_PSM_USDC = IMakerPsm(0xf6e72Db5454dd049d0788e411b06CfAF16853042);
IWETH9 constant WETH = IWETH9(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
IUniswapV2Pair constant DAI_WETH_PAIR = IUniswapV2Pair(0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11);

// solhint-disable-next-line oxide/no-comments
/**
 * @notice Pays out plain withdrawals.
 * @dev The user payload is (route, recipient, daiForGas, minOut, recoveryCommitment, relayerTip), packed into 101
 *   bytes. It pays the route's token: the asset as is, or USDC or USDT for at least `minOut`. If `daiForGas` is not
 *   zero and the DAI/WETH pair gives at least the ETH/USD feed value less 2%, first swaps `daiForGas` to ETH for the
 *   recipient. Otherwise `daiForGas` stays in the amount that the executor pays in `outputToken`. A swap can fail, so
 *   the payload also commits to a recovery account.
 */
contract StablecoinWithdrawalExecutor is FeeChargingExecutorBase {
  using SafeERC20 for IERC20;
  using TransientSlot for bytes32;
  using TransientSlot for TransientSlot.AddressSlot;

  event Recovered(bytes32 indexed withdrawalId, address indexed recipient, uint256 amount);

  uint256 internal constant USER_PAYLOAD_BYTES = 101;
  uint256 internal constant RELAYER_PAYLOAD_BYTES = 20;

  uint8 public constant ROUTE_USDC = 0;
  uint8 public constant ROUTE_USDT = 1;
  uint8 public constant ROUTE_DAI = 2;

  uint256 internal constant WAD = 1e18;

  uint256 public constant MAX_DAI_FOR_GAS = 50e18;
  uint256 internal constant GAS_SHARE_MAX_SLIPPAGE_BPS = 200;

  bytes32 internal constant RECOVERY_RECIPIENT_SLOT = keccak256("oxide.StablecoinWithdrawalExecutor.recoveryRecipient");

  PlainWithdrawalSubsidy public immutable SUBSIDY;
  AggregatorV3Interface public immutable PRICE_FEED;

  struct UserPayload {
    uint8 route;
    address recipient;
    uint256 daiForGas;
    uint256 minOut;
    bytes32 recoveryCommitment;
    uint256 relayerTip;
  }

  constructor(
    address _portal,
    uint256 _fee,
    address _feeBeneficiary,
    address _subsidyOwner,
    AggregatorV3Interface _priceFeed
  ) FeeChargingExecutorBase(_portal, _fee, _feeBeneficiary) {
    SUBSIDY = new PlainWithdrawalSubsidy(_subsidyOwner, ASSET, address(this), _priceFeed);
    PRICE_FEED = _priceFeed;
  }

  receive() external payable {
    require(msg.sender == address(WETH), Errors.StablecoinWithdrawalExecutor__EthNotFromWeth());
  }

  function recover(
    IOxidePortal.WithdrawArgs calldata _args,
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    address _recipient,
    uint256 _deadline
  ) external {
    require(_args.content.executor == address(this), Errors.StablecoinWithdrawalExecutor__NotThisExecutor());
    require(_recipient != address(0), Errors.StablecoinWithdrawalExecutor__ZeroRecoveryRecipient());
    bytes32 recoveryCommitment = _decodeUserPayload(_args.userPayload).recoveryCommitment;
    bytes32 digest = keccak256(abi.encode(address(this), block.chainid, _args.withdrawalId, _recipient, _deadline));
    RecoveryAuthLib.authorize(recoveryCommitment, _recoverySalt, _account, digest, _signature, _deadline);

    TransientSlot.AddressSlot recipientSlot = RECOVERY_RECIPIENT_SLOT.asAddress();
    recipientSlot.tstore(_recipient);
    IOxidePortal(PORTAL).withdraw(_args);
    recipientSlot.tstore(address(0));

    emit Recovered(_args.withdrawalId, _recipient, _args.content.amount - _args.content.proverTip - FEE);
  }

  // solhint-disable-next-line oxide/no-comments
  // We don't need to worry about re-entrancy here as portal is trusted and has re-entrancy guards implemented.
  function _execute(IExecutor.Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    internal
    override
  {
    address recoveryRecipient = RECOVERY_RECIPIENT_SLOT.asAddress().tload();
    if (recoveryRecipient != address(0)) {
      ASSET.safeTransfer(recoveryRecipient, _amount);
      return;
    }

    require(
      _relayerPayload.length == RELAYER_PAYLOAD_BYTES, Errors.StablecoinWithdrawalExecutor__InvalidRelayerPayload()
    );
    address tipRecipient = address(bytes20(_relayerPayload));

    uint256 tipPayout = _pay(_amount, _userPayload, tipRecipient);

    if (tipRecipient != address(0)) {
      if (tipPayout > 0) {
        ASSET.safeTransfer(tipRecipient, tipPayout);
      }
      SUBSIDY.paySubsidy(_flow, tipRecipient);
    }
  }

  function _pay(uint256 _amount, bytes calldata _userPayload, address _tipRecipient)
    private
    returns (uint256 tipPayout)
  {
    UserPayload memory payload = _decodeUserPayload(_userPayload);
    require(payload.recipient != address(0), Errors.StablecoinWithdrawalExecutor__ZeroRecipient());
    require(payload.relayerTip <= _amount, Errors.StablecoinWithdrawalExecutor__RelayerTipExceedsAmount());
    // solhint-disable-next-line oxide/no-comments
    // Assert that non-zero tip is sent to non-zero address.
    require(
      !(payload.relayerTip > 0 && _tipRecipient == address(0)), Errors.StablecoinWithdrawalExecutor__ZeroTipRecipient()
    );
    uint256 routed = _amount - payload.relayerTip;
    require(payload.daiForGas <= routed, Errors.StablecoinWithdrawalExecutor__DaiForGasExceedsAmountAfterTip());
    require(
      payload.daiForGas <= MAX_DAI_FOR_GAS, Errors.StablecoinWithdrawalExecutor__DaiForGasExceedsMax(payload.daiForGas)
    );
    if (payload.daiForGas > 0 && _payGasShare(payload.recipient, payload.daiForGas)) {
      routed -= payload.daiForGas;
    }

    uint256 dust;
    if (payload.route == ROUTE_DAI) {
      ASSET.safeTransfer(payload.recipient, routed);
    } else if (payload.route == ROUTE_USDC) {
      dust = _buyUsdc(payload.recipient, routed, payload.minOut);
    } else if (payload.route == ROUTE_USDT) {
      _swapToUsdt(payload.recipient, routed, payload.minOut);
    } else {
      revert Errors.StablecoinWithdrawalExecutor__UnknownRoute(payload.route);
    }
    tipPayout = payload.relayerTip + dust;
  }

  function _payGasShare(address _recipient, uint256 _daiIn) private returns (bool paid) {
    require(block.chainid == MAINNET_CHAIN_ID, Errors.StablecoinWithdrawalExecutor__SwapOffMainnet());
    uint256 minEthOut = EthUsdMinOutLib.ethMinOut(PRICE_FEED, _daiIn, GAS_SHARE_MAX_SLIPPAGE_BPS);

    bool assetIsToken0 = address(ASSET) < address(WETH);
    (uint256 reserve0, uint256 reserve1,) = DAI_WETH_PAIR.getReserves();
    (uint256 assetReserve, uint256 wethReserve) = assetIsToken0 ? (reserve0, reserve1) : (reserve1, reserve0);
    uint256 ethOut = UniswapV2Library.getAmountOut(_daiIn, assetReserve, wethReserve);
    if (ethOut == 0 || ethOut < minEthOut) {
      return false;
    }

    ASSET.safeTransfer(address(DAI_WETH_PAIR), _daiIn);
    (uint256 amount0Out, uint256 amount1Out) = assetIsToken0 ? (uint256(0), ethOut) : (ethOut, uint256(0));
    DAI_WETH_PAIR.swap(amount0Out, amount1Out, address(this), "");
    WETH.withdraw(ethOut);
    (bool sent,) = _recipient.call{value: ethOut}("");
    require(sent, Errors.StablecoinWithdrawalExecutor__EthTransferFailed());
    return true;
  }

  function _buyUsdc(address _recipient, uint256 _amountIn, uint256 _minOut) private returns (uint256 dust) {
    require(block.chainid == MAINNET_CHAIN_ID, Errors.StablecoinWithdrawalExecutor__SwapOffMainnet());
    uint256 to18ConversionFactor = LITE_PSM_USDC.to18ConversionFactor();
    uint256 tout = LITE_PSM_USDC.tout();
    uint256 gemAmt = (_amountIn * WAD) / (to18ConversionFactor * (WAD + tout));
    require(gemAmt >= _minOut, Errors.StablecoinWithdrawalExecutor__InsufficientOutput(gemAmt, _minOut));

    uint256 daiIn = gemAmt * to18ConversionFactor;
    daiIn += (daiIn * tout) / WAD;
    ASSET.forceApprove(address(LITE_PSM_USDC), daiIn);
    dust = _amountIn - LITE_PSM_USDC.buyGem(_recipient, gemAmt);
  }

  function _swapToUsdt(address _recipient, uint256 _amountIn, uint256 _minOut) private {
    require(block.chainid == MAINNET_CHAIN_ID, Errors.StablecoinWithdrawalExecutor__SwapOffMainnet());
    uint256 slippageBound = (_amountIn * (ThreePoolLib.BPS_DENOMINATOR - ThreePoolLib.SWAP_MAX_SLIPPAGE_BPS))
      / ThreePoolLib.BPS_DENOMINATOR / ThreePoolLib.STABLE_TO_DAI_DECIMAL_SCALE;
    ASSET.forceApprove(address(THREE_POOL), _amountIn);
    uint256 balanceBefore = USDT.balanceOf(address(this));
    THREE_POOL.exchange(POOL3_DAI_IDX, POOL3_USDT_IDX, _amountIn, Math.max(_minOut, slippageBound));
    USDT.safeTransfer(_recipient, USDT.balanceOf(address(this)) - balanceBefore);
  }

  function _decodeUserPayload(bytes calldata _userPayload) private pure returns (UserPayload memory payload) {
    require(_userPayload.length == USER_PAYLOAD_BYTES, Errors.StablecoinWithdrawalExecutor__InvalidUserPayload());
    assembly ("memory-safe") {
      let head := calldataload(_userPayload.offset)
      mstore(payload, shr(248, head))
      mstore(add(payload, 0x20), shr(96, shl(8, head)))
      mstore(add(payload, 0x40), shr(128, calldataload(add(_userPayload.offset, 21))))
      mstore(add(payload, 0x60), shr(128, calldataload(add(_userPayload.offset, 37))))
      mstore(add(payload, 0x80), calldataload(add(_userPayload.offset, 53)))
      mstore(add(payload, 0xa0), shr(128, calldataload(add(_userPayload.offset, 85))))
    }
  }
}
