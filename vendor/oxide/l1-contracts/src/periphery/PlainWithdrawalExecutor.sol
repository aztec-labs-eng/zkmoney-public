// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IWithdrawalSubsidy} from "@periphery/interfaces/IWithdrawalSubsidy.sol";
import {Errors} from "@periphery/Errors.sol";

contract PlainWithdrawalExecutor is IExecutor {
  using SafeERC20 for IERC20;

  uint256 internal constant USER_PAYLOAD_BYTES = 2 * 32;
  uint256 internal constant RELAYER_PAYLOAD_BYTES = 2 * 32;

  address public immutable PORTAL;
  IERC20 public immutable ASSET;

  constructor(address _portal) {
    require(_portal.code.length > 0, Errors.PlainWithdrawalExecutor__InvalidPortal());
    PORTAL = _portal;
    ASSET = IOxidePortal(_portal).UNDERLYING();
  }

  // solhint-disable-next-line oxide/no-comments
  // We don't need to worry about re-entrancy here as portal is trusted and has re-entrancy guards implemented.
  function execute(IExecutor.Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    external
  {
    require(msg.sender == PORTAL, Errors.PlainWithdrawalExecutor__UnauthorizedCaller());
    require(_userPayload.length == USER_PAYLOAD_BYTES, Errors.PlainWithdrawalExecutor__InvalidUserPayload());
    require(_relayerPayload.length == RELAYER_PAYLOAD_BYTES, Errors.PlainWithdrawalExecutor__InvalidRelayerPayload());

    (address recipient, uint256 relayerTip) = _decodeUserPayload(_userPayload);
    (address tipRecipient, address withdrawalSubsidy) = _decodeRelayerPayload(_relayerPayload);
    require(recipient != address(0), Errors.PlainWithdrawalExecutor__ZeroRecipient());
    require(relayerTip <= _amount, Errors.PlainWithdrawalExecutor__RelayerTipExceedsAmount());
    // solhint-disable-next-line oxide/no-comments
    // Assert that non-zero tip is sent to non-zero address.
    require(!(relayerTip > 0 && tipRecipient == address(0)), Errors.PlainWithdrawalExecutor__ZeroTipRecipient());

    ASSET.safeTransfer(recipient, _amount - relayerTip);
    if (relayerTip > 0) {
      ASSET.safeTransfer(tipRecipient, relayerTip);
    }

    // solhint-disable oxide/no-comments
    // `paySubsidy` reverts when `tipRecipient` is zero and we don't check if `tipRecipient` is non-zero here as it's
    // relayer provided and just ignoring subsidy payout here could mask it and result in relayer liveness issues (if
    // subsidy was not getting paid out relayers might just not be relaying).
    // solhint-enable oxide/no-comments
    if (withdrawalSubsidy != address(0)) {
      IWithdrawalSubsidy(withdrawalSubsidy).paySubsidy(_flow, tipRecipient);
    }
  }

  function _decodeUserPayload(bytes calldata _payload) private pure returns (address recipient, uint256 relayerTip) {
    uint256 recipientWord;
    assembly {
      recipientWord := calldataload(_payload.offset)
      relayerTip := calldataload(add(_payload.offset, 32))
    }
    require(recipientWord == uint160(recipientWord), Errors.PlainWithdrawalExecutor__InvalidUserPayload());
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
      Errors.PlainWithdrawalExecutor__InvalidRelayerPayload()
    );
    tipRecipient = address(uint160(tipRecipientWord));
    withdrawalSubsidy = address(uint160(withdrawalSubsidyWord));
  }
}
