// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";

import {AccountMetadataRegistry} from "@periphery/AccountMetadataRegistry.sol";
import {Resolver} from "@periphery/Resolver.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {RegistrationSIPA, REGISTRATION_SWEEP_FEE} from "@periphery/RegistrationSIPA.sol";
import {DepositSIPA, DEPOSIT_FEE} from "@periphery/DepositSIPA.sol";
import {RegistriesTestBase} from "@test/periphery/registries/RegistriesTestBase.sol";
import {Errors} from "@periphery/Errors.sol";
import {MockPortal} from "@test/mocks/MockPortal.sol";

contract ResolutionTest is RegistriesTestBase {
  uint256 internal constant SECONDS_PER_DAY = 86_400;
  uint256 internal constant DAY_BOUNDARY_GRACE = 30 minutes;
  bytes4 internal constant MULTICHAIN_ADDR_SELECTOR = 0xf1cb7e06;
  uint256 internal constant COIN_TYPE_ETH = 60;

  bytes internal constant PROOF = hex"50524f4f46";

  bytes32 internal constant FIXTURE_SHARED_SECRET_SALT =
    bytes32(0x00bbabe215b1c7a1ccf8abc5196bd9bcd584403fcaad9322edda988f9899e7fb);
  bytes32 internal constant FIXTURE_RECIPIENT_COMMITMENT =
    bytes32(0x2d2b85117fb7b9c18c24f74d964a952070dc83713469c0493c8ac1bcbed0e171);
  bytes32 internal fixtureRecoveryCommitment;

  bytes internal name = hex"05616c696365056f7869646503657468";
  bytes internal data;

  function setUp() public override {
    super.setUp();
    _registerDefaultResolverOperator();
    _registerDefaultUser();
    data = abi.encodeWithSelector(ADDR_SELECTOR, NAME_HASH);
    fixtureRecoveryCommitment = RecoveryCommitmentLib.deriveRecoveryCommitment(FIXTURE_SHARED_SECRET_SALT, userAddr);
  }

  function _writeK1(bytes32[] memory inputs, uint256 offset, AccountMetadataRegistry.K1Point memory point)
    internal
    pure
  {
    inputs[offset] = bytes32(point.x & type(uint128).max);
    inputs[offset + 1] = bytes32(point.x >> 128);
    inputs[offset + 2] = bytes32(point.y & type(uint128).max);
    inputs[offset + 3] = bytes32(point.y >> 128);
  }

  function _serialize(Resolver.ResolutionPublicInputs memory resolution) internal pure returns (bytes32[] memory) {
    bytes32[] memory inputs = new bytes32[](12);
    inputs[0] = resolution.recipientCommitment;
    inputs[1] = resolution.sharedSecretSalt;
    _writeK1(inputs, 2, resolution.userPublicKey);
    inputs[6] = resolution.userL2Address;
    _writeK1(inputs, 7, resolution.resolverPublicKey);
    inputs[11] = bytes32(uint256(resolution.day));
    return inputs;
  }

  function _validResolution() internal view returns (Resolver.ResolutionPublicInputs memory resolution) {
    resolution.recipientCommitment = FIXTURE_RECIPIENT_COMMITMENT;
    resolution.sharedSecretSalt = FIXTURE_SHARED_SECRET_SALT;
    resolution.userPublicKey = AccountMetadataRegistry.K1Point(USER_PUBLIC_KEY_X, USER_PUBLIC_KEY_Y);
    resolution.userL2Address = USER_L2_ADDRESS;
    resolution.resolverPublicKey =
      AccountMetadataRegistry.K1Point(RESOLVER_OPERATOR_PUBLIC_KEY_X, RESOLVER_OPERATOR_PUBLIC_KEY_Y);
    // forge-lint: disable-next-line(unsafe-typecast)
    resolution.day = uint32(block.timestamp / SECONDS_PER_DAY);
  }

  function _sipaWith(uint256 rollupVersion) internal view returns (address) {
    return sipaFactory.predictSIPA(
      address(depositSIPAImplementation),
      keccak256(abi.encode(FIXTURE_RECIPIENT_COMMITMENT)),
      fixtureRecoveryCommitment,
      rollupVersion,
      true
    );
  }

  function _response(Resolver.ResolutionPublicInputs memory resolution, address expectedSIPA)
    internal
    pure
    returns (bytes memory)
  {
    return abi.encode(PROOF, _serialize(resolution), expectedSIPA);
  }

  function _response(Resolver.ResolutionPublicInputs memory resolution) internal view returns (bytes memory) {
    return _response(resolution, _sipaWith(ROLLUP_VERSION));
  }

  function test_resolve_revertsWithOffchainLookupPayload() public {
    string[] memory urls = new string[](1);
    urls[0] = RESOLVER_OPERATOR_URL;
    bytes memory callData = abi.encodeWithSelector(Resolver.resolve.selector, name, data);

    vm.expectRevert(
      abi.encodeWithSelector(
        Resolver.OffchainLookup.selector,
        address(resolver),
        urls,
        callData,
        Resolver.resolveWithProof.selector,
        abi.encode(NAME_HASH, false)
      )
    );
    resolver.resolve(name, data);
  }

  function test_resolve_revertsOnUnknownName() public {
    vm.expectRevert(Errors.Resolver__UserNotFound.selector);
    resolver.resolve(name, abi.encodeWithSelector(ADDR_SELECTOR, keccak256("namehash(unknown.oxide.eth)")));
  }

  function test_resolve_revertsOnNameWithoutRecord() public {
    _claimName(NAME_HASH_2, userAddr2);
    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__UserRecordNotFound.selector, userAddr2));
    resolver.resolve(name, abi.encodeWithSelector(ADDR_SELECTOR, NAME_HASH_2));
  }

  function test_resolve_revertsOnUnregisteredResolverOperator() public {
    address ghost = makeAddr("ghostResolverOperator");
    AccountMetadataRegistry.UserRecord memory record2 = _recordFixture2();
    record2.resolverOperator = ghost;
    _registerUser(userAddr2, NAME_HASH_2, record2);

    vm.expectRevert(abi.encodeWithSelector(Errors.AccountMetadataRegistry__ResolverOperatorNotFound.selector, ghost));
    resolver.resolve(name, abi.encodeWithSelector(ADDR_SELECTOR, NAME_HASH_2));
  }

  function test_resolve_revertsOnRollupVersionMismatch() public {
    mockPortal.setRollupVersion(ROLLUP_VERSION + 1);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.Resolver__RollupVersionMismatch.selector, ROLLUP_VERSION + 1, ROLLUP_VERSION)
    );
    resolver.resolve(name, data);
  }

  function testFuzz_resolve_revertsOnShortData(uint256 length) public {
    length = bound(length, 0, 35);
    vm.expectRevert(Errors.Resolver__MalformedResolveData.selector);
    resolver.resolve(name, new bytes(length));
  }

  function testFuzz_resolve_revertsOnLongData(uint256 length) public {
    length = bound(length, 37, 1000);
    vm.expectRevert(Errors.Resolver__MalformedResolveData.selector);
    resolver.resolve(name, new bytes(length));
  }

  function testFuzz_resolve_revertsOnUnsupportedSelector(bytes4 selector) public {
    vm.assume(selector != ADDR_SELECTOR);
    vm.expectRevert(abi.encodeWithSelector(Errors.Resolver__UnsupportedResolverFunction.selector, selector));
    resolver.resolve(name, abi.encodeWithSelector(selector, NAME_HASH));
  }

  function test_resolve_multichainEth_revertsWithOffchainLookupForAddr() public {
    string[] memory urls = new string[](1);
    urls[0] = RESOLVER_OPERATOR_URL;
    bytes memory callData = abi.encodeWithSelector(Resolver.resolve.selector, name, data);

    vm.expectRevert(
      abi.encodeWithSelector(
        Resolver.OffchainLookup.selector,
        address(resolver),
        urls,
        callData,
        Resolver.resolveWithProof.selector,
        abi.encode(NAME_HASH, true)
      )
    );
    resolver.resolve(name, abi.encodeWithSelector(MULTICHAIN_ADDR_SELECTOR, NAME_HASH, COIN_TYPE_ETH));
  }

  function testFuzz_resolve_multichainOtherCoinType_returnsEmpty(uint256 coinType) public view {
    vm.assume(coinType != COIN_TYPE_ETH);
    bytes memory result = resolver.resolve(name, abi.encodeWithSelector(MULTICHAIN_ADDR_SELECTOR, NAME_HASH, coinType));
    assertEq(abi.decode(result, (bytes)).length, 0);
  }

  function test_resolve_multichainEth_revertsOnUnknownName() public {
    vm.expectRevert(Errors.Resolver__UserNotFound.selector);
    resolver.resolve(
      name, abi.encodeWithSelector(MULTICHAIN_ADDR_SELECTOR, keccak256("namehash(unknown.oxide.eth)"), COIN_TYPE_ETH)
    );
  }

  function test_resolveWithProof_multichain_returnsTheSameSIPAAsBytes() public view {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    bytes memory result = resolver.resolveWithProof(_response(resolution), abi.encode(NAME_HASH, true));
    bytes memory addrBytes = abi.decode(result, (bytes));

    assertEq(addrBytes.length, 20);
    assertEq(address(bytes20(addrBytes)), _sipaWith(ROLLUP_VERSION));
    assertEq(
      address(bytes20(addrBytes)),
      abi.decode(resolver.resolveWithProof(_response(resolution), abi.encode(NAME_HASH, false)), (address))
    );
  }

  function test_resolveWithProof_multichain_revertsOnInvalidProof() public {
    bytes memory response = _response(_validResolution());
    verifier.setResult(false);

    vm.expectRevert(Errors.Resolver__InvalidProof.selector);
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, true));
  }

  function test_resolveWithProof_returnsDeterministicSIPA() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();

    vm.expectCall(address(verifier), abi.encodeCall(IVerifier.verify, (PROOF, _serialize(resolution))));
    bytes memory result = resolver.resolveWithProof(_response(resolution), abi.encode(NAME_HASH, false));
    address sipa = abi.decode(result, (address));

    assertEq(sipa, _sipaWith(ROLLUP_VERSION));

    assertEq(
      sipaFactory.deploySIPA(
        address(depositSIPAImplementation),
        keccak256(abi.encode(FIXTURE_RECIPIENT_COMMITMENT)),
        fixtureRecoveryCommitment,
        ROLLUP_VERSION,
        true
      ),
      sipa
    );
  }

  function test_resolveWithProof_revertsOnUnknownName() public {
    bytes memory response = _response(_validResolution());
    vm.expectRevert(Errors.Resolver__UserNotFound.selector);
    resolver.resolveWithProof(response, abi.encode(keccak256("namehash(unknown.oxide.eth)"), false));
  }

  function test_resolveWithProof_revertsOnRollupVersionMismatch() public {
    bytes memory response = _response(_validResolution());
    mockPortal.setRollupVersion(ROLLUP_VERSION + 1);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.Resolver__RollupVersionMismatch.selector, ROLLUP_VERSION + 1, ROLLUP_VERSION)
    );
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_revertsOnInvalidProof() public {
    bytes memory response = _response(_validResolution());
    verifier.setResult(false);

    vm.expectRevert(Errors.Resolver__InvalidProof.selector);
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function testFuzz_resolveWithProof_revertsOnWrongDay(uint32 day) public {
    // forge-lint: disable-next-line(unsafe-typecast)
    uint32 currentDay = uint32(block.timestamp / SECONDS_PER_DAY);
    vm.assume(day != currentDay);

    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    resolution.day = day;
    bytes memory response = _response(resolution);

    vm.expectRevert(abi.encodeWithSelector(Errors.Resolver__StaleProof.selector, day, currentDay));
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_revertsAfterGraceWindow() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    bytes memory response = _response(resolution);
    vm.warp((uint256(resolution.day) + 1) * SECONDS_PER_DAY + DAY_BOUNDARY_GRACE + 1);

    vm.expectRevert(abi.encodeWithSelector(Errors.Resolver__StaleProof.selector, resolution.day, resolution.day + 1));
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_acceptsYesterdayWithinGrace() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    vm.warp((uint256(resolution.day) + 1) * SECONDS_PER_DAY + DAY_BOUNDARY_GRACE - 1);
    resolver.resolveWithProof(_response(resolution), abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_acceptsTomorrowWithinGrace() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    resolution.day += 1;
    vm.warp(uint256(resolution.day) * SECONDS_PER_DAY - DAY_BOUNDARY_GRACE);
    resolver.resolveWithProof(_response(resolution), abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_revertsOnUserKeyXMismatch() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    resolution.userPublicKey.x ^= 1;
    bytes memory response = _response(resolution);

    vm.expectRevert(Errors.Resolver__UserRecordMismatch.selector);
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_revertsOnUserKeyYMismatch() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    resolution.userPublicKey.y ^= 1;
    bytes memory response = _response(resolution);

    vm.expectRevert(Errors.Resolver__UserRecordMismatch.selector);
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_revertsOnL2AddressMismatch() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    resolution.userL2Address = keccak256("someone-elses-l2");
    bytes memory response = _response(resolution);

    vm.expectRevert(Errors.Resolver__UserRecordMismatch.selector);
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_revertsOnResolverOperatorKeyMismatch() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    resolution.resolverPublicKey.y ^= 1;
    bytes memory response = _response(resolution);

    vm.expectRevert(Errors.Resolver__ResolverOperatorRecordMismatch.selector);
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function test_resolveWithProof_revertsOnTamperedKeyLimb() public {
    bytes32[] memory inputs = _serialize(_validResolution());
    inputs[3] = bytes32(uint256(inputs[3]) ^ 1);

    vm.expectRevert(Errors.Resolver__UserRecordMismatch.selector);
    resolver.resolveWithProof(abi.encode(PROOF, inputs, address(0)), abi.encode(NAME_HASH, false));
  }

  function test_recoveryCommitmentBindsTheNameOwner() public {
    AccountMetadataRegistry.UserRecord memory record2 = _recordFixture2();
    _registerUser(userAddr2, NAME_HASH_2, record2);

    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    resolution.userL2Address = record2.l2Address;

    bytes32 ownerBound = RecoveryCommitmentLib.deriveRecoveryCommitment(FIXTURE_SHARED_SECRET_SALT, userAddr2);
    assertNotEq(ownerBound, fixtureRecoveryCommitment);
    address expected = sipaFactory.predictSIPA(
      address(depositSIPAImplementation),
      keccak256(abi.encode(resolution.recipientCommitment)),
      ownerBound,
      ROLLUP_VERSION,
      true
    );
    bytes memory result =
      resolver.resolveWithProof(abi.encode(PROOF, _serialize(resolution), expected), abi.encode(NAME_HASH_2, false));
    assertEq(abi.decode(result, (address)), expected);
  }

  function test_resolveWithProof_derivesAgainstTheOperatorsPoolImplementation() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    bytes memory staleResponse = _response(resolution);
    address before = abi.decode(resolver.resolveWithProof(staleResponse, abi.encode(NAME_HASH, false)), (address));
    address funded = _sipaDeployed(ROLLUP_VERSION);
    assertEq(funded, before, "the first resolution's address is the one a payer funds");

    MockPortal nextPortal = new MockPortal(mockUnderlying, ROLLUP_VERSION);
    DepositSIPA nextDeposit = new DepositSIPA(IOxidePortal(address(nextPortal)), DEPOSIT_FEE);
    vm.prank(registryOwner);
    sipaFactory.bless(address(nextDeposit));

    AccountMetadataRegistry.ResolverOperator memory updated = _resolverOperatorFixture();
    updated.oxidePortal = address(nextPortal);
    vm.prank(resolverOperatorAddr);
    metadataRegistry.setResolverOperator(updated);

    address next = sipaFactory.predictSIPA(
      address(nextDeposit),
      keccak256(abi.encode(FIXTURE_RECIPIENT_COMMITMENT)),
      fixtureRecoveryCommitment,
      ROLLUP_VERSION,
      true
    );
    assertNotEq(next, before);
    bytes memory freshResponse = _response(resolution, next);
    vm.expectRevert(abi.encodeWithSelector(Errors.Resolver__SIPAMismatch.selector, before, next));
    resolver.resolveWithProof(staleResponse, abi.encode(NAME_HASH, false));
    assertEq(abi.decode(resolver.resolveWithProof(freshResponse, abi.encode(NAME_HASH, false)), (address)), next);

    assertTrue(sipaFactory.isBlessed(funded), "the funded SIPA's implementation stays blessed");
  }

  function test_resolveWithProof_revertsWhenRollupVersionChangedAfterPrediction() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    bytes memory response = _response(resolution);

    MockPortal nextPortal = new MockPortal(mockUnderlying, ROLLUP_VERSION + 1);
    DepositSIPA nextDeposit = new DepositSIPA(IOxidePortal(address(nextPortal)), DEPOSIT_FEE);
    RegistrationSIPA nextRegistration = new RegistrationSIPA(
      IOxidePortal(address(nextPortal)), INameRegistry(address(nameRegistry)), REGISTRATION_SWEEP_FEE
    );
    vm.startPrank(registryOwner);
    sipaFactory.bless(address(nextDeposit));
    sipaFactory.bless(address(nextRegistration));
    vm.stopPrank();
    AccountMetadataRegistry.ResolverOperator memory rolled = _resolverOperatorFixture();
    rolled.oxidePortal = address(nextPortal);
    vm.prank(resolverOperatorAddr);
    metadataRegistry.setResolverOperator(rolled);
    vm.prank(userAddr);
    metadataRegistry.updateL2Address(userAddr, USER_L2_ADDRESS, ROLLUP_VERSION + 1);

    address predicted = _sipaWith(ROLLUP_VERSION);
    address live = SIPAFactory(sipaFactory)
      .predictSIPA(
        address(nextDeposit),
        keccak256(abi.encode(FIXTURE_RECIPIENT_COMMITMENT)),
        fixtureRecoveryCommitment,
        ROLLUP_VERSION + 1,
        true
      );
    vm.expectRevert(abi.encodeWithSelector(Errors.Resolver__SIPAMismatch.selector, predicted, live));
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));

    assertTrue(sipaFactory.isBlessed(_sipaDeployed(ROLLUP_VERSION)), "an older implementation must stay blessed");
  }

  function test_resolveWithProof_revertsWhenNoImplementationServesThePool() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    bytes memory response = _response(resolution);

    address unpointed = address(new MockPortal(mockUnderlying, ROLLUP_VERSION));
    AccountMetadataRegistry.ResolverOperator memory updated = _resolverOperatorFixture();
    updated.oxidePortal = unpointed;
    vm.prank(resolverOperatorAddr);
    metadataRegistry.setResolverOperator(updated);

    vm.expectRevert(abi.encodeWithSelector(Errors.Resolver__NoImplementationForPortal.selector, unpointed));
    resolver.resolveWithProof(response, abi.encode(NAME_HASH, false));
  }

  function _sipaDeployed(uint256 rollupVersion) internal returns (address) {
    return sipaFactory.deploySIPA(
      address(depositSIPAImplementation),
      keccak256(abi.encode(FIXTURE_RECIPIENT_COMMITMENT)),
      fixtureRecoveryCommitment,
      rollupVersion,
      true
    );
  }

  function test_resolveWithProof_revertsOnTamperedExpectedSIPA() public {
    Resolver.ResolutionPublicInputs memory resolution = _validResolution();
    address live = _sipaWith(ROLLUP_VERSION);
    address tampered = makeAddr("tampered");

    vm.expectRevert(abi.encodeWithSelector(Errors.Resolver__SIPAMismatch.selector, tampered, live));
    resolver.resolveWithProof(_response(resolution, tampered), abi.encode(NAME_HASH, false));
  }
}
