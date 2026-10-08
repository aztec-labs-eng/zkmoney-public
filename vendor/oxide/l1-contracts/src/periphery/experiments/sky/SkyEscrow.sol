// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {EscrowBase} from "@periphery/EscrowBase.sol";
import {IDaiUsds} from "@periphery/experiments/sky/interfaces/IDaiUsds.sol";
import {ISUsds} from "@periphery/experiments/sky/interfaces/ISUsds.sol";
import {SkyRoute, SKY_ROUTE_STAKE, SKY_ROUTE_UNSTAKE, SKY_REFERRAL_CODE} from "@periphery/experiments/sky/SkyTypes.sol";
import {SkyErrors} from "@periphery/experiments/sky/SkyErrors.sol";
import {SkyWithdrawalExecutor} from "@periphery/experiments/sky/SkyWithdrawalExecutor.sol";

contract SkyEscrow is EscrowBase {
  using SafeERC20 for IERC20;

  struct Args {
    uint8 route;
    bytes32 recipientCommitment;
    bytes32 recoveryCommitment;
    uint256 relayerTip;
    bytes32 nonce;
  }

  uint8 public constant ROUTE_STAKE = SKY_ROUTE_STAKE;
  uint8 public constant ROUTE_UNSTAKE = SKY_ROUTE_UNSTAKE;
  uint16 public constant REFERRAL_CODE = SKY_REFERRAL_CODE;

  bytes32 public constant WITHDRAW_IN_SHARES_TYPEHASH = keccak256(
    "SkyEscrow.withdrawInShares(address escrow,uint256 chainId,bytes32 withdrawalId,bytes32 nonce,uint256 deadline)"
  );

  IERC20 public immutable DAI;
  IERC20 public immutable USDS;
  ISUsds public immutable SUSDS;
  IDaiUsds public immutable DAI_USDS;

  IOxidePortal public immutable DAI_PORTAL;
  IOxidePortal public immutable SUSDS_PORTAL;
  SkyWithdrawalExecutor public immutable SKY_EXECUTOR;

  event SkyEscrowExecuted(uint8 indexed route, address indexed tipRecipient, uint256 daiAmount, uint256 deposited);
  event SkyEscrowWithdrawnInShares(bytes32 indexed withdrawalId, uint256 shares);

  constructor(
    SkyRoute memory _route,
    IOxidePortal _daiPortal,
    IOxidePortal _sUsdsPortal,
    SkyWithdrawalExecutor _skyExecutor
  ) {
    require(address(_route.dai) != address(0), SkyErrors.SkyEscrow__ZeroSkyRoute());
    require(address(_route.usds) != address(0), SkyErrors.SkyEscrow__ZeroSkyRoute());
    require(address(_route.sUsds) != address(0), SkyErrors.SkyEscrow__ZeroSkyRoute());
    require(address(_route.daiUsds) != address(0), SkyErrors.SkyEscrow__ZeroSkyRoute());
    require(address(_daiPortal.UNDERLYING()) == address(_route.dai), SkyErrors.SkyEscrow__DaiPortalUnderlyingMismatch());
    require(
      address(_sUsdsPortal.UNDERLYING()) == address(_route.sUsds), SkyErrors.SkyEscrow__SUsdsPortalUnderlyingMismatch()
    );
    require(_skyExecutor.PORTAL() == address(_sUsdsPortal), SkyErrors.SkyEscrow__ExecutorPortalMismatch());
    require(address(_skyExecutor.ASSET()) == address(_route.dai), SkyErrors.SkyEscrow__ExecutorAssetMismatch());

    DAI = _route.dai;
    USDS = _route.usds;
    SUSDS = _route.sUsds;
    DAI_USDS = _route.daiUsds;
    DAI_PORTAL = _daiPortal;
    SUSDS_PORTAL = _sUsdsPortal;
    SKY_EXECUTOR = _skyExecutor;
  }

  function route() external view returns (uint8) {
    return _args().route;
  }

  function recipientCommitment() external view returns (bytes32) {
    return _args().recipientCommitment;
  }

  function relayerTip() external view returns (uint256) {
    return _args().relayerTip;
  }

  function nonce() external view returns (bytes32) {
    return _args().nonce;
  }

  function execute(address _tipRecipient) external override onlyFactory {
    Args memory args = _args();
    require(args.route == ROUTE_STAKE || args.route == ROUTE_UNSTAKE, SkyErrors.SkyEscrow__UnknownRoute(args.route));

    if (args.route == ROUTE_UNSTAKE) {
      uint256 shares = IERC20(address(SUSDS)).balanceOf(address(this));
      if (shares > 0) {
        uint256 usdsAmount = SUSDS.redeem(shares, address(this), address(this));
        USDS.forceApprove(address(DAI_USDS), usdsAmount);
        DAI_USDS.usdsToDai(address(this), usdsAmount);
      }
    }

    uint256 balance = DAI.balanceOf(address(this));
    require(balance > args.relayerTip, SkyErrors.SkyEscrow__NothingToMove());
    uint256 daiAmount = balance - args.relayerTip;
    if (args.relayerTip > 0) {
      DAI.safeTransfer(_tipRecipient, args.relayerTip);
    }

    uint256 deposited;
    if (args.route == ROUTE_STAKE) {
      DAI.forceApprove(address(DAI_USDS), daiAmount);
      DAI_USDS.daiToUsds(address(this), daiAmount);
      USDS.forceApprove(address(SUSDS), daiAmount);
      deposited = SUSDS.deposit(daiAmount, address(this), REFERRAL_CODE);
      IERC20(address(SUSDS)).forceApprove(address(SUSDS_PORTAL), deposited);
      SUSDS_PORTAL.deposit(args.recipientCommitment, deposited);
    } else {
      deposited = daiAmount;
      DAI.forceApprove(address(DAI_PORTAL), daiAmount);
      DAI_PORTAL.deposit(args.recipientCommitment, daiAmount);
    }

    emit SkyEscrowExecuted(args.route, _tipRecipient, daiAmount, deposited);
  }

  // solhint-disable oxide/no-comments
  // If Sky is paused, or if the recipient prefers to withdraw sUSDS, they can use this entry point to settle the
  // withdrawal in shares instead. The escrow then holds the shares until the recipient recovers them, or a later run
  // redeems them when Sky works again.
  // solhint-enable oxide/no-comments
  function withdrawInShares(
    IOxidePortal.WithdrawArgs calldata _withdrawArgs,
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    bytes32 _nonce,
    uint256 _deadline
  ) external {
    _authorizeRecovery(
      _recoverySalt,
      _account,
      _signature,
      withdrawInSharesDigest(_withdrawArgs.withdrawalId, _nonce, _deadline),
      _nonce,
      _deadline
    );

    IERC20 shares = IERC20(address(SUSDS));
    uint256 before = shares.balanceOf(address(this));
    SKY_EXECUTOR.withdrawInShares(_withdrawArgs);
    emit SkyEscrowWithdrawnInShares(_withdrawArgs.withdrawalId, shares.balanceOf(address(this)) - before);
  }

  function withdrawInSharesDigest(bytes32 _withdrawalId, bytes32 _nonce, uint256 _deadline)
    public
    view
    returns (bytes32)
  {
    return keccak256(
      abi.encode(WITHDRAW_IN_SHARES_TYPEHASH, address(this), block.chainid, _withdrawalId, _nonce, _deadline)
    );
  }

  function _recoveryCommitment() internal view override returns (bytes32) {
    return _args().recoveryCommitment;
  }

  function _args() private view returns (Args memory) {
    return abi.decode(_cloneArgs(), (Args));
  }
}
