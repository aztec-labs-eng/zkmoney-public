// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {NameRegistry} from "@periphery/NameRegistry.sol";
import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {RegistrationSIPA, REGISTRATION_SWEEP_FEE} from "@periphery/RegistrationSIPA.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {DomainAuth} from "@periphery/interfaces/INameRegistry.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {Resolver} from "@periphery/Resolver.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";
import {MockPortal} from "@test/mocks/MockPortal.sol";

abstract contract RegistriesTestBase is Test {
  bytes32 internal constant NAME_CLAIM_TYPEHASH =
    keccak256("NameClaim(bytes32 nameHash,address userAddress,uint256 nonce,uint256 deadline)");
  bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

  bytes4 internal constant ADDR_SELECTOR = 0x3b3b57de;

  uint256 internal constant SECP256K1_N = (uint256(OxideConstants.K1_N_HI) << 128) | uint256(OxideConstants.K1_N_LO);
  uint256 internal constant SECP256K1_P = (uint256(OxideConstants.K1_P_HI) << 128) | uint256(OxideConstants.K1_P_LO);

  uint256 internal constant ROLLUP_VERSION = 7;

  bytes32 internal constant NAME_HASH = keccak256("namehash(alice.oxide.eth)");
  bytes32 internal constant USER_L2_ADDRESS =
    bytes32(0x0ead00000000000000000000000000000000000000000000000000000000bee0);
  uint256 internal constant USER_PUBLIC_KEY_X = 0x88e2ddeb04657dbd0edadf9c1f98da3b3895faa1f00527934dd35d17542ffe9b;
  uint256 internal constant USER_PUBLIC_KEY_Y = 0x1e7640d7737e24e36d208effb77e86affe670a9a497aa7fb52bf4e687a17fff4;

  bytes32 internal constant NAME_HASH_2 = keccak256("namehash(bob.oxide.eth)");

  uint256 internal constant G_X = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798;
  uint256 internal constant G_Y = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8;

  uint256 internal constant RESOLVER_OPERATOR_PUBLIC_KEY_X =
    0xbb50e2d89a4ed70663d080659fe0ad4b9bc3e06c17a227433966cb59ceee020d;
  uint256 internal constant RESOLVER_OPERATOR_PUBLIC_KEY_Y =
    0xecddbf6e00192011648d13b1c00af770c0c1bb609d4d3a5c98a43772e0e18ef4;
  bytes32 internal constant RESOLVER_OPERATOR_L2_ADDRESS = keccak256("resolverOperator-l2-address");
  string internal constant RESOLVER_OPERATOR_URL = "https://gateway.example.com/resolve";

  NameRegistry internal nameRegistry;
  AccountMetadataRegistry internal metadataRegistry;
  SIPAFactory internal sipaFactory;
  Resolver internal resolver;
  MockVerifier internal verifier;
  MockPortal internal mockPortal;
  IERC20 internal mockUnderlying;

  address internal registryOwner;
  address internal domainOwner;
  uint256 internal domainOwnerKey;
  address internal resolverOperatorAddr;
  address internal registrationControllerAddr;

  DepositSIPA internal depositSIPAImplementation;
  RegistrationSIPA internal registrationSIPAImplementation;

  address internal userAddr;
  address internal userAddr2;

  uint256 internal nextDomainNonce = 1000;

  function setUp() public virtual {
    vm.warp(1_770_000_000);

    registryOwner = makeAddr("registryOwner");
    (domainOwner, domainOwnerKey) = makeAddrAndKey("domainOwner");
    resolverOperatorAddr = makeAddr("resolverOperator");
    registrationControllerAddr = makeAddr("registrationController");
    userAddr = makeAddr("alice");
    userAddr2 = makeAddr("bob");

    verifier = new MockVerifier();
    mockUnderlying = IERC20(makeAddr("mockUnderlying"));
    mockPortal = new MockPortal(mockUnderlying, ROLLUP_VERSION);
    nameRegistry = new NameRegistry(registryOwner, domainOwner);
    sipaFactory = new SIPAFactory(registryOwner);
    metadataRegistry = new AccountMetadataRegistry(nameRegistry);
    resolver = new Resolver(nameRegistry, sipaFactory, verifier);
    depositSIPAImplementation = new DepositSIPA(IOxidePortal(address(mockPortal)), DEPOSIT_FEE);
    registrationSIPAImplementation = new RegistrationSIPA(
      IOxidePortal(address(mockPortal)), INameRegistry(address(nameRegistry)), REGISTRATION_SWEEP_FEE
    );

    vm.startPrank(registryOwner);
    nameRegistry.updateAccountMetadataRegistry(address(metadataRegistry));
    nameRegistry.updateResolver(address(resolver));
    nameRegistry.updateRegistrationController(registrationControllerAddr);
    sipaFactory.bless(address(depositSIPAImplementation));
    sipaFactory.bless(address(registrationSIPAImplementation));
    vm.stopPrank();
  }

  function _nameClaimDigest(bytes32 nameHash, address userAddress, uint256 nonce, uint256 deadline)
    internal
    view
    returns (bytes32)
  {
    bytes32 domainSeparator = keccak256(
      abi.encode(
        EIP712_DOMAIN_TYPEHASH,
        keccak256(bytes("Oxide NameRegistry")),
        keccak256(bytes("1")),
        block.chainid,
        address(nameRegistry)
      )
    );
    bytes32 structHash = keccak256(abi.encode(NAME_CLAIM_TYPEHASH, nameHash, userAddress, nonce, deadline));
    return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
  }

  function _domainAuthSignedBy(
    uint256 signerKey,
    bytes32 nameHash,
    address userAddress,
    uint256 nonce,
    uint256 deadline
  ) internal view returns (DomainAuth memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, _nameClaimDigest(nameHash, userAddress, nonce, deadline));
    return DomainAuth({nonce: nonce, deadline: deadline, signature: abi.encodePacked(r, s, v)});
  }

  function _domainAuth(bytes32 nameHash, address userAddress, uint256 nonce, uint256 deadline)
    internal
    view
    returns (DomainAuth memory)
  {
    return _domainAuthSignedBy(domainOwnerKey, nameHash, userAddress, nonce, deadline);
  }

  function _emptyDomainAuth() internal view returns (DomainAuth memory domainAuth) {
    domainAuth.deadline = block.timestamp + 1 days;
  }

  function _recordFixture() internal view returns (AccountMetadataRegistry.UserRecord memory record) {
    record.l2Address = USER_L2_ADDRESS;
    record.rollupVersion = ROLLUP_VERSION;
    record.publicKey = AccountMetadataRegistry.K1Point(USER_PUBLIC_KEY_X, USER_PUBLIC_KEY_Y);
    record.resolverOperator = resolverOperatorAddr;
  }

  function _recordFixture2() internal view returns (AccountMetadataRegistry.UserRecord memory record) {
    record = _recordFixture();
    record.l2Address = keccak256("bob-l2-address");
  }

  function _claimName(bytes32 nameHash, address owner) internal {
    DomainAuth memory domainAuth = _domainAuth(nameHash, owner, nextDomainNonce++, block.timestamp + 1 days);
    vm.prank(registrationControllerAddr);
    nameRegistry.claimName(nameHash, owner, domainAuth);
  }

  function _setUserRecord(address user, AccountMetadataRegistry.UserRecord memory record) internal {
    vm.prank(registrationControllerAddr);
    metadataRegistry.setUserRecord(user, record);
  }

  function _registerUser(address account, bytes32 nameHash, AccountMetadataRegistry.UserRecord memory record) internal {
    _claimName(nameHash, account);
    _setUserRecord(account, record);
  }

  function _registerDefaultUser() internal {
    _registerUser(userAddr, NAME_HASH, _recordFixture());
  }

  function _resolverOperatorFixture()
    internal
    view
    returns (AccountMetadataRegistry.ResolverOperator memory resolverOperator)
  {
    resolverOperator.publicKey =
      AccountMetadataRegistry.K1Point(RESOLVER_OPERATOR_PUBLIC_KEY_X, RESOLVER_OPERATOR_PUBLIC_KEY_Y);
    resolverOperator.l2Address = RESOLVER_OPERATOR_L2_ADDRESS;
    resolverOperator.url = RESOLVER_OPERATOR_URL;
    resolverOperator.oxidePortal = address(mockPortal);
  }

  function _registerDefaultResolverOperator() internal {
    vm.prank(resolverOperatorAddr);
    metadataRegistry.setResolverOperator(_resolverOperatorFixture());
  }
}
