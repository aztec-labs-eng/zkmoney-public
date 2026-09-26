// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {console2} from "forge-std/console2.sol";

import {RegistrationTestBase} from "./RegistrationTestBase.sol";
import {OxideAccount} from "@periphery/OxideAccount.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

contract R1InstallGasTest is RegistrationTestBase {
  uint256 internal constant METADATA_WORDS = 8;
  uint256 internal constant GENEROUS_GAS = 5_000_000;
  uint256 internal constant HEADROOM_PERCENT = 125;

  function setUp() public override {
    super.setUp();
    accountFactory.deploy(bootstrap);
  }

  function test_verificationGasCoversTheValidationPhaseWithBoundedHeadroom() external {
    uint256 measured = _minGas(true, "");
    uint256 pinned = registrationController.R1_INSTALL_VERIFICATION_GAS();
    console2.log("r1 install, verification phase measured", measured, "pinned", pinned);
    assertGe(pinned, measured, "R1_INSTALL_VERIFICATION_GAS sits under the validation phase: every install fails AA26");
    assertLe(
      pinned,
      (measured * HEADROOM_PERCENT) / 100,
      "R1_INSTALL_VERIFICATION_GAS has drifted well above the validation phase"
    );
  }

  function test_callGasCoversAddAuthKeyWithBoundedHeadroom() external {
    uint256 base = _minGas(false, "");
    uint256 withMetadata = _minGas(false, _metadata(METADATA_WORDS * 32));
    uint256 perWord = (withMetadata - base + METADATA_WORDS - 1) / METADATA_WORDS;
    uint256 pinnedBase = registrationController.R1_INSTALL_CALL_GAS_BASE();
    uint256 pinnedPerWord = registrationController.R1_INSTALL_CALL_GAS_PER_WORD();
    console2.log("r1 install, addAuthKey measured base", base, "pinned", pinnedBase);
    console2.log("r1 install, addAuthKey measured per word", perWord, "pinned", pinnedPerWord);
    assertGe(pinnedBase, base, "R1_INSTALL_CALL_GAS_BASE sits under addAuthKey: every install runs out of gas");
    assertLe(pinnedBase, (base * HEADROOM_PERCENT) / 100, "R1_INSTALL_CALL_GAS_BASE has drifted well above addAuthKey");
    assertGe(
      pinnedPerWord, perWord, "R1_INSTALL_CALL_GAS_PER_WORD sits under a metadata word: long metadata runs out of gas"
    );
    assertLe(
      pinnedPerWord,
      (perWord * HEADROOM_PERCENT) / 100,
      "R1_INSTALL_CALL_GAS_PER_WORD has drifted well above a metadata word"
    );
  }

  function test_callGasCoversEveryMetadataLayout() external {
    uint256[4] memory lengths = [uint256(31), 32, 64, 256];
    for (uint256 i = 0; i < lengths.length; i++) {
      uint256 measured = _minGas(false, _metadata(lengths[i]));
      uint256 allotted = _r1InstallCallGas(lengths[i]);
      console2.log("r1 install, addAuthKey metadata bytes", lengths[i], "measured", measured);
      console2.log("r1 install, addAuthKey metadata bytes", lengths[i], "allotted", allotted);
      assertGe(allotted, measured, "the install call gas sits under this metadata length: the install runs out of gas");
    }
  }

  function _metadata(uint256 length) internal pure returns (bytes memory metadata) {
    metadata = new bytes(length);
    for (uint256 i = 0; i < length; i++) {
      metadata[i] = bytes1(uint8(i + 1));
    }
  }

  function _minGas(bool verification, bytes memory metadata) internal returns (uint256 lo) {
    uint256 hi = GENEROUS_GAS;
    require(
      _installs(verification ? hi : GENEROUS_GAS, verification ? GENEROUS_GAS : hi, metadata),
      "generous gas must install"
    );
    while (lo < hi) {
      uint256 mid = (lo + hi) / 2;
      bool ok = verification ? _installs(mid, GENEROUS_GAS, metadata) : _installs(GENEROUS_GAS, mid, metadata);
      if (ok) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
  }

  function _installs(uint256 verificationGas, uint256 callGas, bytes memory metadata) internal returns (bool ok) {
    uint256 snapshot = vm.snapshotState();
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0].sender = defaultOwner;
    ops[0].nonce = entryPoint.getNonce(defaultOwner, 0);
    ops[0].callData = abi.encodeCall(OxideAccount.addAuthKey, (r1Key, metadata));
    ops[0].accountGasLimits = bytes32((verificationGas << 128) | callGas);
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(bootstrapKey, entryPoint.getUserOpHash(ops[0]));
    ops[0].signature = abi.encodePacked(r, s, v);
    try entryPoint.handleOps(ops, payable(defaultOwner)) {
      ok = OxideAccount(payable(defaultOwner)).authKeyCount() == 1;
    } catch {
      ok = false;
    }
    vm.revertToState(snapshot);
  }
}
