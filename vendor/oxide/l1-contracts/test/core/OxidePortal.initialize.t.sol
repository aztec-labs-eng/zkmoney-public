// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortal} from "@core/OxidePortal.sol";
import {Ownable} from "@oz/access/Ownable.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@core/lib/Errors.sol";

contract OxidePortalInitializeTest is OxidePortalBase {
  function test_GivenPortalIsUninitialized_WhenOwnerInitializes() external {
    vm.expectEmit(true, true, true, true, address(portal));
    emit Initialized(L2_PORTAL);

    _initialize();

    assertEq(portal.$l2Portal(), L2_PORTAL);
    assertTrue(portal.$initialized());
  }

  function test_GivenPortalIsInitialized_WhenOwnerInitializesAgain() external givenPortalIsInitialized {
    vm.expectRevert(Errors.OxidePortal__AlreadyInitialized.selector);
    vm.prank(OWNER);
    portal.initialize(L2_PORTAL);
  }

  function test_GivenZeroPortal_WhenOwnerInitializes() external {
    vm.expectRevert(Errors.OxidePortal__ZeroL2Portal.selector);
    vm.prank(OWNER);
    portal.initialize(bytes32(0));
  }

  function test_GivenCallerIsNotOwner_WhenInitializeIsCalled() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, USER));
    vm.prank(USER);
    portal.initialize(L2_PORTAL);
  }
}
