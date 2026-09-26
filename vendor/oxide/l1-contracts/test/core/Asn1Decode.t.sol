// SPDX-License-Identifier: MIT
pragma solidity ^0.8.15;
import {Test} from "forge-std/Test.sol";

import {Asn1Decode, Asn1Ptr} from "@core/lib/Asn1Decode.sol";

contract Asn1DecodeUint384AtTest is Test {
  using Asn1Decode for bytes;

  function test_uint384At_shortTopZeroByteRightAligns() public pure {
    bytes memory der =
      hex"023000ab018ef9cfb87f70149b9bde3148afe8f479d0d0498bede6f7b84255c8383dccc68c9014959b0c198165360c6a626a";
    (uint128 hi, uint256 lo) = der.uint384At(der.root());
    assertEq(
      abi.encodePacked(hi, lo),
      hex"00ab018ef9cfb87f70149b9bde3148afe8f479d0d0498bede6f7b84255c8383dccc68c9014959b0c198165360c6a626a"
    );
  }

  function test_uint384At_fullWidthValueUnchanged() public pure {
    bytes memory der =
      hex"023100f86b8b0558a6862f8e6453a7da9753490e0aa438a82a3e4f01e6f9fb478d467b69f84ddf5504cdda90f2347c9782438e";
    (uint128 hi, uint256 lo) = der.uint384At(der.root());
    assertEq(
      abi.encodePacked(hi, lo),
      hex"f86b8b0558a6862f8e6453a7da9753490e0aa438a82a3e4f01e6f9fb478d467b69f84ddf5504cdda90f2347c9782438e"
    );
  }
}
