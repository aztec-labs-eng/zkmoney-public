// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {MockPortal} from "@test/mocks/MockPortal.sol";
import {RegistriesTestBase} from "@test/periphery/registries/RegistriesTestBase.sol";
import {Errors} from "@periphery/Errors.sol";

contract ResolverOperatorsTest is RegistriesTestBase {
  function test_storesEntryKeyedBySender() public {
    _registerDefaultResolverOperator();

    AccountMetadataRegistry.ResolverOperator memory stored = metadataRegistry.getResolverOperator(resolverOperatorAddr);
    assertEq(stored.url, RESOLVER_OPERATOR_URL);
    assertEq(stored.oxidePortal, address(mockPortal));
    assertEq(stored.publicKey.x, RESOLVER_OPERATOR_PUBLIC_KEY_X);
    assertEq(stored.publicKey.y, RESOLVER_OPERATOR_PUBLIC_KEY_Y);
    assertEq(stored.l2Address, RESOLVER_OPERATOR_L2_ADDRESS);

    address other = makeAddr("other");
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__ResolverOperatorNotFound.selector, other));
    metadataRegistry.getResolverOperator(other);
  }

  function test_emitsSnapshotEvent() public {
    AccountMetadataRegistry.ResolverOperator memory entry = _resolverOperatorFixture();
    vm.expectEmit(address(metadataRegistry));
    emit AccountMetadataRegistry.ResolverOperatorUpdated(resolverOperatorAddr, entry);
    vm.prank(resolverOperatorAddr);
    metadataRegistry.setResolverOperator(entry);
  }

  function test_twoSendersDoNotCollide() public {
    _registerDefaultResolverOperator();

    address second = makeAddr("secondResolverOperator");
    AccountMetadataRegistry.ResolverOperator memory entry = _resolverOperatorFixture();
    entry.url = "https://second.example.com";
    vm.prank(second);
    metadataRegistry.setResolverOperator(entry);

    assertEq(metadataRegistry.getResolverOperator(resolverOperatorAddr).url, RESOLVER_OPERATOR_URL);
    assertEq(metadataRegistry.getResolverOperator(second).url, "https://second.example.com");
  }

  function test_replacesAllFields() public {
    _registerDefaultResolverOperator();

    AccountMetadataRegistry.ResolverOperator memory updated = _resolverOperatorFixture();
    updated.url = "https://new.example.com";
    updated.l2Address = keccak256("resolverOperator-l2-address-2");
    updated.oxidePortal = address(new MockPortal(mockUnderlying, ROLLUP_VERSION + 1));
    updated.publicKey = AccountMetadataRegistry.K1Point(G_X, G_Y);

    vm.expectEmit(address(metadataRegistry));
    emit AccountMetadataRegistry.ResolverOperatorUpdated(resolverOperatorAddr, updated);
    vm.prank(resolverOperatorAddr);
    metadataRegistry.setResolverOperator(updated);

    AccountMetadataRegistry.ResolverOperator memory stored = metadataRegistry.getResolverOperator(resolverOperatorAddr);
    assertEq(stored.url, updated.url);
    assertEq(stored.l2Address, updated.l2Address);
    assertEq(stored.oxidePortal, updated.oxidePortal);
    assertEq(stored.publicKey.x, updated.publicKey.x);
    assertEq(stored.publicKey.y, updated.publicKey.y);
  }

  function test_revertsOnEmptyURL() public {
    AccountMetadataRegistry.ResolverOperator memory entry = _resolverOperatorFixture();
    entry.url = "";
    vm.prank(resolverOperatorAddr);
    vm.expectRevert(Errors.AccountMetadataRegistry__EmptyResolverOperatorURL.selector);
    metadataRegistry.setResolverOperator(entry);
  }

  function test_revertsOnOffCurvePublicKey() public {
    AccountMetadataRegistry.ResolverOperator memory entry = _resolverOperatorFixture();
    entry.publicKey = AccountMetadataRegistry.K1Point(5, G_Y);
    vm.prank(resolverOperatorAddr);
    vm.expectRevert(Errors.AccountMetadataRegistry__InvalidPublicKey.selector);
    metadataRegistry.setResolverOperator(entry);
  }

  function test_revertsOnEmptyOxidePortal() public {
    AccountMetadataRegistry.ResolverOperator memory entry = _resolverOperatorFixture();
    entry.oxidePortal = address(0);
    vm.prank(resolverOperatorAddr);
    vm.expectRevert(Errors.AccountMetadataRegistry__EmptyOxidePortal.selector);
    metadataRegistry.setResolverOperator(entry);
  }

  function test_revertsOnEmptyL2Address() public {
    AccountMetadataRegistry.ResolverOperator memory entry = _resolverOperatorFixture();
    entry.l2Address = bytes32(0);
    vm.prank(resolverOperatorAddr);
    vm.expectRevert(Errors.AccountMetadataRegistry__EmptyResolverOperatorL2Address.selector);
    metadataRegistry.setResolverOperator(entry);
  }
}
