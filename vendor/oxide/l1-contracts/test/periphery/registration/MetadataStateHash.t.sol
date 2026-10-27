// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";

contract MetadataStateHashTest is OxidePortalBase {
  address internal constant RECORD_OWNER = 0x1111111111111111111111111111111111111111;
  uint256 internal constant G_X = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
  uint256 internal constant G_Y = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;

  function test_absentRecordHashesToZero() public view {
    assertEq(registrationController.metadataStateHash(RECORD_OWNER), bytes32(0));
  }

  function test_matchesTypeScriptGoldenValue() public {
    AccountMetadataRegistry.UserRecord memory record = AccountMetadataRegistry.UserRecord(
      bytes32(uint256(11)), 7, AccountMetadataRegistry.K1Point(G_X, G_Y), RECORD_OWNER
    );
    vm.prank(RECORD_OWNER);
    metadataRegistry.setUserRecord(RECORD_OWNER, record);
    assertEq(
      registrationController.metadataStateHash(RECORD_OWNER),
      0xecc754413e4e971558638c11f2b4490e9c10d4d6488c247a98555a536fb0c95d
    );
  }
}
