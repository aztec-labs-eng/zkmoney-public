// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Errors} from "@periphery/Errors.sol";

contract OxideAccount is Account, ERC7821, ERC7739 {
  struct R1Key {
    bytes32 qx;
    bytes32 qy;
  }

  struct AuthKeyEntry {
    R1Key key;
    bytes metadata;
  }

  event AuthKeyAdded(uint256 indexed index, R1Key key, bytes metadata);
  event AuthKeyRemoved(uint256 indexed index, R1Key key);
  event DataChanged(bytes32 indexed key, bytes value);

  address private immutable IMPLEMENTATION = address(this);

  AuthKeyEntry[] internal authKeys;

  mapping(bytes32 key => bytes value) internal kvStore;

  constructor() EIP712("OxideAccount", "1") {}

  function entryPoint() public pure override returns (IEntryPoint) {
    return ERC4337Utils.ENTRYPOINT_V08;
  }

  function bootstrapOwner() public view returns (address) {
    if (address(this) == IMPLEMENTATION) revert Errors.OxideAccount__NotClone();
    return abi.decode(Clones.fetchCloneArgs(address(this)), (address));
  }

  function addAuthKey(R1Key calldata key, bytes calldata metadata) external onlyEntryPointOrSelf {
    if (!P256.isValidPublicKey(key.qx, key.qy)) revert Errors.OxideAccount__InvalidR1Key();

    uint256 index = authKeys.length;
    authKeys.push(AuthKeyEntry({key: key, metadata: metadata}));
    emit AuthKeyAdded(index, key, metadata);
  }

  function removeAuthKey(uint256 index, R1Key calldata expectedKey) external onlyEntryPointOrSelf {
    uint256 len = authKeys.length;
    if (index >= len) revert Errors.OxideAccount__AuthKeyIndexOutOfBounds();
    if (len == 1) revert Errors.OxideAccount__CannotRemoveLastKey();

    R1Key memory removed = authKeys[index].key;
    if (removed.qx != expectedKey.qx || removed.qy != expectedKey.qy) revert Errors.OxideAccount__AuthKeyMismatch();
    uint256 lastIndex = len - 1;
    if (index != lastIndex) {
      authKeys[index] = authKeys[lastIndex];
    }
    authKeys.pop();
    emit AuthKeyRemoved(index, removed);
  }

  function getAuthKeys() external view returns (AuthKeyEntry[] memory) {
    return authKeys;
  }

  function authKeyCount() external view returns (uint256) {
    return authKeys.length;
  }

  function getAuthKey(uint256 index) external view returns (AuthKeyEntry memory) {
    if (index >= authKeys.length) revert Errors.OxideAccount__AuthKeyIndexOutOfBounds();
    return authKeys[index];
  }

  function setData(bytes32 key, bytes calldata value) external onlyEntryPointOrSelf {
    kvStore[key] = value;
    emit DataChanged(key, value);
  }

  function getData(bytes32 key) external view returns (bytes memory) {
    return kvStore[key];
  }

  function _rawSignatureValidation(bytes32 hash, bytes calldata signature) internal view override returns (bool) {
    if (authKeys.length == 0) {
      (address recovered,,) = ECDSA.tryRecover(hash, signature);
      return recovered != address(0) && recovered == bootstrapOwner();
    }

    if (signature.length < 32) return false;
    uint256 keyIndex = uint256(bytes32(signature[0:32]));
    if (keyIndex >= authKeys.length) return false;

    (bool decoded, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(signature[32:]);
    if (!decoded) return false;

    R1Key storage key = authKeys[keyIndex].key;
    return WebAuthn.verify(abi.encodePacked(hash), auth, key.qx, key.qy, true);
  }

  function _erc7821AuthorizedExecutor(address caller, bytes32 mode, bytes calldata executionData)
    internal
    view
    override
    returns (bool)
  {
    return caller == address(entryPoint()) || super._erc7821AuthorizedExecutor(caller, mode, executionData);
  }
}
