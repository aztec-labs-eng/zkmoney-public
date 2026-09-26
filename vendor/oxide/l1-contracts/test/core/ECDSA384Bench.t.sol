// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test, stdJson} from "forge-std/Test.sol";
import {ECDSA384} from "@solarity/libs/crypto/ECDSA384.sol";
import {ECDSA384Curve} from "@nitro-validator/ECDSA384Curve.sol";
import {ECDSA384Jacobian} from "@core/lib/ECDSA384Jacobian.sol";
import {Asn1Decode, Asn1Ptr, LibAsn1Ptr} from "@nitro-validator/Asn1Decode.sol";
import {Sha2Ext} from "@nitro-validator/Sha2Ext.sol";

contract Harness {
  function verifyAffine(bytes calldata hash, bytes calldata sig, bytes calldata pubKey) external view returns (bool) {
    return ECDSA384.verify(ECDSA384Curve.p384(), hash, sig, pubKey);
  }

  function verifyJacobian(bytes calldata hash, bytes calldata sig, bytes calldata pubKey) external view returns (bool) {
    ECDSA384Jacobian.Parameters memory params = ECDSA384Jacobian.Parameters({
      a: ECDSA384Curve.CURVE_A,
      b: ECDSA384Curve.CURVE_B,
      gx: ECDSA384Curve.CURVE_GX,
      gy: ECDSA384Curve.CURVE_GY,
      p: ECDSA384Curve.CURVE_P,
      n: ECDSA384Curve.CURVE_N,
      lowSmax: ECDSA384Curve.CURVE_LOW_S_MAX
    });
    return ECDSA384Jacobian.verify(params, hash, sig, pubKey);
  }
}

contract ECDSA384BenchTest is Test {
  using stdJson for string;
  using Asn1Decode for bytes;
  using LibAsn1Ptr for Asn1Ptr;

  Harness internal harness;
  bytes internal hash;
  bytes internal sig;
  bytes internal pubKey;

  function setUp() public {
    harness = new Harness();

    string memory rootJson = vm.readFile("test/fixtures/test_attestation/root_args.json");
    pubKey = rootJson.readBytes(".pubKey");

    bytes memory cert = vm.readFileBinary("test/fixtures/test_attestation/cabundle/00.der");
    Asn1Ptr root = cert.root();
    Asn1Ptr tbsCertPtr = cert.firstChildOf(root);

    hash = Sha2Ext.sha384(cert, tbsCertPtr.header(), tbsCertPtr.totalLength());

    Asn1Ptr sigAlgoPtr = cert.nextSiblingOf(tbsCertPtr);
    Asn1Ptr sigPtr = cert.nextSiblingOf(sigAlgoPtr);
    Asn1Ptr sigBPtr = cert.bitstring(sigPtr);
    Asn1Ptr sigRoot = cert.rootOf(sigBPtr);
    Asn1Ptr sigRPtr = cert.firstChildOf(sigRoot);
    Asn1Ptr sigSPtr = cert.nextSiblingOf(sigRPtr);
    (uint128 rhi, uint256 rlo) = cert.uint384At(sigRPtr);
    (uint128 shi, uint256 slo) = cert.uint384At(sigSPtr);
    sig = abi.encodePacked(rhi, rlo, shi, slo);

    string memory summary = vm.readFile("test/fixtures/test_attestation/summary.json");
    vm.warp(vm.parseUint(summary.readString(".timestampMillis")) / 1000);
  }

  function test_AffineVerify() external view {
    assertTrue(harness.verifyAffine(hash, sig, pubKey));
  }

  function test_JacobianVerify() external view {
    assertTrue(harness.verifyJacobian(hash, sig, pubKey));
  }
}
