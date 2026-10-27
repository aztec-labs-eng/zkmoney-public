// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {MigrationSubsidy} from "@periphery/migration/MigrationSubsidy.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {Errors} from "@periphery/Errors.sol";

contract MigrationExecutor is IExecutor {
  using SafeERC20 for IERC20;

  uint256 internal constant USER_PAYLOAD_BYTES = 2 * 32;
  uint256 internal constant RELAYER_PAYLOAD_BYTES = 20;

  IOxidePortal public immutable SOURCE_PORTAL;
  IOxidePortal public immutable DESTINATION_PORTAL;
  IERC20 public immutable ASSET;
  IERC20 public immutable PAYOUT_TOKEN;
  MigrationSubsidy public immutable SUBSIDY;

  event Migrated(
    IExecutor.Flow flow, bytes32 indexed recipientCommitment, uint256 migrated, address tipRecipient, uint256 relayerTip
  );

  constructor(
    IOxidePortal _sourcePortal,
    IOxidePortal _destinationPortal,
    IERC20 _payoutToken,
    address _subsidyOwner,
    bytes32 _operationExecutorCodeHash,
    AggregatorV3Interface _priceFeed
  ) {
    require(address(_sourcePortal).code.length > 0, Errors.MigrationExecutor__PortalWithoutCode(address(_sourcePortal)));
    require(
      address(_destinationPortal).code.length > 0,
      Errors.MigrationExecutor__PortalWithoutCode(address(_destinationPortal))
    );
    require(address(_sourcePortal) != address(_destinationPortal), Errors.MigrationExecutor__SamePortal());
    IERC20 asset = _sourcePortal.UNDERLYING();
    require(_destinationPortal.UNDERLYING() == asset, Errors.MigrationExecutor__UnderlyingMismatch());

    SOURCE_PORTAL = _sourcePortal;
    DESTINATION_PORTAL = _destinationPortal;
    ASSET = asset;
    PAYOUT_TOKEN = _payoutToken;
    SUBSIDY = new MigrationSubsidy(
      _subsidyOwner,
      _payoutToken,
      address(_sourcePortal),
      address(_destinationPortal),
      address(this),
      _operationExecutorCodeHash,
      _priceFeed
    );
    asset.forceApprove(address(_destinationPortal), type(uint256).max);
  }

  function execute(IExecutor.Flow _flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    external
  {
    require(msg.sender == address(SOURCE_PORTAL), Errors.MigrationExecutor__UnauthorizedCaller());
    require(_userPayload.length == USER_PAYLOAD_BYTES, Errors.MigrationExecutor__InvalidUserPayload());
    require(_relayerPayload.length == RELAYER_PAYLOAD_BYTES, Errors.MigrationExecutor__InvalidRelayerPayload());

    (bytes32 recipientCommitment, uint256 relayerTip) = abi.decode(_userPayload, (bytes32, uint256));
    address tipRecipient = address(bytes20(_relayerPayload));
    require(recipientCommitment != bytes32(0), Errors.MigrationExecutor__ZeroRecipientCommitment());
    require(relayerTip <= _amount, Errors.MigrationExecutor__RelayerTipExceedsAmount());
    require(relayerTip == 0 || tipRecipient != address(0), Errors.MigrationExecutor__ZeroTipRecipient());
    // solhint-disable oxide/no-comments
    // A tip is paid in the migrated asset, but the OperationExecutor hands the relayer only the payout token and keeps
    // anything else. So a tip is accepted only when the asset is the payout token of the subsidy.
    // solhint-enable oxide/no-comments
    require(relayerTip == 0 || ASSET == PAYOUT_TOKEN, Errors.MigrationExecutor__TipNotInPayoutToken());
    uint256 migrated = _amount - relayerTip;
    require(migrated > 0, Errors.MigrationExecutor__NothingToMigrate());

    if (relayerTip > 0) {
      ASSET.safeTransfer(tipRecipient, relayerTip);
    }
    DESTINATION_PORTAL.deposit(recipientCommitment, migrated);

    emit Migrated(_flow, recipientCommitment, migrated, tipRecipient, relayerTip);

    SUBSIDY.recordMigration(_flow, migrated);
  }
}
