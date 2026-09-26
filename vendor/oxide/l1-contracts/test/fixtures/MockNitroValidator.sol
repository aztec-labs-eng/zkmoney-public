// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {CborElement} from "@nitro-validator/CborDecode.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {INitroValidator} from "@core/lib/TEERegistrationLib.sol";

contract MockNitroValidator is INitroValidator {
  ICertManager public certManager;

  Ptrs internal $ptrs;

  function setCertManager(ICertManager _certManager) external {
    certManager = _certManager;
  }

  function setPtrs(Ptrs memory _ptrs) external {
    $ptrs = _ptrs;
  }

  function setRegistrationPtrs(uint64 _timestampMillis, uint256 _pcr0Start, uint256 _userDataStart) external {
    CborElement[] memory pcrs = new CborElement[](1);
    pcrs[0] = _ptr(0x40, _pcr0Start, 48);
    $ptrs = Ptrs({
      moduleID: CborElement.wrap(0),
      timestamp: _timestampMillis,
      digest: CborElement.wrap(0),
      pcrs: pcrs,
      cert: CborElement.wrap(0),
      cabundle: new CborElement[](0),
      publicKey: CborElement.wrap(uint256(0xf6)),
      userData: _ptr(0x40, _userDataStart, 32),
      nonce: CborElement.wrap(uint256(0xf6))
    });
  }

  function validateAttestation(bytes memory, bytes memory) external view override returns (Ptrs memory) {
    return $ptrs;
  }

  function verifyAttestationHash(bytes calldata attestationTbs) external pure override returns (bytes32) {
    return keccak256(attestationTbs);
  }

  function verifyAttestationSignature(bytes32, bytes calldata, bytes32) external pure override {}

  function ptr(uint256 _type, uint256 _start, uint256 _length) external pure returns (CborElement) {
    return _ptr(_type, _start, _length);
  }

  function _ptr(uint256 _type, uint256 _start, uint256 _length) internal pure returns (CborElement) {
    return CborElement.wrap(_type | _start << 80 | _length << 160);
  }
}
