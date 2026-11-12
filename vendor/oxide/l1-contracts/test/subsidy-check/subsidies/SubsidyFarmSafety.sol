// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";

contract FarmCaller {
  function forward(address _target, bytes calldata _data) external returns (bytes memory) {
    return Address.functionCall(_target, _data);
  }
}

contract FarmBatch {
  function callEach(address _target, bytes[] calldata _calls) external {
    for (uint256 i = 0; i < _calls.length; i++) {
      Address.functionCall(_target, _calls[i]);
    }
  }
}

contract FarmConstructorCaller {
  constructor(address _executor, bytes[] memory _calls) {
    for (uint256 i = 0; i < _calls.length; i++) {
      Address.functionCall(_executor, _calls[i]);
    }
  }
}

contract RevisedOperationExecutor is OperationExecutor {
  function revision() external pure returns (uint256) {
    return 2;
  }
}

abstract contract SubsidyFarmSafety is Test {
  uint256 internal constant RELAYER = 0;
  uint256 internal constant CONTRACT_CALLER = 1;
  uint256 internal constant DELEGATED_EOA = 2;
  uint256 internal constant BATCH = 3;
  uint256 internal constant CALLING_TARGET = 4;
  uint256 internal constant SAME_CODE_EXECUTOR = 5;
  uint256 internal constant OTHER_CODE_EXECUTOR = 6;
  uint256 internal constant DIRECT_CALL = 7;
  uint256 internal constant NESTED_EXECUTE = 8;
  uint256 internal constant OTHER_PAYOUT_TOKEN = 9;
  uint256 internal constant REPLAY = 10;
  uint256 internal constant CONSTRUCTOR_CALLER = 11;
  uint256 internal constant SHARED_SHAPES = 12;

  function _subsidy() internal view virtual returns (address);

  function _payoutToken() internal view virtual returns (IERC20);

  function _executor() internal view virtual returns (OperationExecutor);

  function _pot() internal view virtual returns (uint256);

  function _relayFee() internal view virtual returns (uint256);

  function _stage(uint256 _seed) internal virtual;

  function _relayCall(address _relayer, uint256 _index) internal virtual returns (bytes memory);

  function _ownShapes() internal pure virtual returns (uint256);

  function _sendOwnShape(uint256 _shape, address _caller, uint256 _seed) internal virtual returns (bool);

  function _isRelayerTransaction(uint256 _shape) internal view virtual returns (bool) {
    return _shape == RELAYER;
  }

  function _stillRuns(uint256) internal view virtual returns (bool) {
    return false;
  }

  function _assertTheOperationsRan() internal virtual {}

  function testFuzz_GivenAnyCaller_ThenOnlyARelayerTransactionDrawsFromThePot(
    uint256 _shape,
    uint256 _seed,
    uint256 _caller
  ) external {
    _check(bound(_shape, 0, SHARED_SHAPES + _ownShapes() - 1), _seed, _farmer(_caller));
  }

  function test_GivenEachCaller_ThenOnlyARelayerTransactionDrawsFromThePot() external {
    for (uint256 shape = 0; shape < SHARED_SHAPES + _ownShapes(); shape++) {
      uint256 snapshot = vm.snapshotState();
      _check(shape, shape, _farmer(shape));
      vm.revertToState(snapshot);
    }
  }

  function _farmer(uint256 _seed) internal pure returns (address) {
    return address(uint160(uint256(keccak256(abi.encode("farmer", _seed)))));
  }

  function _check(uint256 _shape, uint256 _seed, address _caller) internal {
    _stage(_seed);
    IERC20 token = _payoutToken();
    bytes memory replayed;
    if (_shape == REPLAY) {
      replayed = _outer(_relayCall(address(_executor()), 0), token);
      uint256 potBeforeTheFirst = _pot();
      assertTrue(_send(_caller, address(_executor()), replayed), "the relayer transaction to replay reverted");
      assertGt(potBeforeTheFirst - _pot(), 0, "the relayer transaction to replay drew nothing from the pot");
    }
    uint256 potBefore = _pot();
    uint256 callerBefore = token.balanceOf(_caller);

    bool landed = _shape == REPLAY ? _send(_caller, address(_executor()), replayed) : _sendShape(_shape, _caller, _seed);

    if (_isRelayerTransaction(_shape)) {
      assertTrue(landed, "a relayer transaction reverted");
      uint256 draw = potBefore - _pot();
      assertGt(draw, 0, "a relayer transaction drew nothing from the pot");
      assertEq(
        token.balanceOf(_caller) - callerBefore, draw + _relayFee(), "the relayer did not get the draw and the fee"
      );
    } else {
      assertEq(_pot(), potBefore, "a call that is not a relayer transaction changed the pot");
      if (_stillRuns(_shape)) {
        assertTrue(landed, "a call that is not a relayer transaction did not run");
        _assertTheOperationsRan();
      }
    }
  }

  function _sendShape(uint256 _shape, address _caller, uint256 _seed) internal returns (bool) {
    if (_shape >= SHARED_SHAPES) {
      return _sendOwnShape(_shape - SHARED_SHAPES, _caller, _seed);
    }
    IERC20 token = _payoutToken();
    if (_shape == SAME_CODE_EXECUTOR || _shape == OTHER_CODE_EXECUTOR) {
      OperationExecutor another =
        _shape == SAME_CODE_EXECUTOR ? new OperationExecutor() : new RevisedOperationExecutor();
      return _send(_caller, address(another), _outer(_relayCall(address(another), 0), token));
    }
    address executor = address(_executor());
    bytes memory relay = _relayCall(executor, 0);
    if (_shape == RELAYER) {
      return _send(_caller, executor, _outer(relay, token));
    }
    if (_shape == CONTRACT_CALLER) {
      FarmCaller forwarder = new FarmCaller();
      return _send(_caller, address(forwarder), abi.encodeCall(FarmCaller.forward, (executor, _outer(relay, token))));
    }
    if (_shape == DELEGATED_EOA) {
      vm.etch(_caller, abi.encodePacked(hex"ef0100", address(new FarmCaller())));
      return _send(_caller, executor, _outer(relay, token));
    }
    if (_shape == BATCH || _shape == CALLING_TARGET) {
      bytes[] memory calls = new bytes[](_shape == BATCH ? 2 : 1);
      calls[0] = relay;
      if (_shape == BATCH) {
        calls[1] = _relayCall(executor, 1);
      }
      address batch = address(new FarmBatch());
      return _send(_caller, executor, _execute(batch, abi.encodeCall(FarmBatch.callEach, (_subsidy(), calls)), token));
    }
    if (_shape == CONSTRUCTOR_CALLER) {
      bytes[] memory relays = new bytes[](2);
      relays[0] = _outer(relay, token);
      relays[1] = _outer(_relayCall(executor, 1), token);
      vm.prank(_caller, _caller);
      try new FarmConstructorCaller(executor, relays) {
        return true;
      } catch {
        return false;
      }
    }
    if (_shape == DIRECT_CALL) {
      return _send(_caller, _subsidy(), relay);
    }
    if (_shape == NESTED_EXECUTE) {
      return _send(_caller, executor, _execute(executor, _outer(relay, token), token));
    }
    IERC20 otherPayout = IERC20(address(new TestERC20("Other", "OTH", address(this))));
    return _send(_caller, executor, _outer(relay, otherPayout));
  }

  function _outer(bytes memory _relay, IERC20 _token) internal view returns (bytes memory) {
    return _execute(_subsidy(), _relay, _token);
  }

  function _execute(address _target, bytes memory _data, IERC20 _token) internal pure returns (bytes memory) {
    return abi.encodeCall(OperationExecutor.execute, (_target, _data, _token, 0, 0, 0));
  }

  function _send(address _caller, address _target, bytes memory _data) internal returns (bool ok) {
    vm.prank(_caller, _caller);
    (ok,) = _target.call(_data);
  }
}
