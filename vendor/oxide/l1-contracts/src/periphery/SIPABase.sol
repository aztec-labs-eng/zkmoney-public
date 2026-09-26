// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";

abstract contract SIPABase {
  using SafeERC20 for IERC20;

  enum Intent {
    None,
    Deposit,
    Registration,
    UpdateMetadata
  }

  function INTENT() external pure virtual returns (Intent);

  struct Args {
    bytes32 intentHash;
    bytes32 recoveryCommitment;
    uint256 rollupVersion;
    bool resweepable;
  }

  struct Routing {
    address token;
    address feeRecipient;
    uint256 fee;
    bytes32 remainderRecipient;
  }

  address private immutable IMPLEMENTATION = address(this);

  IOxidePortal public immutable PORTAL;
  IERC20 public immutable UNDERLYING;
  uint256 public immutable DEPOSIT_FEE;

  uint256 private immutable PORTAL_ROLLUP_VERSION;

  constructor(IOxidePortal portal_, uint256 fee) {
    require(address(portal_) != address(0), Errors.SIPA__ZeroPortal());
    require(fee > 0, Errors.SIPA__ZeroDepositFee());
    PORTAL = portal_;
    UNDERLYING = IERC20(address(portal_.UNDERLYING()));
    DEPOSIT_FEE = fee;
    PORTAL_ROLLUP_VERSION = portal_.ROLLUP_VERSION();
  }

  mapping(bytes32 nonce => bool used) public usedNonces;

  bool public swept;

  event Sweep(uint256 index, uint256 amount);

  event Recovered(address indexed token, address indexed target, uint256 amount);

  function intentHash() external view returns (bytes32) {
    return _args().intentHash;
  }

  function recoveryCommitment() external view returns (bytes32) {
    return _args().recoveryCommitment;
  }

  function rollupVersion() external view returns (uint256) {
    return _args().rollupVersion;
  }

  function portal() external view returns (IOxidePortal) {
    return PORTAL;
  }

  function depositFee() external view returns (uint256) {
    return DEPOSIT_FEE;
  }

  function resweepable() external view returns (bool) {
    return _args().resweepable;
  }

  function sweep(address token, address relayer, bytes calldata intentData, bytes calldata proofs) external {
    Args memory args = _args();

    require(PORTAL_ROLLUP_VERSION == args.rollupVersion, Errors.SIPA__RollupVersionMismatch());
    if (!args.resweepable) {
      require(!swept, Errors.SIPA__AlreadySwept());
      swept = true;
    }

    require(keccak256(intentData) == args.intentHash, Errors.SIPA__IntentDataMismatch());

    Routing memory routing = _execute(token, intentData, proofs);
    _route(relayer, routing);
  }

  function _route(address relayer, Routing memory routing) private {
    IERC20 token = IERC20(routing.token);
    require(token == UNDERLYING, Errors.SIPA__TokenNotPortalUnderlying(address(token)));

    uint256 balance = token.balanceOf(address(this));
    require(balance > 0, Errors.SIPA__EmptyBalance());

    if (routing.fee > 0) {
      require(routing.fee >= DEPOSIT_FEE, Errors.SIPA__FeeBelowDepositFee(routing.fee, DEPOSIT_FEE));
      uint256 feeRecipientCut = routing.fee - DEPOSIT_FEE;
      if (feeRecipientCut > 0) {
        token.safeTransfer(routing.feeRecipient, feeRecipientCut);
        balance -= feeRecipientCut;
      }
    }

    require(balance > DEPOSIT_FEE, Errors.SIPA__SweepBelowDepositFee(balance, DEPOSIT_FEE));
    uint256 bridged = balance - DEPOSIT_FEE;

    token.safeTransfer(relayer, DEPOSIT_FEE);
    token.forceApprove(address(PORTAL), bridged);
    (, uint256 index, uint256 creditedAmount) = PORTAL.deposit(routing.remainderRecipient, bridged);

    emit Sweep(index, creditedAmount);
  }

  function _execute(address token, bytes calldata intentData, bytes calldata proofs)
    internal
    virtual
    returns (Routing memory);

  function recoverERC20(
    bytes32 sharedSecretSalt,
    address account,
    bytes calldata signature,
    address target,
    address token,
    bytes32 nonce
  ) public {
    uint256 balance = IERC20(token).balanceOf(address(this));
    require(balance > 0, Errors.SIPA__EmptyBalance());
    bytes32 digest = keccak256(abi.encode(address(this), block.chainid, target, token, nonce));
    _authorizeRecovery(sharedSecretSalt, account, signature, digest, nonce);
    IERC20(token).safeTransfer(target, balance);
    emit Recovered(token, target, balance);
  }

  function recoverETH(
    bytes32 sharedSecretSalt,
    address account,
    bytes calldata signature,
    address target,
    bytes32 nonce
  ) public {
    uint256 balance = address(this).balance;
    require(balance > 0, Errors.SIPA__EmptyBalance());
    bytes32 digest = keccak256(abi.encode(address(this), block.chainid, target, nonce));
    _authorizeRecovery(sharedSecretSalt, account, signature, digest, nonce);
    (bool success,) = target.call{value: balance}("");
    require(success, Errors.SIPA__EthTransferFailed());
    emit Recovered(address(0), target, balance);
  }

  function _args() internal view returns (Args memory) {
    require(address(this) != IMPLEMENTATION, Errors.SIPA__NotClone());
    return abi.decode(Clones.fetchCloneArgs(address(this)), (Args));
  }

  function _authorizeRecovery(
    bytes32 sharedSecretSalt,
    address account,
    bytes calldata signature,
    bytes32 digest,
    bytes32 nonce
  ) private {
    require(!usedNonces[nonce], Errors.SIPA__NonceAlreadyUsed());
    require(
      RecoveryCommitmentLib.deriveRecoveryCommitment(sharedSecretSalt, account) == _args().recoveryCommitment,
      Errors.SIPA__RecoveryCommitmentMismatch()
    );
    require(
      IERC1271(account).isValidSignature(digest, signature) == IERC1271.isValidSignature.selector,
      Errors.SIPA__InvalidSignature()
    );

    usedNonces[nonce] = true;
  }
}
