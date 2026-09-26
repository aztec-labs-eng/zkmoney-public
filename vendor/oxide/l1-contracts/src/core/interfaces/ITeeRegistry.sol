// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

interface ITeeRegistry {
  function PCR0_HASH() external view returns (bytes32);

  function verifyTeeCACert(bytes calldata _cert, bytes32 _parentCertHash) external returns (bytes32 certHash);

  function verifyTeeClientCert(bytes calldata _cert, bytes32 _parentCertHash) external returns (bytes32 certHash);

  function verifyTeeAttestationHash(bytes calldata _attestationTbs) external returns (bytes32 attestationTbsKeccak);

  function verifyTeeAttestationSig(bytes32 _attestationTbsKeccak, bytes calldata _signature, bytes32 _leafCertHash)
    external;

  function registerTee(
    bytes calldata _attestationTbs,
    bytes calldata _signature,
    bytes32 _teePubKeyX,
    bytes32 _teePubKeyY,
    bytes32 _encPubKeyX,
    bytes32 _encPubKeyY
  ) external returns (bytes32 key, uint256 index);

  function isTeeRegistered(address _tee) external view returns (bool);
}
