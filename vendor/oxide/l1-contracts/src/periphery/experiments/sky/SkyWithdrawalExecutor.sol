// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC4626} from "@oz/interfaces/IERC4626.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {TransientSlot} from "@oz/utils/TransientSlot.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IWithdrawalSubsidy} from "@periphery/interfaces/IWithdrawalSubsidy.sol";
import {IDaiUsds} from "@periphery/experiments/sky/interfaces/IDaiUsds.sol";
import {SkyRoute} from "@periphery/experiments/sky/SkyTypes.sol";
import {SkyErrors} from "@periphery/experiments/sky/SkyErrors.sol";

contract SkyWithdrawalExecutor is IExecutor {
  using SafeERC20 for IERC20;
  using TransientSlot for bytes32;
  using TransientSlot for TransientSlot.AddressSlot;

  uint256 internal constant USER_PAYLOAD_BYTES = 2 * 32;
  uint256 internal constant RELAYER_PAYLOAD_BYTES = 2 * 32;

  bytes32 internal constant SHARES_CALLER_SLOT = keccak256("oxide.SkyWithdrawalExecutor.sharesCaller");

  address public immutable PORTAL;

  IERC20 public immutable ASSET;
  IERC20 public immutable USDS;
  IERC4626 public immutable SUSDS;
  IDaiUsds public immutable DAI_USDS;

  event SharesSettlement(IExecutor.Flow indexed flow, address indexed recipient, uint256 shares);

  constructor(IOxidePortal _portal, SkyRoute memory _route) {
    require(address(_portal).code.length > 0, SkyErrors.SkyWithdrawalExecutor__InvalidPortal());
    require(address(_route.dai) != address(0), SkyErrors.SkyWithdrawalExecutor__ZeroSkyRoute());
    require(address(_route.usds) != address(0), SkyErrors.SkyWithdrawalExecutor__ZeroSkyRoute());
    require(address(_route.sUsds) != address(0), SkyErrors.SkyWithdrawalExecutor__ZeroSkyRoute());
    require(address(_route.daiUsds) != address(0), SkyErrors.SkyWithdrawalExecutor__ZeroSkyRoute());
    require(
      address(_portal.UNDERLYING()) == address(_route.sUsds),
      SkyErrors.SkyWithdrawalExecutor__PortalUnderlyingMismatch()
    );

    PORTAL = address(_portal);
    ASSET = _route.dai;
    USDS = _route.usds;
    SUSDS = _route.sUsds;
    DAI_USDS = _route.daiUsds;

    _route.usds.forceApprove(address(_route.daiUsds), type(uint256).max);
  }

  function execute(IExecutor.Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    external
  {
    require(msg.sender == PORTAL, SkyErrors.SkyWithdrawalExecutor__UnauthorizedCaller());
    require(_userPayload.length == USER_PAYLOAD_BYTES, SkyErrors.SkyWithdrawalExecutor__InvalidUserPayload());
    require(_relayerPayload.length == RELAYER_PAYLOAD_BYTES, SkyErrors.SkyWithdrawalExecutor__InvalidRelayerPayload());

    (address recipient, uint256 relayerTip) = _decodeUserPayload(_userPayload);
    (address tipRecipient, address withdrawalSubsidy) = _decodeRelayerPayload(_relayerPayload);
    require(recipient != address(0), SkyErrors.SkyWithdrawalExecutor__ZeroRecipient());

    address sharesCaller = SHARES_CALLER_SLOT.asAddress().tload();
    if (sharesCaller != address(0)) {
      // solhint-disable oxide/no-comments
      // The recipient called `withdrawInShares`, so skip the conversion and pay all the shares.
      // This pays no tip and claims no subsidy.
      // solhint-enable oxide/no-comments
      require(sharesCaller == recipient, SkyErrors.SkyWithdrawalExecutor__CallerNotRecipient());
      IERC20(address(SUSDS)).safeTransfer(recipient, _amount);
      emit SharesSettlement(_flow, recipient, _amount);
      return;
    }

    uint256 daiAmount = _sharesToDai(_amount);
    require(relayerTip <= daiAmount, SkyErrors.SkyWithdrawalExecutor__RelayerTipExceedsAmount());
    require(!(relayerTip > 0 && tipRecipient == address(0)), SkyErrors.SkyWithdrawalExecutor__ZeroTipRecipient());

    if (relayerTip > 0) {
      ASSET.safeTransfer(tipRecipient, relayerTip);
    }
    ASSET.safeTransfer(recipient, daiAmount - relayerTip);

    if (withdrawalSubsidy != address(0)) {
      IWithdrawalSubsidy(withdrawalSubsidy).paySubsidy(_flow, tipRecipient);
    }
  }

  // solhint-disable oxide/no-comments
  // A withdrawal fixes its executor when the user burns the notes. If Sky pauses or shuts down for good, every
  // conversion to DAI reverts, so the withdrawal can never complete through `execute`. This entrypoint lets the
  // recipient complete it and take the shares instead, so the funds cannot be locked in the portal.
  // solhint-enable oxide/no-comments
  function withdrawInShares(IOxidePortal.WithdrawArgs calldata _args) external {
    require(_args.content.executor == address(this), SkyErrors.SkyWithdrawalExecutor__NotThisExecutor());

    // solhint-disable oxide/no-comments
    // Only the recipient of the user payload can settle in shares, because `execute` compares the caller in the
    // transient slot with the recipient. A nested call is refused.
    // solhint-enable oxide/no-comments
    TransientSlot.AddressSlot slot = SHARES_CALLER_SLOT.asAddress();
    require(slot.tload() == address(0), SkyErrors.SkyWithdrawalExecutor__SharesSettlementInProgress());
    slot.tstore(msg.sender);
    IOxidePortal(PORTAL).withdraw(_args);
    slot.tstore(address(0));
  }

  function _sharesToDai(uint256 _shares) private returns (uint256 daiAmount) {
    daiAmount = SUSDS.redeem(_shares, address(this), address(this));
    DAI_USDS.usdsToDai(address(this), daiAmount);
  }

  function _decodeUserPayload(bytes calldata _payload) private pure returns (address recipient, uint256 relayerTip) {
    uint256 recipientWord;
    assembly {
      recipientWord := calldataload(_payload.offset)
      relayerTip := calldataload(add(_payload.offset, 32))
    }
    require(recipientWord == uint160(recipientWord), SkyErrors.SkyWithdrawalExecutor__InvalidUserPayload());
    recipient = address(uint160(recipientWord));
  }

  function _decodeRelayerPayload(bytes calldata _payload)
    private
    pure
    returns (address tipRecipient, address withdrawalSubsidy)
  {
    uint256 tipRecipientWord;
    uint256 withdrawalSubsidyWord;
    assembly {
      tipRecipientWord := calldataload(_payload.offset)
      withdrawalSubsidyWord := calldataload(add(_payload.offset, 32))
    }
    require(
      tipRecipientWord == uint160(tipRecipientWord) && withdrawalSubsidyWord == uint160(withdrawalSubsidyWord),
      SkyErrors.SkyWithdrawalExecutor__InvalidRelayerPayload()
    );
    tipRecipient = address(uint160(tipRecipientWord));
    withdrawalSubsidy = address(uint160(withdrawalSubsidyWord));
  }
}
