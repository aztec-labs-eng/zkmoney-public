// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICurve3Pool} from "@periphery/interfaces/ICurve3Pool.sol";
import {IAcrossSpokePool} from "@periphery/interfaces/IAcrossSpokePool.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {ThreePoolLib, POOL3_USDC_IDX, POOL3_USDT_IDX} from "@periphery/ThreePoolLib.sol";

contract AcrossBridgeEscrow is EscrowBase {
  using SafeERC20 for IERC20;

  // solhint-disable oxide/no-comments
  struct Args {
    // USDC or USDT. The escrow swaps DAI to it and deposits it on Across.
    address acrossInputToken;
    // EVM chain id.
    uint256 destinationChainId;
    address recipient;
    // Token that the recipient receives on the destination chain.
    address acrossOutputToken;
    // Decimals of `acrossOutputToken`, for example 18 for USDT on BNB.
    uint8 acrossOutputTokenDecimals;
    // Fee in `acrossInputToken` units that the Across relayer keeps, including the destination gas.
    uint256 acrossFee;
    bytes32 recoveryCommitment;
    // DAI paid to the relayer that executes the escrow.
    uint256 relayerTip;
    bytes32 nonce;
  }
  // solhint-enable oxide/no-comments

  error AcrossBridgeEscrow__UnsupportedAcrossInputToken(address acrossInputToken);
  error AcrossBridgeEscrow__ZeroRecipient();
  error AcrossBridgeEscrow__AcrossOutputDecimalsBelowInput(uint8 acrossOutputTokenDecimals);
  error AcrossBridgeEscrow__AmountNotAboveAcrossFee(uint256 amount, uint256 acrossFee);

  uint8 public constant ACROSS_INPUT_TOKEN_DECIMALS = 6;
  uint32 public constant FILL_DEADLINE_OFFSET = 6 hours;

  IERC20 public immutable DAI;
  address public immutable USDC;
  address public immutable USDT;
  ICurve3Pool public immutable THREE_POOL;
  IAcrossSpokePool public immutable SPOKE_POOL;

  constructor(IERC20 _dai, address _usdc, address _usdt, ICurve3Pool _threePool, IAcrossSpokePool _spokePool) {
    DAI = _dai;
    USDC = _usdc;
    USDT = _usdt;
    THREE_POOL = _threePool;
    SPOKE_POOL = _spokePool;
  }

  function acrossInputToken() external view returns (address) {
    return _args().acrossInputToken;
  }

  function destinationChainId() external view returns (uint256) {
    return _args().destinationChainId;
  }

  function recipient() external view returns (address) {
    return _args().recipient;
  }

  function acrossOutputToken() external view returns (address) {
    return _args().acrossOutputToken;
  }

  function acrossOutputTokenDecimals() external view returns (uint8) {
    return _args().acrossOutputTokenDecimals;
  }

  function acrossFee() external view returns (uint256) {
    return _args().acrossFee;
  }

  function relayerTip() external view returns (uint256) {
    return _args().relayerTip;
  }

  function nonce() external view returns (bytes32) {
    return _args().nonce;
  }

  function execute(address _tipRecipient) external override onlyFactory {
    Args memory args = _args();
    int128 poolIndex = _poolIndex(args.acrossInputToken);
    require(args.recipient != address(0), AcrossBridgeEscrow__ZeroRecipient());
    require(
      args.acrossOutputTokenDecimals >= ACROSS_INPUT_TOKEN_DECIMALS,
      AcrossBridgeEscrow__AcrossOutputDecimalsBelowInput(args.acrossOutputTokenDecimals)
    );

    uint256 daiAmount = DAI.balanceOf(address(this)) - args.relayerTip;
    // solhint-disable oxide/no-comments
    // The Across deposit uses this escrow as the depositor. If no Across relayer fills the deposit, Across refunds the
    // source token (not DAI) to this escrow, and the user recovers it with recoverERC20. The refund adds no DAI, so
    // on its own the call to `acrossBridgeEscrowFactory.deployAndExecute()` would not execute the deposit again. But
    // anyone can send relayerTip + 1 wei of DAI to the escrow and call deployAndExecute. If we deposited the full
    // source token balance (e.g. USDC or USDT), that call would send the refund back to Across and pay the
    // tip back to the caller. The attack costs only 1 wei of DAI and gas, and the attacker can repeat it after each
    // refund to block the recovery. So we deposit only the amount that the swap produces.
    // solhint-enable oxide/no-comments
    uint256 acrossInputBalanceBefore = IERC20(args.acrossInputToken).balanceOf(address(this));
    uint256 acrossInputBalanceAfter = ThreePoolLib.swapDaiTo(
      THREE_POOL, address(DAI), poolIndex, args.acrossInputToken, daiAmount, ThreePoolLib.SWAP_MAX_SLIPPAGE_BPS
    );
    uint256 acrossInputAmount = acrossInputBalanceAfter - acrossInputBalanceBefore;
    require(
      acrossInputAmount > args.acrossFee, AcrossBridgeEscrow__AmountNotAboveAcrossFee(acrossInputAmount, args.acrossFee)
    );
    // solhint-disable oxide/no-comments
    // An Across deposit is an intent: an Across relayer pays exactly `acrossOutputAmount` to the recipient and keeps
    // `acrossFee`. Across does not convert decimals, so we scale the amount to the decimals of `acrossOutputToken`.
    // solhint-enable oxide/no-comments
    uint256 acrossOutputAmount =
      (acrossInputAmount - args.acrossFee) * 10 ** (args.acrossOutputTokenDecimals - ACROSS_INPUT_TOKEN_DECIMALS);

    IERC20(args.acrossInputToken).forceApprove(address(SPOKE_POOL), acrossInputAmount);
    SPOKE_POOL.depositV3Now(
      address(this),
      args.recipient,
      args.acrossInputToken,
      args.acrossOutputToken,
      acrossInputAmount,
      acrossOutputAmount,
      args.destinationChainId,
      address(0),
      FILL_DEADLINE_OFFSET,
      0,
      ""
    );
    DAI.safeTransfer(_tipRecipient, args.relayerTip);
  }

  function _recoveryCommitment() internal view override returns (bytes32) {
    return _args().recoveryCommitment;
  }

  function _poolIndex(address _acrossInputToken) private view returns (int128) {
    if (_acrossInputToken == USDC) {
      return POOL3_USDC_IDX;
    }
    require(_acrossInputToken == USDT, AcrossBridgeEscrow__UnsupportedAcrossInputToken(_acrossInputToken));
    return POOL3_USDT_IDX;
  }

  function _args() private view returns (Args memory) {
    return abi.decode(_cloneArgs(), (Args));
  }
}
