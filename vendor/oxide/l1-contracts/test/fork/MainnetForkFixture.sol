// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";

abstract contract MainnetForkFixture is OxidePortalBase {
  uint256 internal constant FORK_BLOCK = 25_600_000;

  function _selectMainnetFork() internal {
    string memory rpc = vm.envOr("MAINNET_FORK_RPC_URL", string(""));
    if (bytes(rpc).length != 0) {
      vm.createSelectFork(rpc, FORK_BLOCK);
      return;
    }

    string memory stem = string.concat("test/fixtures/fork/mainnet_", vm.toString(FORK_BLOCK));
    vm.loadAllocs(string.concat(stem, "_allocs.json"));

    string memory env = vm.readFile(string.concat(stem, "_env.json"));
    vm.chainId(1);
    vm.roll(vm.parseJsonUint(env, ".number"));
    vm.warp(vm.parseJsonUint(env, ".timestamp"));
    vm.fee(vm.parseJsonUint(env, ".basefee"));
    vm.coinbase(vm.parseJsonAddress(env, ".coinbase"));
    vm.prevrandao(vm.parseJsonBytes32(env, ".prevrandao"));
  }
}
