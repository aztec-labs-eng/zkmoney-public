// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {SafeCast} from "@oz/utils/math/SafeCast.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {StablecoinWithdrawalExecutor} from "@periphery/StablecoinWithdrawalExecutor.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";
import {MultiStepExecutorHelpers} from "@test/periphery/MultiStepExecutorTestBase.sol";

abstract contract StablecoinWithdrawalExecutorHelpers is MultiStepExecutorHelpers {
  bytes32 internal constant RECOVERY_SALT = keccak256("recovery-salt");
  uint256 internal constant RECOVERY_KEY = 0xB0B;

  uint8 internal constant ROUTE_USDC = 0;
  uint8 internal constant ROUTE_USDT = 1;
  uint8 internal constant ROUTE_DAI = 2;

  function _recoveryAccount() internal pure returns (address) {
    return vm.addr(RECOVERY_KEY);
  }

  function _recoveryCommitment() internal pure returns (bytes32) {
    return RecoveryCommitmentLib.deriveRecoveryCommitment(RECOVERY_SALT, _recoveryAccount());
  }

  function _payload(address _recipient, uint256 _relayerTip, uint8 _route, uint256 _minOut)
    internal
    pure
    returns (bytes memory)
  {
    return _payload(_recipient, _relayerTip, _route, _minOut, 0);
  }

  function _payload(address _recipient, uint256 _relayerTip, uint8 _route, uint256 _minOut, uint256 _daiForGas)
    internal
    pure
    returns (bytes memory)
  {
    return _payload(_recipient, _relayerTip, _route, _minOut, _daiForGas, _recoveryCommitment());
  }

  function _payload(
    address _recipient,
    uint256 _relayerTip,
    uint8 _route,
    uint256 _minOut,
    uint256 _daiForGas,
    bytes32 _commitment
  ) internal pure returns (bytes memory) {
    return abi.encodePacked(
      _route,
      _recipient,
      SafeCast.toUint128(_daiForGas),
      SafeCast.toUint128(_minOut),
      _commitment,
      SafeCast.toUint128(_relayerTip)
    );
  }

  function _recoverySignature(
    StablecoinWithdrawalExecutor _executor,
    bytes32 _withdrawalId,
    address _recipient,
    uint256 _deadline,
    uint256 _key
  ) internal view returns (bytes memory) {
    bytes32 digest = keccak256(abi.encode(address(_executor), block.chainid, _withdrawalId, _recipient, _deadline));
    return AccountSignatures.k1(_key, MessageHashUtils.toEthSignedMessageHash(digest));
  }

  function _recover(
    StablecoinWithdrawalExecutor _executor,
    IOxidePortal.WithdrawArgs memory _args,
    address _recipient,
    uint256 _deadline
  ) internal {
    bytes memory signature = _recoverySignature(_executor, _args.withdrawalId, _recipient, _deadline, RECOVERY_KEY);
    _executor.recover(_args, RECOVERY_SALT, _recoveryAccount(), signature, _recipient, _deadline);
  }

  function _relayedArgs(
    OxidePortal _portal,
    StablecoinWithdrawalExecutor _executor,
    uint256 _amount,
    uint256 _proverTip,
    bytes memory _userPayload,
    address _relayer
  ) internal returns (IOxidePortal.WithdrawArgs memory) {
    return _withdrawArgsFor(_portal, address(_executor), _amount, _proverTip, _userPayload, abi.encodePacked(_relayer));
  }
}
