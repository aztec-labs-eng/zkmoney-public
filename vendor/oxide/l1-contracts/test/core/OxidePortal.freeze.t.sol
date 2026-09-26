// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortal} from "@core/OxidePortal.sol";
import {IHaveVersion} from "@aztec/governance/interfaces/IRegistry.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortalFreezeTest is OxidePortalBase {
  function test_GivenPortalIsUninitialized_WhenFreezeIsCalled() external {
    vm.expectRevert(Errors.OxidePortal__Uninitialized.selector);
    vm.prank(OWNER);
    portal.freeze();
  }

  function test_GivenCallerIsOwner_WhenFreezeIsCalled() external givenPortalIsInitialized {
    _setCheckpoint(4);
    outbox.setRoot(4, 1, bytes32(uint256(0xAA)));
    outbox.setRoot(4, 3, bytes32(uint256(0xBB)));

    vm.expectEmit(true, true, true, true, address(portal));
    emit Frozen(DEFAULT_CHECKPOINT_NUMBER, 4, DEFAULT_ARCHIVE_ROOT, 3);

    vm.prank(OWNER);
    portal.freeze();

    assertTrue(portal.$frozen());
    assertEq(portal.$freezeCheckpointNumber(), DEFAULT_CHECKPOINT_NUMBER);
    assertEq(portal.$freezeEpochNumber(), 4);
    assertEq(portal.$freezeArchive(), DEFAULT_ARCHIVE_ROOT);
    assertEq(portal.$freezeCheckpointCount(), 3);
  }

  function test_GivenCallerIsNotOwnerAndRollupIsCanonical_WhenFreezeIsCalled() external givenPortalIsInitialized {
    vm.expectRevert(Errors.OxidePortal__RollupStillCanonical.selector);
    vm.prank(USER);
    portal.freeze();
  }

  function test_GivenCallerIsNotOwnerAndRollupIsNonCanonical_WhenFreezeIsCalled()
    external
    givenPortalIsInitialized
    givenRollupIsNonCanonical
  {
    vm.prank(USER);
    portal.freeze();

    assertTrue(portal.$frozen());
  }

  function test_GivenPortalIsAlreadyFrozen_WhenFreezeIsCalled() external givenPortalIsInitialized givenPortalIsFrozen {
    registry.setCanonicalRollup(IHaveVersion(address(0xBEEF)));

    vm.expectRevert(Errors.OxidePortal__AlreadyFrozen.selector);
    vm.prank(USER);
    portal.freeze();
  }
}
