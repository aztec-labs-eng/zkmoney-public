// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {DAI, USDC} from "@periphery/ThreePoolLib.sol";
import {LifiIntentAdapter} from "@periphery/adapters/LifiIntentAdapter.sol";
import {ILifiInputSettlerEscrow, MandateOutput, StandardOrder} from "@periphery/interfaces/ILifiInputSettlerEscrow.sol";
import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";

abstract contract LifiSolverFixture is MainnetForkFixture {
  address internal constant LIFI_INPUT_SETTLER = 0x00fC00edbe7C003b006f870068c548940000223e;
  address internal constant LIFI_OUTPUT_SETTLER = 0x75220B7600c300005038432a0000f308e0000068;
  address internal constant LIFI_SAME_CHAIN_ORACLE = LIFI_OUTPUT_SETTLER;
  uint256 internal constant LIFI_NONCE = 1;
  uint32 internal constant LIFI_FILL_WINDOW = 10 minutes;
  uint32 internal constant LIFI_EXPIRY_WINDOW = 1 hours;

  function _lifiSameChainOpen(address _recipient, uint256 _minOutput, address _refundRecipient)
    internal
    view
    returns (LifiIntentAdapter.Open memory)
  {
    return LifiIntentAdapter.Open({
      token: DAI,
      amount: type(uint256).max,
      destinationChainId: block.chainid,
      inputSettler: ILifiInputSettlerEscrow(LIFI_INPUT_SETTLER),
      inputOracle: LIFI_SAME_CHAIN_ORACLE,
      outputOracle: _lifiToBytes32(LIFI_SAME_CHAIN_ORACLE),
      outputSettler: _lifiToBytes32(LIFI_OUTPUT_SETTLER),
      outputToken: _lifiToBytes32(address(USDC)),
      recipient: _lifiToBytes32(_recipient),
      minOutput: _minOutput,
      refundRecipient: _refundRecipient,
      nonce: LIFI_NONCE,
      fillWindow: LIFI_FILL_WINDOW,
      expiryWindow: LIFI_EXPIRY_WINDOW,
      context: ""
    });
  }

  function _lifiOrder(LifiIntentAdapter.Open memory _open, uint256 _amount, bytes memory _callbackData)
    internal
    view
    returns (StandardOrder memory)
  {
    uint256[2][] memory inputs = new uint256[2][](1);
    inputs[0] = [uint256(uint160(address(_open.token))), _amount];
    MandateOutput[] memory outputs = new MandateOutput[](1);
    outputs[0] = MandateOutput({
      oracle: _open.outputOracle,
      settler: _open.outputSettler,
      chainId: _open.destinationChainId,
      token: _open.outputToken,
      amount: _open.minOutput,
      recipient: _open.recipient,
      callbackData: _callbackData,
      context: _open.context
    });
    return StandardOrder({
      user: _open.refundRecipient,
      nonce: _open.nonce,
      originChainId: block.chainid,
      expires: uint32(block.timestamp) + _open.expiryWindow,
      fillDeadline: uint32(block.timestamp) + _open.fillWindow,
      inputOracle: _open.inputOracle,
      inputs: inputs,
      outputs: outputs
    });
  }

  function _lifiOrderId(StandardOrder memory _order) internal view returns (bytes32) {
    return ILifiInputSettlerEscrowSolver(LIFI_INPUT_SETTLER).orderIdentifier(_order);
  }

  function _lifiOrderStatus(StandardOrder memory _order) internal view returns (LifiOrderStatus) {
    return ILifiInputSettlerEscrowSolver(LIFI_INPUT_SETTLER).orderStatus(_lifiOrderId(_order));
  }

  function _lifiToBytes32(address _address) internal pure returns (bytes32) {
    return bytes32(uint256(uint160(_address)));
  }

  function _lifiSolve(StandardOrder memory _order, address _solver) internal {
    bytes32 orderId = _lifiOrderId(_order);
    MandateOutput memory output = _order.outputs[0];
    IERC20 outputToken = IERC20(address(uint160(uint256(output.token))));
    bytes32 solver = _lifiToBytes32(_solver);
    deal(address(outputToken), _solver, output.amount);

    vm.startPrank(_solver);
    outputToken.approve(LIFI_OUTPUT_SETTLER, output.amount);
    ILifiOutputSettler(LIFI_OUTPUT_SETTLER).fill(orderId, output, _order.fillDeadline, abi.encodePacked(solver));
    ILifiOutputSettler(LIFI_OUTPUT_SETTLER).setAttestation(orderId, solver, uint32(block.timestamp), output);
    LifiSolveParams[] memory solveParams = new LifiSolveParams[](1);
    solveParams[0] = LifiSolveParams({timestamp: uint32(block.timestamp), solver: solver});
    ILifiInputSettlerEscrowSolver(LIFI_INPUT_SETTLER).finalise(_order, solveParams, solver, "");
    vm.stopPrank();
  }
}

struct LifiSolveParams {
  uint32 timestamp;
  bytes32 solver;
}

enum LifiOrderStatus {
  None,
  Deposited,
  Claimed,
  Refunded
}

interface ILifiInputSettlerEscrowSolver is ILifiInputSettlerEscrow {
  function orderStatus(bytes32 orderId) external view returns (LifiOrderStatus);

  function orderIdentifier(StandardOrder calldata order) external view returns (bytes32);

  function finalise(
    StandardOrder calldata order,
    LifiSolveParams[] calldata solveParams,
    bytes32 destination,
    bytes calldata call
  ) external;

  function refund(StandardOrder calldata order) external;
}

interface ILifiOutputSettler {
  function fill(bytes32 orderId, MandateOutput calldata output, uint48 fillDeadline, bytes calldata fillerData)
    external
    payable
    returns (bytes32 fillRecordHash);

  function setAttestation(bytes32 orderId, bytes32 solver, uint32 timestamp, MandateOutput calldata output) external;
}
