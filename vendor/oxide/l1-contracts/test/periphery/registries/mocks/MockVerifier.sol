// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";

contract MockVerifier is IVerifier {
  bool internal result = true;

  function setResult(bool _result) external {
    result = _result;
  }

  function verify(bytes calldata, bytes32[] calldata) external view override returns (bool) {
    return result;
  }
}
