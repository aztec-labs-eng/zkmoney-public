// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {MetadataUpdateIntent} from "@periphery/interfaces/IAccountMetadataController.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {RegistrationController} from "@periphery/RegistrationController.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {INamePortal} from "@periphery/interfaces/INamePortal.sol";
import {IOxideAccountFactory} from "@periphery/interfaces/IOxideAccountFactory.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MetadataEncodingTest is Test {
  function test_matchesTypeScriptMetadataUpdateGoldenVectorsAndAccountSignature() public {
    vm.chainId(31_337);
    address owner = 0x1111111111111111111111111111111111111111;
    bytes memory metadata = abi.encode(
      AccountMetadataRegistry.UserRecord(bytes32(uint256(11)), 7, AccountMetadataRegistry.K1Point(1, 2), owner)
    );
    assertEq(keccak256(metadata), 0xd428e7e866b6c6cb6cbac2eb76f978e732d0fcfc83586e12f2d8c93ac2cb0b24);
    bytes memory data = abi.encode(
      MetadataUpdateIntent(
        owner,
        0x2222222222222222222222222222222222222222,
        metadata,
        bytes32(0),
        7,
        0x3333333333333333333333333333333333333333,
        bytes32(uint256(12)),
        bytes32(uint256(13))
      )
    );
    assertEq(keccak256(data), 0xe76974e07340706f1fe3e0850e9dad7277d239e86e3c66525b2a025bdc372267);
    RegistrationController controller = new RegistrationController(
      INameRegistry(0x4444444444444444444444444444444444444444),
      SIPAFactory(address(1)),
      IOxideAccountFactory(address(1)),
      INamePortal(address(1)),
      IERC20(address(1)),
      1,
      1,
      address(1)
    );
    bytes32 digest = controller.metadataUpdateDigest(data, 0x5555555555555555555555555555555555555555);
    assertEq(digest, 0x516e25812720e14e4f588aad695ecc64ab3ee0e56e892473025853e4c063547f);
    address clone = new OxideAccountFactory().deploy(vm.addr(123));
    vm.etch(owner, clone.code);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(123, 0x0e940a7296984481abfae1ca8750cafb4d0448d7fde938bf22906a8b545695b9);
    assertEq(OxideAccount(payable(owner)).isValidSignature(digest, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
  }
}
