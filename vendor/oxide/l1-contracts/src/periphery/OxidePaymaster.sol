// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract OxidePaymaster is BasePaymaster {
  using MessageHashUtils for bytes32;

  address public immutable signer;

  mapping(address bundler => bool allowed) public $allowedBundler;

  event BundlerAllowed(address indexed bundler, bool allowed);

  constructor(IEntryPoint entryPoint, address _signer, address _firstAllowedBundler) BasePaymaster(entryPoint) {
    signer = _signer;
    $allowedBundler[_firstAllowedBundler] = true;
  }

  function setBundlerAllowed(address bundler, bool allowed) external onlyOwner {
    $allowedBundler[bundler] = allowed;
    emit BundlerAllowed(bundler, allowed);
  }

  function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
    public
    view
    returns (bytes32)
  {
    return keccak256(
      abi.encode(
        userOp.sender,
        userOp.nonce,
        keccak256(userOp.initCode),
        keccak256(userOp.callData),
        userOp.accountGasLimits,
        userOp.preVerificationGas,
        userOp.gasFees,
        keccak256(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET]),
        block.chainid,
        address(this),
        validUntil,
        validAfter
      )
    );
  }

  function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
    internal
    view
    override
    returns (bytes memory context, uint256 validationData)
  {
    (uint48 validUntil, uint48 validAfter, bytes calldata signature) = _parsePaymasterData(userOp.paymasterAndData);
    bool failed =
      ECDSA.recover(getHash(userOp, validUntil, validAfter).toEthSignedMessageHash(), signature) != signer
      || !$allowedBundler[tx.origin];
    return ("", _packValidationData(failed, validUntil, validAfter));
  }

  function _parsePaymasterData(bytes calldata paymasterAndData)
    internal
    pure
    returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
  {
    bytes calldata data = paymasterAndData[PAYMASTER_DATA_OFFSET:];
    validUntil = uint48(bytes6(data[0:6]));
    validAfter = uint48(bytes6(data[6:12]));
    signature = data[12:];
  }
}
