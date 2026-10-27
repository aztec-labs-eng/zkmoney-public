// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";

abstract contract SIPABase {
  using SafeERC20 for IERC20;

  enum Intent {
    None,
    Deposit,
    Registration,
    UserOp
  }

  function INTENT() public pure virtual returns (Intent);

  struct Args {
    bytes32 intentHash;
    bytes32 recoveryCommitment;
    uint256 rollupVersion;
    bool resweepable;
    IForwardingTable table;
  }

  struct Routing {
    address token;
    address feeRecipient;
    uint256 fee;
    bytes32 remainderRecipient;
  }

  address private immutable IMPLEMENTATION = address(this);

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

  function forwardingTable() external view returns (IForwardingTable) {
    return _args().table;
  }

  function route(address token) external view returns (IOxidePortal portal_, uint256 sweepTip, uint256 beneficiaryFee) {
    (portal_,, beneficiaryFee, sweepTip) = _args().table.rowFor(token, INTENT());
  }

  function resweepable() external view returns (bool) {
    return _args().resweepable;
  }

  function sweep(address token, address relayer, bytes calldata intentData, bytes calldata proofs) external {
    Args memory args = _args();

    require(args.table.ROLLUP_VERSION() == args.rollupVersion, Errors.SIPA__RollupVersionMismatch());
    if (!args.resweepable) {
      require(!swept, Errors.SIPA__AlreadySwept());
      swept = true;
    }

    require(keccak256(intentData) == args.intentHash, Errors.SIPA__IntentDataMismatch());

    Routing memory routing = _execute(token, intentData, proofs);
    _route(args.table, relayer, routing);
  }

  function _route(IForwardingTable table_, address relayer, Routing memory routing) private {
    (IOxidePortal portal_, address beneficiary, uint256 beneficiaryFee, uint256 tip) =
      table_.rowFor(routing.token, INTENT());
    IERC20 token = IERC20(routing.token);

    uint256 balance = token.balanceOf(address(this));
    require(balance > 0, Errors.SIPA__EmptyBalance());

    if (routing.fee > 0) {
      require(routing.fee >= tip, Errors.SIPA__FeeBelowSweepTip(routing.fee, tip));
      uint256 feeRecipientCut = routing.fee - tip;
      if (feeRecipientCut > 0) {
        token.safeTransfer(routing.feeRecipient, feeRecipientCut);
        balance -= feeRecipientCut;
      }
    }

    uint256 charges = tip + beneficiaryFee;
    require(balance > charges, Errors.SIPA__SweepBelowCharges(balance, charges));
    uint256 bridged = balance - charges;

    if (beneficiaryFee > 0) {
      token.safeTransfer(beneficiary, beneficiaryFee);
    }
    token.safeTransfer(relayer, tip);
    token.forceApprove(address(portal_), bridged);
    (, uint256 index, uint256 creditedAmount) = portal_.deposit(routing.remainderRecipient, bridged);

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
