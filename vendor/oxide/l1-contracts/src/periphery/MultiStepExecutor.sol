// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SafeERC20} from "@oz/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@oz/utils/Address.sol";
import {TransientSlot} from "@oz/utils/TransientSlot.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {FeeChargingExecutorBase} from "@periphery/FeeChargingExecutorBase.sol";
import {RecoveryAuthLib} from "@periphery/RecoveryAuthLib.sol";
import {Errors} from "@periphery/Errors.sol";

// solhint-disable-next-line oxide/no-comments
/**
 * @notice Runs a withdrawal as token transfers and then calls.
 *
 * The transfers send fixed amounts and `remainderRecipient` gets the rest, so a payload never has to know the fee.
 * Adapters interact with other contracts with amounts known only at execution time: each one reads its own balance.
 *
 * Example: withdraw 1000 DAI as USDC plus 10 DAI of ETH for gas, with a prover tip of 2, a protocol fee of 3, and a
 * relayer tip of 5.
 *   transfers          = [(10, uniswapV3Adapter)]
 *   remainderRecipient = psmAdapter
 *   steps              = [uniswapV3Adapter.uniswapV3ExactIn(daiToWethPath, type(uint256).max, minWethOut, recipient),
 *                         psmAdapter.psmBuyGem(psm, type(uint256).max, 979e6, recipient)]
 * Trace:
 *   1. The portal sends 998 DAI (1000 less the prover tip) to the executor and calls `execute`.
 *   2. The executor sends the 3 DAI fee to `BENEFICIARY` and the 5 DAI tip to the relayer.
 *   3. It sends 10 DAI to `uniswapV3Adapter` and the remaining 980 DAI to `psmAdapter`.
 *   4. It calls `uniswapV3ExactIn`, which swaps the 10 DAI for WETH and sends the WETH to `recipient`.
 *   5. It calls `psmBuyGem`, which swaps the 980 DAI for USDC and sends the USDC to `recipient`.
 */
contract MultiStepExecutor is FeeChargingExecutorBase {
  using SafeERC20 for IERC20;
  using TransientSlot for bytes32;
  using TransientSlot for TransientSlot.AddressSlot;

  struct Step {
    address target;
    bytes data;
  }

  struct Transfer {
    uint256 amount;
    address recipient;
  }

  struct UserPayload {
    uint256 relayerTip;
    bytes32 recoveryCommitment;
    address remainderRecipient;
    Transfer[] transfers;
    Step[] steps;
  }

  event Recovered(bytes32 indexed withdrawalId, address indexed recipient, uint256 amount);

  uint256 internal constant RELAYER_PAYLOAD_BYTES = 20;

  // solhint-disable-next-line oxide/no-comments
  /**
   * @dev `recover` writes the recipient here and calls `PORTAL.withdraw`, which calls back `execute`. The payloads
   * cannot carry the recipient, because the user payload is fixed and anyone can set the relayer payload.
   */
  bytes32 internal constant RECOVERY_RECIPIENT_SLOT = keccak256("oxide.MultiStepExecutor.recoveryRecipient");

  constructor(address _portal, uint256 _fee, address _feeBeneficiary)
    FeeChargingExecutorBase(_portal, _fee, _feeBeneficiary)
  {}

  function recover(
    IOxidePortal.WithdrawArgs calldata _args,
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    address _recipient,
    uint256 _deadline
  ) external {
    require(_args.content.executor == address(this), Errors.MultiStepExecutor__NotThisExecutor());
    require(_recipient != address(0), Errors.MultiStepExecutor__ZeroRecoveryRecipient());
    bytes32 commitment = abi.decode(_args.userPayload, (UserPayload)).recoveryCommitment;
    bytes32 digest = keccak256(abi.encode(address(this), block.chainid, _args.withdrawalId, _recipient, _deadline));
    RecoveryAuthLib.authorize(commitment, _recoverySalt, _account, digest, _signature, _deadline);

    TransientSlot.AddressSlot slot = RECOVERY_RECIPIENT_SLOT.asAddress();
    slot.tstore(_recipient);
    IOxidePortal(PORTAL).withdraw(_args);
    slot.tstore(address(0));

    uint256 executorAmount = _args.content.amount - _args.content.proverTip;
    emit Recovered(_args.withdrawalId, _recipient, executorAmount - FEE);
  }

  function _execute(IExecutor.Flow, uint256 _amount, bytes calldata _userPayload, bytes calldata _relayerPayload)
    internal
    override
  {
    address recoveryRecipient = RECOVERY_RECIPIENT_SLOT.asAddress().tload();
    if (recoveryRecipient != address(0)) {
      // solhint-disable oxide/no-comments
      // Recovery recipient was defined hence we are dealing with a recovery flow (only `recover(...)` fn writes to
      // transient storage.
      // solhint-enable oxide/no-comments
      ASSET.safeTransfer(recoveryRecipient, _amount);
      return;
    }

    require(_relayerPayload.length == RELAYER_PAYLOAD_BYTES, Errors.MultiStepExecutor__InvalidRelayerPayload());

    UserPayload memory payload = abi.decode(_userPayload, (UserPayload));
    address tipRecipient = address(bytes20(_relayerPayload));
    uint256 net = _amount - payload.relayerTip;

    if (payload.relayerTip > 0) {
      ASSET.safeTransfer(tipRecipient, payload.relayerTip);
    }
    _distribute(payload.transfers, payload.remainderRecipient, net);

    for (uint256 i = 0; i < payload.steps.length; i++) {
      Address.functionCall(payload.steps[i].target, payload.steps[i].data);
    }
  }

  function _distribute(Transfer[] memory _transfers, address _remainderRecipient, uint256 _total) private {
    require(_remainderRecipient != address(0), Errors.MultiStepExecutor__ZeroRemainderRecipient());
    uint256 remaining = _total;
    for (uint256 i = 0; i < _transfers.length; i++) {
      require(_transfers[i].recipient != address(0), Errors.MultiStepExecutor__ZeroTransferRecipient());
      remaining -= _transfers[i].amount;
      ASSET.safeTransfer(_transfers[i].recipient, _transfers[i].amount);
    }

    if (remaining > 0) {
      ASSET.safeTransfer(_remainderRecipient, remaining);
    }
  }
}
