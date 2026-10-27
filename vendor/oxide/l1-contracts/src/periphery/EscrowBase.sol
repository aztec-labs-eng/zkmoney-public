// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RecoveryAuthLib} from "@periphery/RecoveryAuthLib.sol";

abstract contract EscrowBase {
  using SafeERC20 for IERC20;

  error EscrowBase__NotClone();
  error EscrowBase__NotFactory();
  error EscrowBase__NonceAlreadyUsed();
  error EscrowBase__EmptyBalance();
  error EscrowBase__EthTransferFailed();

  event EscrowRecovered(address indexed token, address indexed target, uint256 amount);

  address private immutable IMPLEMENTATION = address(this);
  address public immutable FACTORY = msg.sender;

  mapping(bytes32 nonce => bool used) public usedNonces;

  modifier onlyFactory() {
    require(msg.sender == FACTORY, EscrowBase__NotFactory());
    _;
  }

  function execute(address _tipRecipient) external virtual;

  function recoveryCommitment() external view returns (bytes32) {
    return _recoveryCommitment();
  }

  function recoverERC20(
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    address _target,
    address _token,
    bytes32 _nonce,
    uint256 _deadline
  ) external {
    uint256 balance = IERC20(_token).balanceOf(address(this));
    require(balance > 0, EscrowBase__EmptyBalance());
    bytes32 digest = keccak256(abi.encode(address(this), block.chainid, _target, _token, _nonce, _deadline));
    _authorizeRecovery(_recoverySalt, _account, _signature, digest, _nonce, _deadline);

    IERC20(_token).safeTransfer(_target, balance);
    emit EscrowRecovered(_token, _target, balance);
  }

  function recoverETH(
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    address _target,
    bytes32 _nonce,
    uint256 _deadline
  ) external {
    uint256 balance = address(this).balance;
    require(balance > 0, EscrowBase__EmptyBalance());
    bytes32 digest = keccak256(abi.encode(address(this), block.chainid, _target, _nonce, _deadline));
    _authorizeRecovery(_recoverySalt, _account, _signature, digest, _nonce, _deadline);

    (bool success,) = _target.call{value: balance}("");
    require(success, EscrowBase__EthTransferFailed());
    emit EscrowRecovered(address(0), _target, balance);
  }

  function _recoveryCommitment() internal view virtual returns (bytes32);

  function _cloneArgs() internal view returns (bytes memory) {
    require(address(this) != IMPLEMENTATION, EscrowBase__NotClone());
    return Clones.fetchCloneArgs(address(this));
  }

  function _authorizeRecovery(
    bytes32 _recoverySalt,
    address _account,
    bytes calldata _signature,
    bytes32 _digest,
    bytes32 _nonce,
    uint256 _deadline
  ) internal {
    require(!usedNonces[_nonce], EscrowBase__NonceAlreadyUsed());
    RecoveryAuthLib.authorize(_recoveryCommitment(), _recoverySalt, _account, _digest, _signature, _deadline);

    usedNonces[_nonce] = true;
  }
}
