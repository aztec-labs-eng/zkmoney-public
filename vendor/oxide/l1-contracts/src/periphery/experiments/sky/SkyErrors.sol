// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

library SkyErrors {
  error SkyWithdrawalExecutor__InvalidPortal();
  error SkyWithdrawalExecutor__ZeroSkyRoute();
  error SkyWithdrawalExecutor__PortalUnderlyingMismatch();
  error SkyWithdrawalExecutor__UnauthorizedCaller();
  error SkyWithdrawalExecutor__InvalidUserPayload();
  error SkyWithdrawalExecutor__InvalidRelayerPayload();
  error SkyWithdrawalExecutor__ZeroRecipient();
  error SkyWithdrawalExecutor__ZeroTipRecipient();
  error SkyWithdrawalExecutor__RelayerTipExceedsAmount();
  error SkyWithdrawalExecutor__CallerNotRecipient();
  error SkyWithdrawalExecutor__SharesSettlementInProgress();
  error SkyWithdrawalExecutor__NotThisExecutor();

  error SkyEscrow__UnknownRoute(uint8 route);
  error SkyEscrow__ZeroSkyRoute();
  error SkyEscrow__DaiPortalUnderlyingMismatch();
  error SkyEscrow__SUsdsPortalUnderlyingMismatch();
  error SkyEscrow__ExecutorPortalMismatch();
  error SkyEscrow__ExecutorAssetMismatch();
  error SkyEscrow__NothingToMove();
}
