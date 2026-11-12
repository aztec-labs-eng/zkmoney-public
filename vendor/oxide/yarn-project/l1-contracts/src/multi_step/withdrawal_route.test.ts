import { describe, expect, test } from '@jest/globals';
import { type Address, erc20Abi } from 'viem';

import { adapters } from './adapters.js';
import type { LaneBuilder } from './lane.js';
import { ETH, UNBOUNDED } from './steps/step.js';
import { ADAPTERS, DAI, LITE_PSM, THREE_POOL, USDC, USDT, WETH, noTokenCall, stepCall } from './test_fixtures.js';
import { withdrawalRoute } from './withdrawal_route.js';

const RECIPIENT: Address = '0x1111111111111111111111111111111111111111';
const FRIEND: Address = '0x2222222222222222222222222222222222222222';
const MIN_OUT = 2495_000000n;
const { makerPsm, curve, uniswapV3, weth, skyConverter, check } = adapters({ chainId: 1n, configs: ADAPTERS });
const BALANCE = { address: DAI, abi: erc20Abi, functionName: 'balanceOf', args: [RECIPIENT] } as const;
const dai = () => withdrawalRoute({ token: DAI });
const usdcLane = (lane: LaneBuilder) => lane.step(makerPsm.buyGem({ psm: LITE_PSM, minOut: MIN_OUT })).to(RECIPIENT);

