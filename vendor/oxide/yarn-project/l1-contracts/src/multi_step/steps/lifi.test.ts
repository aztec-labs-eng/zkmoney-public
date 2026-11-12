import { describe, expect, test } from '@jest/globals';
import { decodeFunctionData, encodeAbiParameters, maxUint256, pad, parseAbiParameters, zeroAddress } from 'viem';

import { LifiIntentAdapterAbi } from '../../artifacts.js';
import type { LaneBuilder } from '../lane.js';
import { USDS, USDS_PSM } from '../test_fixtures.js';
import { lifiSteps } from './lifi.js';
import { makerPsmSteps } from './maker_psm.js';
import { ETH } from './step.js';
import { wethSteps } from './weth.js';

describe('lifi', () => {
  const lifi = lifiSteps({ address: '0x9000000000000000000000000000000000000001' }, { chainId: 1n });
  const open = {
    token: '0x1000000000000000000000000000000000000001',
    destinationChainId: 8453n,
    inputSettler: '0x9100000000000000000000000000000000000001',
    inputOracle: '0x9200000000000000000000000000000000000001',
    outputOracle: `0x${'01'.repeat(32)}`,
    outputSettler: `0x${'02'.repeat(32)}`,
    outputToken: '0x3000000000000000000000000000000000000003',
    recipient: '0x1111111111111111111111111111111111111111',
    minOut: 2490_000000n,
    refundTo: '0x2222222222222222222222222222222222222222',
    nonce: 7n,
    fillWindow: 600,
    expiryWindow: 3600,
    context: '0x',
  } as const;
  // `open` under the names of `LifiIntentAdapter.Open`.
  const { minOut, refundTo, ...passThrough } = open;
  const openArgs = {
    ...passThrough,
    recipient: pad(open.recipient, { size: 32 }),
    outputToken: pad(open.outputToken, { size: 32 }),
    minOutput: minOut,
    refundRecipient: refundTo,
  };

  test('open encodes the amount and maps the user fields to the adapter names', () => {
    const data = lifi.open(open).encode({ amount: 7n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: LifiIntentAdapterAbi, data })).toEqual({
      functionName: 'lifiOpen',
      args: [{ ...openArgs, amount: 7n }],
    });
  });

  test('openWithHook makes the target the recipient and passes its calldata through', () => {
    const { recipient: _, ...order } = open;
    const hook = { target: '0x3333333333333333333333333333333333333333', calldata: '0xbeef' } as const;
    const data = lifi.openWithHook({ ...order, hook }).encode({ amount: 7n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: LifiIntentAdapterAbi, data })).toEqual({
      functionName: 'lifiOpenWithHook',
      args: [
        {
          ...openArgs,
          recipient: pad(hook.target, { size: 32 }),
          amount: 7n,
          callbackData: hook.calldata,
        },
      ],
    });
  });

  test('openWithHook with a lane makes the adapter the recipient and compiles the lane in the output token', () => {
    const psm = makerPsmSteps({ address: '0x9400000000000000000000000000000000000001' });
    const sell = psm.buyGem({ psm: USDS_PSM, minOut: 1n });
    const { recipient: _, ...order } = { ...open, destinationChainId: 1n, outputToken: USDS };
    const hook = { lane: (lane: LaneBuilder) => lane.step(sell).to(open.recipient), fallbackTo: open.refundTo };
    const data = lifi.openWithHook({ ...order, hook }).encode({ amount: 7n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: LifiIntentAdapterAbi, data })).toMatchObject({
      functionName: 'lifiOpenWithHook',
      args: [
        {
          recipient: pad(lifi.address, { size: 32 }),
          callbackData: encodeAbiParameters(parseAbiParameters('address, address, (address target, bytes data)[]'), [
            psm.address,
            open.refundTo,
            [{ target: psm.address, data: sell.encode({ amount: maxUint256, recipient: open.recipient }) }],
          ]),
        },
      ],
    });
  });

  test('a lane hook runs only on the chain of the adapter, never pays the adapter, and needs a fallback', () => {
    const { recipient: _, ...order } = { ...open, destinationChainId: 1n, outputToken: USDS };
    const hook = { lane: (lane: LaneBuilder) => lane.to(open.recipient), fallbackTo: open.refundTo };
    expect(() => lifi.openWithHook({ ...order, destinationChainId: 8453n, hook })).toThrow(
      /needs destinationChainId 1/,
    );
    expect(() => lifi.openWithHook({ ...order, hook: { ...hook, lane: lane => lane.to(lifi.address) } })).toThrow(
      /is an adapter/,
    );
    expect(() => lifi.openWithHook({ ...order, hook: { ...hook, fallbackTo: zeroAddress } })).toThrow(
      /must not be zero/,
    );
  });

  test('a native output is token zero in the order, and a lane of ETH in a hook', () => {
    const weth = wethSteps({
      address: '0x9500000000000000000000000000000000000001',
      weth: '0x4000000000000000000000000000000000000004',
    });
    const { recipient: _, ...order } = { ...open, destinationChainId: 1n, outputToken: ETH };
    const hook = { lane: (lane: LaneBuilder) => lane.step(weth.wrap()).to(open.recipient), fallbackTo: open.refundTo };
    const data = lifi.openWithHook({ ...order, hook }).encode({ amount: 7n, recipient: zeroAddress });
    expect(decodeFunctionData({ abi: LifiIntentAdapterAbi, data })).toMatchObject({
      args: [{ outputToken: pad(zeroAddress, { size: 32 }) }],
    });
  });

  test('refuses a zero refundTo and an expiry that is not after the fill window', () => {
    expect(() => lifi.open({ ...open, refundTo: zeroAddress })).toThrow(/refundTo must not be zero/);
    expect(() => lifi.open({ ...open, expiryWindow: open.fillWindow })).toThrow(/must be longer than fillWindow/);
  });
});
