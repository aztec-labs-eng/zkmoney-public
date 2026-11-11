// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SIPABase} from "./SIPABase.sol";
import {ThreePoolLib} from "./ThreePoolLib.sol";
import {Errors} from "./Errors.sol";
import {OxideAccount} from "./OxideAccount.sol";
import {AccountMetadataRegistry} from "./AccountMetadataRegistry.sol";
import {INamePortal} from "./interfaces/INamePortal.sol";
import {INameRegistry} from "./interfaces/INameRegistry.sol";
import {IOxideAccountFactory} from "./interfaces/IOxideAccountFactory.sol";
import {Intent, Intents} from "./Intent.sol";
import {ERC4337Utils} from "@openzeppelin/contracts/account/utils/draft-ERC4337Utils.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {
  ERC7579Utils,
  Mode,
  ModeSelector,
  ModePayload
} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";

struct AddPasskeyIntent {
  uint256 rollupVersion;
  bytes32 recipientCommitment;
  address owner;
  uint64 nonce;
  bytes32 accountGasLimits;
  AccountMetadataRegistry.UserRecord record;
  bytes32 namePortalRecipient;
  OxideAccount.R1Key key;
  bytes metadata;
}

contract AddPasskeySIPA is SIPABase {
  IEntryPoint public constant ENTRY_POINT = ERC4337Utils.ENTRYPOINT_V08;

  IOxideAccountFactory public immutable ACCOUNT_FACTORY;
  INameRegistry public immutable NAME_REGISTRY;
  INamePortal public immutable NAME_PORTAL;

  constructor(IOxideAccountFactory accountFactory, INameRegistry nameRegistry, INamePortal namePortal) {
    require(address(accountFactory) != address(0), Errors.AddPasskeySIPA__ZeroAccountFactory());
    require(address(nameRegistry) != address(0), Errors.AddPasskeySIPA__ZeroNameRegistry());
    require(address(namePortal) != address(0), Errors.AddPasskeySIPA__ZeroNamePortal());
    ACCOUNT_FACTORY = accountFactory;
    NAME_REGISTRY = nameRegistry;
    NAME_PORTAL = namePortal;
  }

  function INTENT() public pure override returns (Intent) {
    return Intents.ADD_PASSKEY;
  }

  function _buildCallData(AccountMetadataRegistry registry, AddPasskeyIntent memory intent)
    internal
    view
    returns (bytes memory)
  {
    Execution[] memory batch = new Execution[](3);
    batch[0] = Execution(intent.owner, 0, abi.encodeCall(OxideAccount.addAuthKey, (intent.key, intent.metadata)));
    batch[1] = Execution(
      address(registry), 0, abi.encodeCall(AccountMetadataRegistry.setUserRecord, (intent.owner, intent.record))
    );
    batch[2] = Execution(
      address(NAME_PORTAL),
      0,
      abi.encodeCall(INamePortal.notify, (intent.owner, intent.namePortalRecipient, intent.rollupVersion))
    );
    // solhint-disable-next-line oxide/no-comments
    // ERC-7821 accepts only a batch with the default exec type and a zero selector (no opData). It ignores the payload.
    Mode mode = ERC7579Utils.encodeMode(
      ERC7579Utils.CALLTYPE_BATCH, ERC7579Utils.EXECTYPE_DEFAULT, ModeSelector.wrap(0x00000000), ModePayload.wrap(0x00)
    );
    return abi.encodeCall(ERC7821.execute, (Mode.unwrap(mode), abi.encode(batch)));
  }

  function _checkIntent(AddPasskeyIntent memory intent, uint256 rollupVersion) internal view {
    require(intent.rollupVersion == rollupVersion, Errors.SIPA__RollupVersionMismatch());
    require(
      intent.record.rollupVersion == rollupVersion,
      Errors.AddPasskeySIPA__RecordRollupVersionMismatch(intent.record.rollupVersion, rollupVersion)
    );
    address bootstrap = OxideAccount(payable(intent.owner)).bootstrapOwner();
    require(
      ACCOUNT_FACTORY.predictAccountAddress(bootstrap) == intent.owner,
      Errors.AddPasskeySIPA__NotFactoryAccount(intent.owner)
    );
  }

  function _isUserOpPending(AddPasskeyIntent memory intent) internal view returns (bool) {
    uint256 nonce = ENTRY_POINT.getNonce(intent.owner, 0);
    require(nonce >= intent.nonce, Errors.AddPasskeySIPA__NonceNotReached(nonce, intent.nonce));
    return nonce == intent.nonce;
  }

  function _isRecordSet(AccountMetadataRegistry registry, AddPasskeyIntent memory intent) internal view returns (bool) {
    AccountMetadataRegistry.UserRecord memory record = registry.getUserRecord(intent.owner);
    return keccak256(abi.encode(record)) == keccak256(abi.encode(intent.record));
  }

  function _execute(address token, bytes calldata intentData, bytes calldata proofs)
    internal
    override
    returns (Routing memory)
  {
    Args memory args = _args();
    require(!args.resweepable, Errors.AddPasskeySIPA__Resweepable());
    address settledToken = ThreePoolLib.swapToDai(token);
    AddPasskeyIntent memory intent = abi.decode(intentData, (AddPasskeyIntent));
    _checkIntent(intent, args.rollupVersion);

    AccountMetadataRegistry registry = AccountMetadataRegistry(NAME_REGISTRY.accountMetadataRegistry());
    if (_isUserOpPending(intent)) {
      _handleOp(registry, intent, abi.decode(proofs, (bytes)));
    }
    require(_isRecordSet(registry, intent), Errors.AddPasskeySIPA__RecordNotSet());

    return Routing(settledToken, address(0), 0, intent.recipientCommitment);
  }

  function _handleOp(AccountMetadataRegistry registry, AddPasskeyIntent memory intent, bytes memory signature)
    internal
  {
    PackedUserOperation[] memory ops = new PackedUserOperation[](1);
    ops[0].sender = intent.owner;
    ops[0].nonce = intent.nonce;
    ops[0].callData = _buildCallData(registry, intent);
    ops[0].accountGasLimits = intent.accountGasLimits;
    ops[0].signature = signature;
    ENTRY_POINT.handleOps(ops, payable(intent.owner));
  }
}
