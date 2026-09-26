// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {RegistriesTestBase} from "@test/periphery/registries/RegistriesTestBase.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {Resolver} from "@periphery/Resolver.sol";

contract RegistryWithTrailingDepositFeeStore {
  struct ResolverOperatorWithDepositFeeStore {
    AccountMetadataRegistry.K1Point publicKey;
    bytes32 l2Address;
    string url;
    address oxidePortal;
    address depositFeeStore;
  }

  mapping(address => ResolverOperatorWithDepositFeeStore) public entries;
  mapping(address => AccountMetadataRegistry.UserRecord) public records;

  function setResolverOperator(address operator, ResolverOperatorWithDepositFeeStore calldata entry) external {
    entries[operator] = entry;
  }

  function setUserRecord(address user, AccountMetadataRegistry.UserRecord calldata record) external {
    records[user] = record;
  }

  function getResolverOperator(address operator) external view returns (ResolverOperatorWithDepositFeeStore memory) {
    return entries[operator];
  }

  function getUserRecord(address user) external view returns (AccountMetadataRegistry.UserRecord memory) {
    return records[user];
  }
}

contract PreservedMetadataRegistryTest is RegistriesTestBase {
  bytes internal name = hex"05616c696365056f7869646503657468";
  bytes internal data;
  RegistryWithTrailingDepositFeeStore internal preserved;

  function setUp() public override {
    super.setUp();
    data = abi.encodeWithSelector(ADDR_SELECTOR, NAME_HASH);

    preserved = new RegistryWithTrailingDepositFeeStore();
    preserved.setResolverOperator(
      resolverOperatorAddr,
      RegistryWithTrailingDepositFeeStore.ResolverOperatorWithDepositFeeStore({
        publicKey: AccountMetadataRegistry.K1Point(RESOLVER_OPERATOR_PUBLIC_KEY_X, RESOLVER_OPERATOR_PUBLIC_KEY_Y),
        l2Address: RESOLVER_OPERATOR_L2_ADDRESS,
        url: RESOLVER_OPERATOR_URL,
        oxidePortal: address(mockPortal),
        depositFeeStore: makeAddr("depositFeeStore")
      })
    );
    preserved.setUserRecord(userAddr, _recordFixture());

    _claimName(NAME_HASH, userAddr);
    vm.prank(registryOwner);
    nameRegistry.updateAccountMetadataRegistry(address(preserved));
  }

  function test_resolvesAgainstARegistryWhoseResolverOperatorCarriesATrailingDepositFeeStore() public {
    string[] memory urls = new string[](1);
    urls[0] = RESOLVER_OPERATOR_URL;
    vm.expectRevert(
      abi.encodeWithSelector(
        Resolver.OffchainLookup.selector,
        address(resolver),
        urls,
        abi.encodeWithSelector(Resolver.resolve.selector, name, data),
        Resolver.resolveWithProof.selector,
        abi.encode(NAME_HASH)
      )
    );
    resolver.resolve(name, data);
  }
}
