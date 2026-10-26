// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";

import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {RegistrationSIPA} from "@periphery/RegistrationSIPA.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {OxideAccountFactory} from "@periphery/OxideAccountFactory.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {INameRegistry} from "@periphery/interfaces/INameRegistry.sol";
import {RecoveryCommitmentLib} from "@periphery/RecoveryCommitmentLib.sol";
import {AccountSignatures} from "@test/helpers/AccountSignatures.sol";

contract SIPACrossChainRecoveryForkTest is Test {
  bytes internal constant CREATE2_PROXY_CODE =
    hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

  bytes32 internal constant DEPLOYMENT_SALT = keccak256("oxide/prod/nc-v1");
  address internal constant OWNER = address(0x8c5EE3f90cA6D24eD2e2c1817f0caEE89e521601);
  address internal constant MAINNET_FORWARDING_TABLE = address(0xF7AB);
  address internal constant MAINNET_NAME_REGISTRY = address(0x4A3E);
  uint256 internal constant ROLLUP_VERSION = 4_248_422_647;

  bytes32 internal constant SHARED_SECRET_SALT = keccak256("shared-secret");
  bytes32 internal constant INTENT_HASH = keccak256("deposit-intent");
  uint256 internal constant BOOTSTRAP_KEY = 0xB007;
  uint256 internal constant AMOUNT = 1000e18;

  function test_GivenArbitrum_WhenReplayingTheMainnetDeploys_ThenRecoverERC20Succeeds() external {
    _replayAndRecover(42_161, "ARBITRUM_FORK_RPC_URL");
  }

  function test_GivenBase_WhenReplayingTheMainnetDeploys_ThenRecoverERC20Succeeds() external {
    _replayAndRecover(8453, "BASE_FORK_RPC_URL");
  }

  function test_GivenOptimism_WhenReplayingTheMainnetDeploys_ThenRecoverERC20Succeeds() external {
    _replayAndRecover(10, "OPTIMISM_FORK_RPC_URL");
  }

  function _replayAndRecover(uint256 chainId, string memory rpcEnv) internal {
    uint256 initialState = vm.snapshotState();
    vm.chainId(1);
    vm.etch(CREATE2_FACTORY, CREATE2_PROXY_CODE);
    (address mainnetAccount, address mainnetSIPA) = _deploy();
    vm.revertToState(initialState);

    _selectChain(chainId, rpcEnv);
    assertEq(MAINNET_FORWARDING_TABLE.code.length, 0, "the forwarding table must not exist on this chain");
    assertEq(MAINNET_NAME_REGISTRY.code.length, 0, "the name registry must not exist on this chain");
    assertEq(mainnetSIPA.code.length, 0, "the SIPA must not exist on this chain");

    TestERC20 token = new TestERC20("Stuck", "STK", address(this));
    token.mint(mainnetSIPA, AMOUNT);

    (address account, address sipa) = _deploy();
    assertEq(account, mainnetAccount, "the account must have its mainnet address");
    assertEq(sipa, mainnetSIPA, "the SIPA must have its mainnet address");

    address target = makeAddr("target");
    bytes32 nonce = keccak256("nonce");
    bytes32 digest = keccak256(abi.encode(sipa, block.chainid, target, address(token), nonce));
    bytes memory signature = AccountSignatures.k1(BOOTSTRAP_KEY, AccountSignatures.personalSignDigest(account, digest));

    SIPABase(sipa).recoverERC20(SHARED_SECRET_SALT, account, signature, target, address(token), nonce);

    assertEq(token.balanceOf(target), AMOUNT);
    assertEq(token.balanceOf(sipa), 0);
  }

  function _deploy() internal returns (address account, address sipa) {
    SIPAFactory sipaFactory = SIPAFactory(_create2(abi.encodePacked(type(SIPAFactory).creationCode, abi.encode(OWNER))));
    OxideAccountFactory accountFactory = OxideAccountFactory(_create2(type(OxideAccountFactory).creationCode));
    address depositImplementation = _create2(type(DepositSIPA).creationCode);
    _create2(abi.encodePacked(type(RegistrationSIPA).creationCode, abi.encode(INameRegistry(MAINNET_NAME_REGISTRY))));

    account = accountFactory.deploy(vm.addr(BOOTSTRAP_KEY));
    bytes32 recoveryCommitment = RecoveryCommitmentLib.deriveRecoveryCommitment(SHARED_SECRET_SALT, account);
    sipa = sipaFactory.deploySIPA(
      depositImplementation,
      INTENT_HASH,
      recoveryCommitment,
      ROLLUP_VERSION,
      false,
      IForwardingTable(MAINNET_FORWARDING_TABLE)
    );
  }

  function _selectChain(uint256 chainId, string memory rpcEnv) internal {
    string memory rpc = vm.envOr(rpcEnv, string(""));
    if (bytes(rpc).length != 0) {
      vm.createSelectFork(rpc);
      assertEq(block.chainid, chainId, "the fork RPC serves another chain");
      assertGt(CREATE2_FACTORY.code.length, 0, "the chain has no CREATE2 proxy");
      return;
    }
    vm.chainId(chainId);
    if (CREATE2_FACTORY.code.length == 0) {
      vm.etch(CREATE2_FACTORY, CREATE2_PROXY_CODE);
    }
  }

  function _create2(bytes memory initcode) internal returns (address deployed) {
    (bool ok, bytes memory ret) = CREATE2_FACTORY.call(abi.encodePacked(DEPLOYMENT_SALT, initcode));
    assertTrue(ok, "the CREATE2 proxy deploy reverted");
    deployed = address(bytes20(ret));
    assertEq(deployed, vm.computeCreate2Address(DEPLOYMENT_SALT, keccak256(initcode), CREATE2_FACTORY));
  }
}
