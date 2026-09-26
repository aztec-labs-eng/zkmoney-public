// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

library AccountSignatures {
  Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
  uint256 internal constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
  bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
  bytes32 internal constant PERSONAL_SIGN_TYPEHASH = keccak256("PersonalSign(bytes prefixed)");

  function personalSignDigest(address account, bytes32 hash) internal view returns (bytes32) {
    bytes32 domainSeparator =
      keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("OxideAccount"), keccak256("1"), block.chainid, account));
    bytes32 structHash = keccak256(abi.encode(PERSONAL_SIGN_TYPEHASH, hash));
    return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
  }

  function k1(uint256 privateKey, bytes32 hash) internal pure returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = VM.sign(privateKey, hash);
    return abi.encodePacked(r, s, v);
  }

  function r1(uint256 keyIndex, uint256 privateKey, bytes32 challenge) internal pure returns (bytes memory) {
    return r1(keyIndex, privateKey, challenge, WebAuthn.AUTH_DATA_FLAGS_UP | WebAuthn.AUTH_DATA_FLAGS_UV);
  }

  function r1(uint256 keyIndex, uint256 privateKey, bytes32 challenge, bytes1 flags)
    internal
    pure
    returns (bytes memory)
  {
    WebAuthn.WebAuthnAuth memory auth;
    auth.clientDataJSON =
      string.concat('{"type":"webauthn.get","challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '"}');
    auth.typeIndex = 1;
    auth.challengeIndex = 23;
    auth.authenticatorData = abi.encodePacked(keccak256("rpIdHash"), flags, bytes4(0));

    bytes32 messageHash = sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
    (bytes32 r, bytes32 s) = VM.signP256(privateKey, messageHash);
    if (uint256(s) > P256_N / 2) {
      s = bytes32(P256_N - uint256(s));
    }
    auth.r = r;
    auth.s = s;

    bytes memory encodedAuth =
      abi.encode(auth.r, auth.s, auth.challengeIndex, auth.typeIndex, auth.authenticatorData, auth.clientDataJSON);
    return abi.encodePacked(bytes32(keyIndex), encodedAuth);
  }
}
