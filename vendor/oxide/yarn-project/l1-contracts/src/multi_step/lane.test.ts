import { describe, expect, test } from '@jest/globals';
import { type Address, keccak256, maxUint256, toHex, zeroAddress } from 'viem';

import { adapters } from './adapters.js';
import { LaneBuilder, type LaneSpec, compileLane } from './lane.js';
import { type Step, type TerminalStep, UNBOUNDED } from './steps/step.js';
import { ADAPTERS, DAI, LITE_PSM, SUSDS, USDC, WETH } from './test_fixtures.js';

const RECIPIENT: Address = '0x1111111111111111111111111111111111111111';
const FRIEND: Address = '0x2222222222222222222222222222222222222222';
const SUSDS_PORTAL = { address: '0x9300000000000000000000000000000000000002' as Address, asset: SUSDS.share };
const COMMITMENT = keccak256(toHex('commitment'));
const MIN_OUT = 2495_000000n;
const LIFI_OPEN = {
  token: USDC,
  destinationChainId: 8453n,
  inputSettler: '0x9100000000000000000000000000000000000001',
  inputOracle: '0x9200000000000000000000000000000000000001',
  outputOracle: `0x${'01'.repeat(32)}`,
  outputSettler: `0x${'02'.repeat(32)}`,
  outputToken: '0x3000000000000000000000000000000000000003',
  recipient: FRIEND,
  minOut: 2490_000000n,
  refundTo: RECIPIENT,
  nonce: 7n,
  fillWindow: 600,
  expiryWindow: 3600,
  context: '0x',
} as const;
const { makerPsm, uniswapV3, weth, skyConverter, erc4626, portalDeposit, lifi } = adapters({
  chainId: 1n,
  configs: ADAPTERS,
});
const unbounded = (lane: LaneBuilder) => lane.step(makerPsm.buyGem({ psm: LITE_PSM, minOut: UNBOUNDED }));

describe('compileLane', () => {
  test('a lane with no steps starts at the recipient and has no call', () => {
    expect(compile(DAI, lane => lane.to(RECIPIENT))).toEqual({ start: RECIPIENT, calls: [] });
  });

  test('each step pays the next adapter, the last pays the recipient', () => {
    const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: UNBOUNDED });
    const swap = uniswapV3.exactIn({ path: { tokenIn: USDC, hops: [{ fee: 500, tokenOut: WETH }] }, minOut: 2n });
    const unwrap = weth.unwrap();
    expect(compile(DAI, lane => lane.step(sell).step(swap).step(unwrap).to(RECIPIENT))).toEqual({
      start: ADAPTERS.makerPsm.address,
      calls: [call(sell, ADAPTERS.uniswapV3.address), call(swap, ADAPTERS.weth.address), call(unwrap, RECIPIENT)],
    });
  });

  test('the last swap pays the adapter of the terminal step, which closes the lane', () => {
    const convert = skyConverter.daiToUsds();
    const deposit = erc4626.deposit({ vault: SUSDS, minOut: 2250n });
    const portal = portalDeposit.deposit({ portal: SUSDS_PORTAL, recipientCommitment: COMMITMENT });
    expect(compile(DAI, lane => lane.step(convert).step(deposit).end(portal))).toEqual({
      start: ADAPTERS.skyConverter.address,
      calls: [
        call(convert, ADAPTERS.erc4626.address),
        call(deposit, ADAPTERS.portalDeposit.address),
        terminalCall(portal),
      ],
    });
  });

  test('a terminal step in first position: the lane starts at its adapter', () => {
    const portal = portalDeposit.deposit({ portal: { address: FRIEND, asset: DAI }, recipientCommitment: COMMITMENT });
    expect(compile(DAI, lane => lane.end(portal))).toEqual({
      start: ADAPTERS.portalDeposit.address,
      calls: [terminalCall(portal)],
    });
  });

  test('a literal token and a plain Address mix in a lane', () => {
    // The fixtures are plain `Address`, so the literal is the lane token.
    const dai = '0x1000000000000000000000000000000000000001' as const;
    const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: MIN_OUT });
    expect(compile(dai, lane => lane.step(sell).to(RECIPIENT)).calls).toHaveLength(1);
  });

  test('an exact-out swap or an intent after an unbounded swap bounds the output', () => {
    const exactOut = uniswapV3.exactOut({
      path: { tokenIn: USDC, hops: [{ fee: 500, tokenOut: WETH }] },
      amountOut: 1n,
      leftoverRecipient: FRIEND,
    });
    expect(compile(DAI, lane => unbounded(lane).step(exactOut).to(RECIPIENT)).calls).toHaveLength(2);
    const intent = lifi.open(LIFI_OPEN);
    expect(compile(DAI, lane => unbounded(lane).end(intent)).calls).toHaveLength(2);
  });

  describe('refuses', () => {
    test('a step that takes another token than the lane holds', () => {
      // Literal types, so that the compiler refuses it too.
      const dai = '0x1000000000000000000000000000000000000001' as const;
      const usdc = '0x2000000000000000000000000000000000000002' as const;
      const psm = makerPsm.buyGem({ psm: { address: LITE_PSM.address, stable: dai, gem: usdc }, minOut: MIN_OUT });
      // @ts-expect-error a DAI step on a USDC lane
      expect(() => compile(usdc, lane => lane.step(psm).to(RECIPIENT))).toThrow(/takes .* but the lane holds/);
    });

    test('a lane whose last swap has no bound', () => {
      expect(() => compile(DAI, lane => unbounded(lane).to(RECIPIENT))).toThrow(/psmBuyGem on .* must have a bound/);
    });

    test('a zero recipient', () => {
      expect(() => compile(DAI, lane => lane.to(zeroAddress))).toThrow(/must not be zero/);
    });

    test('a recipient that is one of the adapters', () => {
      const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: MIN_OUT });
      expect(() => compile(DAI, lane => lane.step(sell).to(ADAPTERS.makerPsm.address))).toThrow(/is an adapter/);
      expect(() => compile(DAI, lane => lane.to(ADAPTERS.lifi.address), [ADAPTERS.lifi.address])).toThrow(
        /is an adapter/,
      );
    });
  });
});

/** Compiles one lane of `token`, with its own adapters as the forbidden recipients unless `adapters` says otherwise. */
function compile<Token extends Address>(
  token: Token,
  build: (lane: LaneBuilder<Token>) => LaneSpec,
  adapters?: Address[],
) {
  const spec = build(new LaneBuilder([]));
  const own = [...spec.steps, ...('terminal' in spec ? [spec.terminal] : [])].map(step => step.adapter);
  return compileLane(token, spec, adapters ?? own);
}

/** The call of a swap: the whole balance, paid to `recipient`. */
function call(step: Step, recipient: Address) {
  return { target: step.adapter, data: step.encode({ amount: maxUint256, recipient }) };
}

/** The call of a terminal step: the whole balance. */
function terminalCall(step: TerminalStep) {
  return { target: step.adapter, data: step.encode({ amount: maxUint256 }) };
}
