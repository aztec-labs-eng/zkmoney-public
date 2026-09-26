// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {INameRegistry} from "./interfaces/INameRegistry.sol";
import {Errors} from "@periphery/Errors.sol";

contract AccountMetadataRegistry {
  event UserRecordUpdated(address indexed user, UserRecord record);
  event ResolverOperatorUpdated(address indexed resolverOperator, ResolverOperator entry);

  uint256 private constant SECP256K1_N = (uint256(OxideConstants.K1_N_HI) << 128) | uint256(OxideConstants.K1_N_LO);
  uint256 private constant SECP256K1_P = (uint256(OxideConstants.K1_P_HI) << 128) | uint256(OxideConstants.K1_P_LO);

  struct K1Point {
    uint256 x;
    uint256 y;
  }

  struct UserRecord {
    bytes32 l2Address;
    uint256 rollupVersion;
    K1Point publicKey;
    address resolverOperator;
  }

  struct ResolverOperator {
    K1Point publicKey;
    bytes32 l2Address;
    string url;
    address oxidePortal;
  }

  INameRegistry public immutable NAME_REGISTRY;

  mapping(address => UserRecord) public userRecords;
  mapping(address => ResolverOperator) public resolverOperators;

  constructor(INameRegistry nameRegistry) {
    require(address(nameRegistry) != address(0), Errors.AccountMetadataRegistry__ZeroNameRegistry());
    NAME_REGISTRY = nameRegistry;
  }

  function setUserRecord(address user, UserRecord calldata record) external {
    _checkMsgSenderAuthorizedToUpdate(user);
    _isValidPublicKey(record.publicKey);
    userRecords[user] = record;
    emit UserRecordUpdated(user, record);
  }

  function updateL2Address(address user, bytes32 l2Address, uint256 rollupVersion) external {
    _checkMsgSenderAuthorizedToUpdate(user);
    UserRecord storage record = _getUserRecordStorage(user);
    record.l2Address = l2Address;
    record.rollupVersion = rollupVersion;
    emit UserRecordUpdated(user, record);
  }

  function updatePublicKey(address user, K1Point calldata publicKey) external {
    _checkMsgSenderAuthorizedToUpdate(user);
    _isValidPublicKey(publicKey);
    UserRecord storage record = _getUserRecordStorage(user);
    record.publicKey = publicKey;
    emit UserRecordUpdated(user, record);
  }

  function updateUserResolverOperator(address user, address resolverOperator) external {
    _checkMsgSenderAuthorizedToUpdate(user);
    UserRecord storage record = _getUserRecordStorage(user);
    record.resolverOperator = resolverOperator;
    emit UserRecordUpdated(user, record);
  }

  function getUserRecord(address user) external view returns (UserRecord memory) {
    return _getUserRecordStorage(user);
  }

  function hasUserRecord(address user) external view returns (bool) {
    return userRecords[user].publicKey.x != 0;
  }

  function _checkMsgSenderAuthorizedToUpdate(address user) internal view {
    require(
      msg.sender == user || msg.sender == NAME_REGISTRY.registrationController(),
      Errors.AccountMetadataRegistry__Unauthorized(msg.sender, user)
    );
  }

  function _getUserRecordStorage(address user) internal view returns (UserRecord storage record) {
    record = userRecords[user];
    require(record.publicKey.x != 0, Errors.AccountMetadataRegistry__UserRecordNotFound(user));
  }

  function setResolverOperator(ResolverOperator calldata entry) external {
    if (bytes(entry.url).length == 0) revert Errors.AccountMetadataRegistry__EmptyResolverOperatorURL();
    if (entry.oxidePortal == address(0)) revert Errors.AccountMetadataRegistry__EmptyOxidePortal();
    if (entry.l2Address == bytes32(0)) revert Errors.AccountMetadataRegistry__EmptyResolverOperatorL2Address();
    _isValidPublicKey(entry.publicKey);

    resolverOperators[msg.sender] = entry;
    emit ResolverOperatorUpdated(msg.sender, entry);
  }

  function getResolverOperator(address resolverOperator) external view returns (ResolverOperator memory) {
    ResolverOperator memory entry = resolverOperators[resolverOperator];
    if (bytes(entry.url).length == 0) {
      revert Errors.AccountMetadataRegistry__ResolverOperatorNotFound(resolverOperator);
    }
    return entry;
  }

  function _isValidPublicKey(K1Point memory pk) internal pure {
    if (pk.x == 0 || pk.x >= SECP256K1_N || pk.y >= SECP256K1_P) {
      revert Errors.AccountMetadataRegistry__InvalidPublicKey();
    }
    uint256 xSquared = mulmod(pk.x, pk.x, SECP256K1_P);
    uint256 xCubed = mulmod(xSquared, pk.x, SECP256K1_P);
    uint256 xCubedPlus7 = addmod(xCubed, 7, SECP256K1_P);
    uint256 ySquared = mulmod(pk.y, pk.y, SECP256K1_P);
    if (ySquared != xCubedPlus7) revert Errors.AccountMetadataRegistry__InvalidPublicKey();
  }
}
