// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {CoreAdapter} from "@periphery/adapters/CoreAdapter.sol";
import {ITokenMessengerV2} from "@periphery/interfaces/ITokenMessengerV2.sol";

contract CctpAdapter is CoreAdapter {
  using SafeERC20 for IERC20;

  ITokenMessengerV2 public immutable TOKEN_MESSENGER;
  IERC20 public immutable USDC;

  constructor(ITokenMessengerV2 _tokenMessenger, IERC20 _usdc) {
    TOKEN_MESSENGER = _tokenMessenger;
    USDC = _usdc;
  }

  function cctpDeposit(
    uint256 _amount,
    uint32 _destinationDomain,
    bytes32 _mintRecipient,
    uint256 _maxFee,
    uint32 _minFinalityThreshold
  ) external {
    uint256 amount = _prepareDeposit(_amount, _mintRecipient);
    TOKEN_MESSENGER.depositForBurn(
      amount, _destinationDomain, _mintRecipient, address(USDC), bytes32(0), _maxFee, _minFinalityThreshold
    );
  }

  function cctpDepositWithHook(
    uint256 _amount,
    uint32 _destinationDomain,
    bytes32 _mintRecipient,
    bytes32 _destinationCaller,
    uint256 _maxFee,
    uint32 _minFinalityThreshold,
    bytes calldata _hookData
  ) external {
    uint256 amount = _prepareDeposit(_amount, _mintRecipient);
    TOKEN_MESSENGER.depositForBurnWithHook(
      amount,
      _destinationDomain,
      _mintRecipient,
      address(USDC),
      _destinationCaller,
      _maxFee,
      _minFinalityThreshold,
      _hookData
    );
  }

  function _prepareDeposit(uint256 _amount, bytes32 _mintRecipient) private returns (uint256 amount) {
    _requireRecipient(_mintRecipient);
    amount = _resolveERC20Amount(USDC, _amount);
    USDC.forceApprove(address(TOKEN_MESSENGER), amount);
  }
}
