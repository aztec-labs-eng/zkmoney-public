// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Epoch} from "@aztec/shared/libraries/TimeMath.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";

interface VmCoolAccount {
  function cool(address) external;
}

abstract contract RelayedWithdrawal is OxidePortalBase {
  uint256 internal constant HARNESS_TO_CHAIN_WITHDRAWAL_RELAY = 17_860;
  uint256 internal constant WITHDRAWAL_PRICING_TOLERANCE = 500;

  uint256 internal constant RELAY_GAS_PRICE = 4 gwei;
  uint256 internal constant RELAYED_WITHDRAWAL_EPOCH = 3;
  uint256 internal constant RELAYED_WITHDRAWAL_CHECKPOINTS = 3;
  uint256 internal constant RELAYED_WITHDRAWAL_PATH_DEPTH = 5;
  uint256 internal constant RELAYED_WITHDRAWAL_AMOUNT = 1000 ether;
  uint256 internal constant RELAYED_WITHDRAWAL_TIP = 0.1 ether;
  uint256 internal constant RELAYED_WITHDRAWAL_PROVER_TIP = 70 ether;
  address internal constant WITHDRAWAL_RELAYER = address(0x9E15);

  function _fund(address _to, uint256 _amount) internal virtual;

  function _payoutToken() internal view virtual returns (IERC20);

  function _feedAccounts() internal view virtual returns (address[] memory accounts) {
    accounts = new address[](1);
    accounts[0] = address(ethUsdFeed);
  }

  function _relayWithdrawal() internal returns (uint256 chainGas, uint256 priced) {
    uint256 txGas;
    (txGas, priced) = _relayWithdrawalAtDepth(RELAYED_WITHDRAWAL_PATH_DEPTH);
    chainGas = txGas + HARNESS_TO_CHAIN_WITHDRAWAL_RELAY;
    console2.log("relayed withdrawal: tx gas", txGas, "chain gas", chainGas);
    console2.log("relayed withdrawal: priced", priced);
  }

  function _relayWithdrawalAtDepth(uint256 _depth) internal returns (uint256 txGas, uint256 priced) {
    address recipient = makeAddr("relayedWithdrawalRecipient");
    bytes memory inner = _relayedWithdrawalCall(recipient, _depth);
    _fund(address(portal), RELAYED_WITHDRAWAL_AMOUNT);
    _fund(WITHDRAWAL_FEE_BENEFICIARY, 1);
    return _relayExit(inner, recipient);
  }

  function _relayExit(bytes memory _inner, address _recipient) internal returns (uint256 txGas, uint256 priced) {
    IERC20 token = _payoutToken();
    bytes memory outer = abi.encodeCall(OperationExecutor.execute, (_exitTarget(), _inner, token, 0, 0, 0));
    _fund(WITHDRAWAL_RELAYER, 1);

    uint256 potBefore = token.balanceOf(address(plainWithdrawalSubsidy));
    _coolEveryAccountOfTheRelay(_recipient);
    vm.prank(WITHDRAWAL_RELAYER, WITHDRAWAL_RELAYER);
    (bool ok, bytes memory ret) = address(operationExecutor).call(outer);
    if (!ok) {
      console2.logBytes(ret);
      revert("the relayed exit reverted");
    }
    txGas = RelayerTransaction.lastTxGas(outer);
    priced = ((potBefore - token.balanceOf(address(plainWithdrawalSubsidy))) * 1e18)
      / (RELAY_GAS_PRICE * _feedTokenWeiPerEth());
  }

  function _relayedWithdrawalCall(address _recipient, uint256 _depth) internal returns (bytes memory) {
    WithdrawParams memory p = _relayedWithdrawalParams(_recipient, 0, keccak256("relayedWithdrawal"));
    (bytes32[] memory path, bytes32 root) = _pathAndRoot(_messageHash(p), p.leafIndex, _depth);
    _insertRelayedWithdrawalRoot(root);
    return abi.encodeCall(IOxidePortal.withdraw, (_relayedWithdrawArgs(p, path, address(operationExecutor))));
  }

  function _exitTarget() internal view virtual returns (address) {
    return address(portal);
  }

  function _relayedWithdrawalParams(address _recipient, uint256 _leafIndex, bytes32 _withdrawalId)
    internal
    returns (WithdrawParams memory p)
  {
    p = _defaultWithdrawParams();
    p.recipient = _recipient;
    p.amount = RELAYED_WITHDRAWAL_AMOUNT;
    p.processorTip = RELAYED_WITHDRAWAL_TIP;
    p.proverTip = RELAYED_WITHDRAWAL_PROVER_TIP;
    p.epochNumber = RELAYED_WITHDRAWAL_EPOCH;
    p.leafIndex = _leafIndex;
    p.withdrawalId = _withdrawalId;
    _syncPayloadHash(p);
    _setCheckpoint(p.epochNumber);
  }

  function _insertRelayedWithdrawalRoot(bytes32 _root) internal {
    vm.prank(address(rollup));
    wiredOutbox.insert(Epoch.wrap(RELAYED_WITHDRAWAL_EPOCH), RELAYED_WITHDRAWAL_CHECKPOINTS, _root);
  }

  function _relayedWithdrawArgs(WithdrawParams memory p, bytes32[] memory _path, address _tipRecipient)
    internal
    view
    returns (IOxidePortal.WithdrawArgs memory)
  {
    return IOxidePortal.WithdrawArgs({
      content: _content(p),
      userPayload: _userPayload(p),
      relayerPayload: _relayerPayload(_tipRecipient),
      epochNumber: p.epochNumber,
      numCheckpointsInEpoch: RELAYED_WITHDRAWAL_CHECKPOINTS,
      leafIndex: p.leafIndex,
      path: _path,
      checkpointNumber: p.checkpointNumber,
      withdrawalId: p.withdrawalId,
      teeSignature: _signTee(teePk, _finalDigest(p))
    });
  }

  function _feedTokenWeiPerEth() internal view returns (uint256) {
    (, int256 usdPerEth,,,) = ethUsdFeed.latestRoundData();
    return (uint256(usdPerEth) * 1e18) / 10 ** ethUsdFeed.decimals();
  }

  function _coolEveryAccountOfTheRelay(address _recipient) internal {
    address[13] memory touched = [
      address(portal),
      address(_payoutToken()),
      address(wiredOutbox),
      address(wiredInbox),
      address(rollup),
      address(registry),
      address(teeRegistry),
      address(plainWithdrawalExecutor),
      address(plainWithdrawalSubsidy),
      address(operationExecutor),
      WITHDRAWAL_RELAYER,
      WITHDRAWAL_FEE_BENEFICIARY,
      _recipient
    ];
    for (uint256 i = 0; i < touched.length; i++) {
      VmCoolAccount(address(vm)).cool(touched[i]);
    }
    address[] memory feed = _feedAccounts();
    for (uint256 i = 0; i < feed.length; i++) {
      VmCoolAccount(address(vm)).cool(feed[i]);
    }
  }

  function _pathAndRoot(bytes32 _leaf, uint256 _index, uint256 _depth)
    internal
    pure
    returns (bytes32[] memory path, bytes32 root)
  {
    path = _pathOfLength(_depth);
    bytes32 node = _leaf;
    uint256 index = _index;
    for (uint256 height = 0; height < _depth; height++) {
      node = (index & 1) == 1
        ? Hash.sha256ToField(bytes.concat(path[height], node))
        : Hash.sha256ToField(bytes.concat(node, path[height]));
      index >>= 1;
    }
    root = node;
  }
}