describe('withdrawalRoute', () => {
  test('a remainder lane with no steps pays the recipient from the executor', () => {
    expect(dai().remainder(lane => lane.to(RECIPIENT))).toEqual({
      transfers: [],
      remainderRecipient: RECIPIENT,
      steps: [],
    });
  });

  test('a fixed lane and the remainder lane: each is paid at its first adapter, and the steps run in lane order', () => {
    const daiForGas = 50n * 10n ** 18n;
    const gasSwap = uniswapV3.exactIn({ path: { tokenIn: DAI, hops: [{ fee: 500, tokenOut: WETH }] }, minOut: 1n });
    const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: UNBOUNDED });
    const swap = uniswapV3.exactIn({ path: { tokenIn: USDC, hops: [{ fee: 500, tokenOut: WETH }] }, minOut: 2n });
    const unwrap = weth.unwrap();
    const compiled = dai()
      .fixed(daiForGas, lane => lane.step(gasSwap).step(unwrap).to(RECIPIENT))
      .remainder(lane => lane.step(sell).step(swap).step(unwrap).to(RECIPIENT));
    expect(compiled).toEqual({
      transfers: [{ amount: daiForGas, recipient: ADAPTERS.uniswapV3.address }],
      remainderRecipient: ADAPTERS.makerPsm.address,
      steps: [
        stepCall(gasSwap, ADAPTERS.weth.address),
        stepCall(unwrap, RECIPIENT),
        stepCall(sell, ADAPTERS.uniswapV3.address),
        stepCall(swap, ADAPTERS.weth.address),
        stepCall(unwrap, RECIPIENT),
      ],
    });
  });

  test('several fixed lanes: a lane with no steps is a plain transfer', () => {
    const compiled = dai()
      .fixed(100n, lane => lane.to(FRIEND))
      .fixed(50n, lane => lane.step(makerPsm.buyGem({ psm: LITE_PSM, minOut: 49n })).to(FRIEND))
      .remainder(lane =>
        lane.step(curve.exchange({ pool: THREE_POOL, from: DAI, to: USDT, minOut: MIN_OUT })).to(RECIPIENT),
      );
    expect(compiled.transfers).toEqual([
      { amount: 100n, recipient: FRIEND },
      { amount: 50n, recipient: ADAPTERS.makerPsm.address },
    ]);
    expect(compiled.remainderRecipient).toBe(ADAPTERS.curve.address);
    expect(compiled.steps.map(step => step.target)).toEqual([ADAPTERS.makerPsm.address, ADAPTERS.curve.address]);
  });

  test('call lanes run where they are declared, the remainder lane last', () => {
    const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: MIN_OUT });
    const first = check.holds(BALANCE, 1n);
    const second = check.holds(BALANCE, 2n);
    const compiled = dai()
      .call(lane => lane.end(first))
      .fixed(100n, lane => lane.to(FRIEND))
      .call(lane => lane.end(second))
      .remainder(lane => lane.step(sell).to(RECIPIENT));
    expect(compiled).toEqual({
      transfers: [{ amount: 100n, recipient: FRIEND }],
      remainderRecipient: ADAPTERS.makerPsm.address,
      steps: [noTokenCall(first), noTokenCall(second), stepCall(sell, RECIPIENT)],
    });
  });

  test('a route of one call lane has no transfer and no remainder recipient', () => {
    const holds = check.holds(BALANCE, 1n);
    expect(
      dai()
        .call(lane => lane.end(holds))
        .noRemainder(),
    ).toEqual({
      transfers: [],
      remainderRecipient: undefined,
      steps: [noTokenCall(holds)],
    });
  });

  test('fixed lanes and call lanes with no remainder lane keep their order', () => {
    const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: MIN_OUT });
    const holds = check.holds(BALANCE, 1n);
    const compiled = dai()
      .call(lane => lane.end(holds))
      .fixed(100n, lane => lane.to(FRIEND))
      .fixed(50n, lane => lane.step(sell).to(RECIPIENT))
      .noRemainder();
    expect(compiled).toEqual({
      transfers: [
        { amount: 100n, recipient: FRIEND },
        { amount: 50n, recipient: ADAPTERS.makerPsm.address },
      ],
      remainderRecipient: undefined,
      steps: [noTokenCall(holds), stepCall(sell, RECIPIENT)],
    });
  });

  test('a route of ETH', () => {
    const wrap = weth.wrap();
    expect(withdrawalRoute({ token: ETH }).remainder(lane => lane.step(wrap).to(RECIPIENT)).steps).toEqual([
      stepCall(wrap, RECIPIENT),
    ]);
  });

  describe('refuses', () => {
    test('a recipient that is an adapter of another lane', () => {
      expect(() =>
        dai()
          .fixed(1n, lane => lane.to(ADAPTERS.makerPsm.address))
          .remainder(usdcLane),
      ).toThrow(/is an adapter/);
    });

    test('a recipient that is the adapter of a call lane', () => {
      const holds = check.holds(BALANCE, 1n);
      expect(() =>
        dai()
          .call(lane => lane.end(holds))
          .remainder(lane => lane.to(ADAPTERS.check.address)),
      ).toThrow(/is an adapter/);
    });

    test('two lanes paid at the same adapter', () => {
      const other = dai().fixed(10n, lane => lane.step(makerPsm.buyGem({ psm: LITE_PSM, minOut: 9n })).to(FRIEND));
      expect(() => other.remainder(usdcLane)).toThrow(/would spend the funds of both/);
    });

    test('a lane that pays the token into the adapter where a later lane is paid, but not an earlier one', () => {
      const gas = (lane: LaneBuilder) => lane.step(skyConverter.daiToUsds()).to(FRIEND);
      const main = (lane: LaneBuilder) =>
        lane
          .step(curve.exchange({ pool: THREE_POOL, from: DAI, to: USDT, minOut: 1n }))
          .step(curve.exchange({ pool: THREE_POOL, from: USDT, to: DAI, minOut: 1n }))
          .step(skyConverter.daiToUsds())
          .to(RECIPIENT);
      expect(() => dai().fixed(10n, main).remainder(gas)).toThrow(/where a later lane is paid/);
      expect(() => dai().fixed(10n, gas).remainder(main)).not.toThrow();
    });

    test('a lane that makes the token on the adapter where a later lane is paid, but not an earlier one', () => {
      const toDai = uniswapV3.exactIn({ path: { tokenIn: USDC, hops: [{ fee: 100, tokenOut: DAI }] }, minOut: 1n });
      const backToUsdc = (lane: LaneBuilder) =>
        lane
          .step(toDai)
          .step(curve.exchange({ pool: THREE_POOL, from: DAI, to: USDC, minOut: 1n }))
          .to(FRIEND);
      const toUsdt = (lane: LaneBuilder) =>
        lane.step(curve.exchange({ pool: THREE_POOL, from: USDC, to: USDT, minOut: 1n })).to(RECIPIENT);
      const usdc = () => withdrawalRoute({ token: USDC });
      expect(() => usdc().fixed(10n, backToUsdc).remainder(toUsdt)).toThrow(/where a later lane is paid/);
      expect(() => usdc().fixed(10n, toUsdt).remainder(backToUsdc)).not.toThrow();
    });

    test('a route with no remainder lane that does nothing', () => {
      expect(() => dai().noRemainder()).toThrow(/needs a fixed lane or a call/);
    });

    test('a fixed lane with no amount', () => {
      expect(() => dai().fixed(0n, lane => lane.to(FRIEND))).toThrow(/must have an amount above 0/);
      expect(() => dai().fixed(-1n, lane => lane.to(FRIEND))).toThrow(/must have an amount above 0/);
    });
  });
});
