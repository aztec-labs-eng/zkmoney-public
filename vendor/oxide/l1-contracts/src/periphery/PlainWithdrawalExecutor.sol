// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";
import {FeeChargingExecutorBase} from "@periphery/FeeChargingExecutorBase.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {Errors} from "@periphery/Errors.sol";

contract PlainWithdrawalExecutor is FeeChargingExecutorBase {
  using SafeERC20 for IERC20;

  uint256 internal constant USER_PAYLOAD_BYTES = 2 * 32;
  uint256 internal constant RELAYER_PAYLOAD_BYTES = 20;

  PlainWithdrawalSubsidy public immutable SUBSIDY;

  constructor(
    address _portal,
    uint256 _fee,
    address _feeBeneficiary,
    address _subsidyOwner,
    AggregatorV3Interface _priceFeed
  ) FeeChargingExecutorBase(_portal, _fee, _feeBeneficiary) {
    SUBSIDY = new PlainWithdrawalSubsidy(_subsidyOwner, ASSET, address(this), _priceFeed);
  }

  // solhint-disable-next-line oxide/no-comments
  // We don't need to worry about re-entrancy here as portal is trusted and has re-entrancy guards implemented.
  function _execute(IExecutor.Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    internal
    override
  {
    require(_userPayload.length == USER_PAYLOAD_BYTES, Errors.PlainWithdrawalExecutor__InvalidUserPayload());
    require(_relayerPayload.length == RELAYER_PAYLOAD_BYTES, Errors.PlainWithdrawalExecutor__InvalidRelayerPayload());

    (address recipient, uint256 relayerTip) = _decodeUserPayload(_userPayload);
    address tipRecipient = address(bytes20(_relayerPayload));
    require(recipient != address(0), Errors.PlainWithdrawalExecutor__ZeroRecipient());
    require(relayerTip <= _amount, Errors.PlainWithdrawalExecutor__RelayerTipExceedsAmount());
    // solhint-disable-next-line oxide/no-comments
    // Assert that non-zero tip is sent to non-zero address.
    require(!(relayerTip > 0 && tipRecipient == address(0)), Errors.PlainWithdrawalExecutor__ZeroTipRecipient());

    ASSET.safeTransfer(recipient, _amount - relayerTip);
    if (relayerTip > 0) {
      ASSET.safeTransfer(tipRecipient, relayerTip);
    }

    if (tipRecipient != address(0)) {
      SUBSIDY.paySubsidy(_flow, tipRecipient);
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
}
