// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {ICertManager} from "@nitro-validator/ICertManager.sol";

contract MockCertManager is ICertManager {
  bytes32 public $lastParentCertHash;
  bytes public $lastCert;

  function verifyCACert(bytes memory _cert, bytes32 _parentCertHash) external override returns (bytes32) {
    $lastCert = _cert;
    $lastParentCertHash = _parentCertHash;
    return keccak256(_cert);
  }

  function verifyClientCert(bytes memory, bytes32) external pure override returns (VerifiedCert memory) {
    revert("unused");
  }
}
