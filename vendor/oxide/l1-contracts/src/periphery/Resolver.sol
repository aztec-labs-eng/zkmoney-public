// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IExtendedResolver} from "./interfaces/IExtendedResolver.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {SupportsInterface} from "./SupportsInterface.sol";
import {AccountMetadataRegistry} from "./AccountMetadataRegistry.sol";
import {INameRegistry} from "./interfaces/INameRegistry.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {SIPAFactory} from "./SIPAFactory.sol";
import {SIPABase} from "./SIPABase.sol";
import {RecoveryCommitmentLib} from "./RecoveryCommitmentLib.sol";
import {Errors} from "@periphery/Errors.sol";

contract Resolver is IExtendedResolver, SupportsInterface {
  error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);

  bytes4 private constant ADDR_SELECTOR = 0x3b3b57de;
  uint256 private constant SECONDS_PER_DAY = 86_400;
  uint256 private constant DAY_BOUNDARY_GRACE = 30 minutes;
  uint256 private constant PUBLIC_INPUTS_LENGTH = 12;

  struct ResolutionPublicInputs {
    bytes32 recipientCommitment;
    bytes32 sharedSecretSalt;
    AccountMetadataRegistry.K1Point userPublicKey;
    bytes32 userL2Address;
    AccountMetadataRegistry.K1Point resolverPublicKey;
    uint32 day;
  }

  INameRegistry public immutable NAME_REGISTRY;
  SIPAFactory public immutable SIPA_FACTORY;
  IVerifier public immutable VERIFIER;

  constructor(INameRegistry _nameRegistry, SIPAFactory _sipaFactory, IVerifier _verifier) {
    NAME_REGISTRY = _nameRegistry;
    SIPA_FACTORY = _sipaFactory;
    VERIFIER = _verifier;
  }

  function supportsInterface(bytes4 interfaceID) public pure override returns (bool) {
    return interfaceID == type(IExtendedResolver).interfaceId || super.supportsInterface(interfaceID);
  }

  function _loadResolutionRecords(bytes32 nameHash)
    internal
    view
    returns (
      address userAddress,
      AccountMetadataRegistry.UserRecord memory user,
      AccountMetadataRegistry.ResolverOperator memory resolverOperator
    )
  {
    userAddress = NAME_REGISTRY.ownerOf(nameHash);
    if (userAddress == address(0)) revert Errors.Resolver__UserNotFound();

    AccountMetadataRegistry registry = AccountMetadataRegistry(NAME_REGISTRY.accountMetadataRegistry());
    user = registry.getUserRecord(userAddress);
    resolverOperator = registry.getResolverOperator(user.resolverOperator);

    uint256 resolverOperatorVersion = IOxidePortal(resolverOperator.oxidePortal).ROLLUP_VERSION();
    if (resolverOperatorVersion != user.rollupVersion) {
      revert Errors.Resolver__RollupVersionMismatch(resolverOperatorVersion, user.rollupVersion);
    }
  }

  function resolve(bytes calldata name, bytes calldata data) external view override returns (bytes memory) {
    bytes32 nameHash = _extractNameHash(data);
    (,, AccountMetadataRegistry.ResolverOperator memory resolverOperator) = _loadResolutionRecords(nameHash);

    string[] memory urls = new string[](1);
    urls[0] = resolverOperator.url;

    bytes memory callData = abi.encodeWithSelector(Resolver.resolve.selector, name, data);
    revert OffchainLookup(address(this), urls, callData, this.resolveWithProof.selector, abi.encode(nameHash));
  }

  function _extractNameHash(bytes calldata data) internal pure returns (bytes32) {
    if (data.length != 36) revert Errors.Resolver__MalformedResolveData();
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes4 selector = bytes4(data);
    if (selector != ADDR_SELECTOR) revert Errors.Resolver__UnsupportedResolverFunction(selector);
    return bytes32(data[4:36]);
  }

  function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
    bytes32 nameHash = abi.decode(extraData, (bytes32));
    (
      address userAddress,
      AccountMetadataRegistry.UserRecord memory user,
      AccountMetadataRegistry.ResolverOperator memory resolverOperator
    ) = _loadResolutionRecords(nameHash);

    (bytes memory proof, bytes32[] memory publicInputs, address expectedSIPA) =
      abi.decode(response, (bytes, bytes32[], address));
    if (!VERIFIER.verify(proof, publicInputs)) revert Errors.Resolver__InvalidProof();

    ResolutionPublicInputs memory resolution = _deserializePublicInputs(publicInputs);

    uint256 earliestDay = (block.timestamp - DAY_BOUNDARY_GRACE) / SECONDS_PER_DAY;
    uint256 latestDay = (block.timestamp + DAY_BOUNDARY_GRACE) / SECONDS_PER_DAY;
    if (resolution.day < earliestDay || resolution.day > latestDay) {
      // forge-lint: disable-next-line(unsafe-typecast)
      revert Errors.Resolver__StaleProof(resolution.day, uint32(block.timestamp / SECONDS_PER_DAY));
    }

    if (!_samePoint(resolution.userPublicKey, user.publicKey) || resolution.userL2Address != user.l2Address) {
      revert Errors.Resolver__UserRecordMismatch();
    }
    if (!_samePoint(resolution.resolverPublicKey, resolverOperator.publicKey)) {
      revert Errors.Resolver__ResolverOperatorRecordMismatch();
    }

    address sipa = _predictSIPA(resolution, userAddress, user.rollupVersion, resolverOperator.oxidePortal);

    if (sipa != expectedSIPA) revert Errors.Resolver__SIPAMismatch(expectedSIPA, sipa);

    return abi.encode(sipa);
  }

  function _predictSIPA(
    ResolutionPublicInputs memory resolution,
    address userAddress,
    uint256 rollupVersion,
    address portal
  ) internal view returns (address) {
    address implementation = SIPA_FACTORY.implementationFor(portal, SIPABase.Intent.Deposit);
    if (implementation == address(0)) revert Errors.Resolver__NoImplementationForPortal(portal);

    return SIPA_FACTORY.predictSIPA(
      implementation,
      keccak256(abi.encode(resolution.recipientCommitment)),
      RecoveryCommitmentLib.deriveRecoveryCommitment(resolution.sharedSecretSalt, userAddress),
      rollupVersion,
      true
    );
  }

  function _deserializePublicInputs(bytes32[] memory publicInputs)
    internal
    pure
    returns (ResolutionPublicInputs memory resolution)
  {
    assert(publicInputs.length == PUBLIC_INPUTS_LENGTH);

    resolution.recipientCommitment = publicInputs[0];
    resolution.sharedSecretSalt = publicInputs[1];
    resolution.userPublicKey = _deserializeK1Point(publicInputs, 2);
    resolution.userL2Address = publicInputs[6];
    resolution.resolverPublicKey = _deserializeK1Point(publicInputs, 7);
    resolution.day = uint32(uint256(publicInputs[11]));
  }

  function _samePoint(AccountMetadataRegistry.K1Point memory a, AccountMetadataRegistry.K1Point memory b)
    internal
    pure
    returns (bool)
  {
    return a.x == b.x && a.y == b.y;
  }

  function _deserializeK1Point(bytes32[] memory publicInputs, uint256 offset)
    internal
    pure
    returns (AccountMetadataRegistry.K1Point memory point)
  {
    point.x = (uint256(publicInputs[offset + 1]) << 128) | uint256(publicInputs[offset]);
    point.y = (uint256(publicInputs[offset + 3]) << 128) | uint256(publicInputs[offset + 2]);
  }
}
