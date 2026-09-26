// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {INameRegistry, DomainAuth} from "./interfaces/INameRegistry.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Errors} from "@periphery/Errors.sol";

contract NameRegistry is INameRegistry, EIP712, Ownable {
  event NameClaimed(address indexed owner, bytes32 indexed nameHash, uint256 nonce, uint256 deadline, bytes signature);
  event NameChanged(address indexed owner, bytes32 indexed oldNameHash, bytes32 indexed newNameHash);
  event DomainOwnerUpdated(address oldDomainOwner, address newDomainOwner);
  event AccountMetadataRegistryUpdated(address oldRegistry, address newRegistry);
  event ResolverUpdated(address oldResolver, address newResolver);
  event RegistrationControllerUpdated(address indexed oldController, address indexed newController);

  bytes32 private constant NAME_CLAIM_TYPEHASH =
    keccak256("NameClaim(bytes32 nameHash,address userAddress,uint256 nonce,uint256 deadline)");

  mapping(bytes32 => address) public override ownerOf;
  mapping(address => bytes32) public override nameOf;
  mapping(uint256 => bool) public usedDomainOwnerNonces;

  address public override domainOwner;
  address public override accountMetadataRegistry;
  address public override resolver;
  address public override registrationController;

  constructor(address _owner, address _domainOwner) EIP712("Oxide NameRegistry", "1") Ownable(_owner) {
    domainOwner = _domainOwner;
  }

  modifier onlyRegistrationController() {
    require(msg.sender == registrationController, Errors.NameRegistry__CallerNotRegistrationController(msg.sender));
    _;
  }

  function updateDomainOwner(address newDomainOwner) external onlyOwner {
    emit DomainOwnerUpdated(domainOwner, newDomainOwner);
    domainOwner = newDomainOwner;
  }

  function updateAccountMetadataRegistry(address registry) external onlyOwner {
    require(registry != address(0), Errors.NameRegistry__ZeroAccountMetadataRegistry());
    emit AccountMetadataRegistryUpdated(accountMetadataRegistry, registry);
    accountMetadataRegistry = registry;
  }

  function updateResolver(address newResolver) external onlyOwner {
    require(newResolver != address(0), Errors.NameRegistry__ZeroResolver());
    emit ResolverUpdated(resolver, newResolver);
    resolver = newResolver;
  }

  function updateRegistrationController(address controller) external onlyOwner {
    require(controller != address(0), Errors.NameRegistry__ZeroRegistrationController());
    emit RegistrationControllerUpdated(registrationController, controller);
    registrationController = controller;
  }

  function claimName(bytes32 nameHash, address owner, DomainAuth calldata domainAuth)
    external
    override
    onlyRegistrationController
  {
    require(nameHash != bytes32(0), Errors.NameRegistry__EmptyNameHash());
    require(owner != address(0), Errors.NameRegistry__ZeroOwner());
    require(ownerOf[nameHash] == address(0), Errors.NameRegistry__NameAlreadyRegistered());
    require(nameOf[owner] == bytes32(0), Errors.NameRegistry__OwnerAlreadyHasName());

    _consumeDomainAuth(nameHash, owner, domainAuth);

    ownerOf[nameHash] = owner;
    nameOf[owner] = nameHash;
  }

  function changeName(address owner, bytes32 newNameHash, DomainAuth calldata domainAuth)
    external
    override
    onlyRegistrationController
  {
    require(newNameHash != bytes32(0), Errors.NameRegistry__EmptyNameHash());
    require(ownerOf[newNameHash] == address(0), Errors.NameRegistry__NameAlreadyRegistered());
    bytes32 oldNameHash = nameOf[owner];
    require(oldNameHash != bytes32(0), Errors.NameRegistry__NameNotFound());

    _consumeDomainAuth(newNameHash, owner, domainAuth);

    delete ownerOf[oldNameHash];
    ownerOf[newNameHash] = owner;
    nameOf[owner] = newNameHash;
    emit NameChanged(owner, oldNameHash, newNameHash);
  }

  function _consumeDomainAuth(bytes32 nameHash, address owner, DomainAuth calldata domainAuth) internal {
    if (domainOwner != address(0)) {
      if (block.timestamp > domainAuth.deadline) revert Errors.NameRegistry__DomainAuthExpired();
      if (usedDomainOwnerNonces[domainAuth.nonce]) revert Errors.NameRegistry__DomainNonceAlreadyUsed();

      bytes32 structHash =
        keccak256(abi.encode(NAME_CLAIM_TYPEHASH, nameHash, owner, domainAuth.nonce, domainAuth.deadline));
      if (ECDSA.recover(_hashTypedDataV4(structHash), domainAuth.signature) != domainOwner) {
        revert Errors.NameRegistry__InvalidDomainSignature();
      }
      usedDomainOwnerNonces[domainAuth.nonce] = true;
    }
    emit NameClaimed(owner, nameHash, domainAuth.nonce, domainAuth.deadline, domainAuth.signature);
  }
}
