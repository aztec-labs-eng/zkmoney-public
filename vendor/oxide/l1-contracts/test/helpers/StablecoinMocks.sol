// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Vm} from "forge-std/Vm.sol";
import {DAI, USDC, USDT, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";

library StablecoinMocks {
  Vm internal constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  function install() internal returns (MockCurve3Pool threePool) {
    VM.etch(address(DAI), address(new MintableToken()).code);
    VM.etch(address(USDC), address(new MintableToken()).code);
    VM.etch(address(USDT), address(new MintableToken()).code);
    VM.etch(address(THREE_POOL), address(new MockCurve3Pool()).code);
    threePool = MockCurve3Pool(address(THREE_POOL));
    threePool.setCoins(address(DAI), address(USDC), address(USDT));
  }
}
