// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Test} from "forge-std/Test.sol";

import {OxideAccount} from "@periphery/OxideAccount.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";

abstract contract EscrowRecoveryTestBase is Test {
  bytes32 internal constant RECOVERY_SALT = keccak256("recovery-salt");
  uint256 internal constant PASSKEY_INDEX = 0;

  OxideAccountFactory internal accountFactory;
  OxideAccount internal account;
  uint256 internal passkey;

  function setUp() public virtual {
    accountFactory = new OxideAccountFactory();
    account = OxideAccount(payable(accountFactory.deploy(makeAddr("bootstrap"))));
    passkey = _p256Key("passkey");
    (uint256 qx, uint256 qy) = vm.publicKeyP256(passkey);
    vm.prank(address(account.entryPoint()));
    account.addAuthKey(OxideAccount.R1Key({qx: bytes32(qx), qy: bytes32(qy)}), "passkey:recovery");
  }

  function _signRecoverERC20(address _escrow, address _target, address _token, bytes32 _nonce, uint256 _deadline)
    internal
    view
    returns (bytes memory)
  {
    return _sign(passkey, keccak256(abi.encode(_escrow, block.chainid, _target, _token, _nonce, _deadline)));
  }

  function _signRecoverETH(address _escrow, address _target, bytes32 _nonce, uint256 _deadline)
    internal
    view
    returns (bytes memory)
  {
    return _sign(passkey, keccak256(abi.encode(_escrow, block.chainid, _target, _nonce, _deadline)));
  }

  function _sign(uint256 _passkey, bytes32 _digest) internal view returns (bytes memory) {
    return
      AccountSignatures.r1(PASSKEY_INDEX, _passkey, AccountSignatures.personalSignDigest(address(account), _digest));
  }

  function _p256Key(string memory _name) internal pure returns (uint256) {
    return uint256(keccak256(bytes(_name))) % AccountSignatures.P256_N;
  }
}

contract NonPayableRecipient {}
