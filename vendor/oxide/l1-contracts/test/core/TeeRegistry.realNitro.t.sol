// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TeeRegistry} from "@core/TeeRegistry.sol";
import {CertManager} from "@core/lib/CertManager.sol";
import {NitroValidator} from "@core/lib/NitroValidator.sol";
import {CborElement, LibCborElement} from "@nitro-validator/CborDecode.sol";
import {ICertManager} from "@nitro-validator/ICertManager.sol";
import {INitroValidator} from "@core/lib/TEERegistrationLib.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IHaveVersion, IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {Test} from "forge-std/Test.sol";
import {MockInbox} from "@test/fixtures/MockInbox.sol";
import {MockRegistry} from "@test/fixtures/MockRegistry.sol";
import {MockRollup} from "@test/fixtures/MockRollup.sol";
import {Errors} from "@core/lib/Errors.sol";

using LibCborElement for CborElement;

interface IRealNitroValidator is INitroValidator {
  function decodeAttestationTbs(bytes memory attestation)
    external
    pure
    returns (bytes memory attestationTbs, bytes memory signature);
}

contract TeeRegistryRealNitroTest is Test {
  uint64 internal constant FIXTURE_TIMESTAMP_MILLIS = 1_779_963_864_046;
  bytes internal constant FIXTURE_PCR0 =
    hex"25f70b2d696c015bd27f375c802265804a55ab185487e3f2a0f99fdeb16f71d17e5cd99eceb6b089bf5d39bced50bf3d";
  bytes32 internal constant FIXTURE_USER_DATA = 0x2b524bb4a746675d462c482e415f9dea60bc0e0c31ef85cc7207f890134c5fd1;

  bytes32 internal constant FIXTURE_ENC_PUB_KEY_X = 0xee9569836aa098c9a8cd87b6f27437ab7736022da38902400371a286f0a667f5;
  bytes32 internal constant FIXTURE_ENC_PUB_KEY_Y = 0x5d3b9c0e4f7a2bd14e96f8c7a25b3df9e8c0a162b574d3f80a91cb3a78e6f124;

  string internal constant ATTESTATION_PATH = "test/fixtures/sample_attestation/attestation.cose";

  bytes32 internal constant L2_RECIPIENT = bytes32(uint256(0x4a12));
  uint256 internal constant ROLLUP_VERSION = 7;

  TeeRegistry internal registry;
  MockInbox internal inbox;
  ICertManager internal awsCertManager;
  IRealNitroValidator internal nitroValidator;

  function setUp() public {
    inbox = new MockInbox();
    MockRollup rollup = new MockRollup();
    rollup.setInbox(IInbox(address(inbox)));
    MockRegistry rollupRegistry = new MockRegistry();
    rollupRegistry.setRollup(ROLLUP_VERSION, IHaveVersion(address(rollup)));

    awsCertManager = ICertManager(address(new CertManager()));

    nitroValidator = IRealNitroValidator(address(new NitroValidator(awsCertManager)));

    registry = new TeeRegistry(
      keccak256(FIXTURE_PCR0),
      awsCertManager,
      nitroValidator,
      IRegistry(address(rollupRegistry)),
      ROLLUP_VERSION,
      L2_RECIPIENT
    );

    vm.warp(FIXTURE_TIMESTAMP_MILLIS / 1000);
  }

  function test_GivenRealNitroFixture_WhenAttestationIsValidated_ThenStructuralFieldsMatch() external {
    (bytes memory attestationTbs, bytes memory signature) = _readAttestation();

    INitroValidator.Ptrs memory ptrs = nitroValidator.validateAttestation(attestationTbs, signature);

    assertEq(ptrs.timestamp, FIXTURE_TIMESTAMP_MILLIS);
    assertEq(ptrs.pcrs.length, 16);
    assertEq(_slice(attestationTbs, ptrs.pcrs[0].start(), ptrs.pcrs[0].length()), FIXTURE_PCR0);

    assertTrue(ptrs.publicKey.isNull());
    assertEq(ptrs.userData.length(), 32);
    assertEq(_slice(attestationTbs, ptrs.userData.start(), 32), abi.encodePacked(FIXTURE_USER_DATA));
  }

  function test_GivenRealNitroFixture_WhenRegisterTeeIsCalled_ThenUserDataMismatchReverts() external {
    bytes32 generatorX = bytes32(0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798);
    bytes32 generatorY = bytes32(0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8);

    (bytes memory attestationTbs, bytes memory signature) = _readAttestation();

    vm.expectRevert(Errors.TEERegistration__InvalidTEERegistrationUserData.selector);
    registry.registerTee(
      attestationTbs, signature, generatorX, generatorY, FIXTURE_ENC_PUB_KEY_X, FIXTURE_ENC_PUB_KEY_Y
    );
  }

  function _readAttestation() internal view returns (bytes memory attestationTbs, bytes memory signature) {
    return nitroValidator.decodeAttestationTbs(vm.readFileBinary(ATTESTATION_PATH));
  }

  function _slice(bytes memory _data, uint256 _start, uint256 _length) internal pure returns (bytes memory out) {
    out = new bytes(_length);
    for (uint256 i = 0; i < _length; i++) {
      out[i] = _data[_start + i];
    }
  }
}
