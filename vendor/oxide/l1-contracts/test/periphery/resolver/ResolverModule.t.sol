// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistriesTestBase} from "@test/periphery/registries/RegistriesTestBase.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {Resolver} from "@periphery/Resolver.sol";
import {IExtendedResolver} from "@periphery/interfaces/IExtendedResolver.sol";
import {ISupportsInterface} from "@periphery/interfaces/ISupportsInterface.sol";
import {Errors} from "@periphery/Errors.sol";

contract ResolverConstructionTest is RegistriesTestBase {
  function test_constructorWiresImmutables() public view {
    assertEq(address(resolver.NAME_REGISTRY()), address(nameRegistry));
    assertEq(address(resolver.SIPA_FACTORY()), address(sipaFactory));
    assertEq(address(resolver.VERIFIER()), address(verifier));
  }

  function test_supportsInterface() public view {
    assertTrue(resolver.supportsInterface(type(IExtendedResolver).interfaceId));
    assertTrue(resolver.supportsInterface(type(ISupportsInterface).interfaceId));
    assertFalse(resolver.supportsInterface(0xffffffff));
    assertFalse(resolver.supportsInterface(0xdeadbeef));
  }
}

contract ResolverPointerTest is RegistriesTestBase {
  bytes internal name = hex"05616c696365056f7869646503657468";
  bytes internal data;

  function setUp() public override {
    super.setUp();
    _registerDefaultResolverOperator();
    _registerDefaultUser();
    data = abi.encodeWithSelector(ADDR_SELECTOR, NAME_HASH);
  }

  function _expectOffchainLookup(Resolver module) internal {
    string[] memory urls = new string[](1);
    urls[0] = RESOLVER_OPERATOR_URL;
    bytes memory callData = abi.encodeWithSelector(Resolver.resolve.selector, name, data);
    vm.expectRevert(
      abi.encodeWithSelector(
        Resolver.OffchainLookup.selector,
        address(module),
        urls,
        callData,
        Resolver.resolveWithProof.selector,
        abi.encode(NAME_HASH, false)
      )
    );
  }

  function test_oldModuleStillResolvesAfterLatestMoves() public {
    Resolver newModule = new Resolver(nameRegistry, sipaFactory, verifier);
    vm.prank(registryOwner);
    nameRegistry.updateResolver(address(newModule));

    _expectOffchainLookup(resolver);
    resolver.resolve(name, data);
  }

  function test_newModuleResolvesExistingRecords() public {
    Resolver newModule = new Resolver(nameRegistry, sipaFactory, verifier);
    vm.prank(registryOwner);
    nameRegistry.updateResolver(address(newModule));

    _expectOffchainLookup(newModule);
    newModule.resolve(name, data);
  }

  function test_nameWithoutRecordDoesNotResolve() public {
    _claimName(NAME_HASH_2, userAddr2);
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__UserRecordNotFound.selector, userAddr2));
    resolver.resolve(name, abi.encodeWithSelector(ADDR_SELECTOR, NAME_HASH_2));
  }

  function test_followsMetadataRegistryPointer() public {
    AccountMetadataRegistry fresh = new AccountMetadataRegistry(nameRegistry);
    vm.prank(registryOwner);
    nameRegistry.updateAccountMetadataRegistry(address(fresh));

    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__UserRecordNotFound.selector, userAddr));
    resolver.resolve(name, data);

    vm.prank(resolverOperatorAddr);
    fresh.setResolverOperator(_resolverOperatorFixture());
    vm.prank(userAddr);
    fresh.setUserRecord(userAddr, _recordFixture());

    _expectOffchainLookup(resolver);
    resolver.resolve(name, data);
  }
}
