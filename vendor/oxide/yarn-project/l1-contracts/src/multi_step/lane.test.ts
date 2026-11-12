import { describe, expect, test } from '@jest/globals';
import { type Address, erc20Abi, keccak256, toHex, zeroAddress } from 'viem';

import { adapters } from './adapters.js';
import { type BuildLane, type LaneBuilder, buildFromEmptyLane, compileCalls, compilePaidLane } from './lane.js';
import { NO_TOKEN, UNBOUNDED } from './steps/step.js';
import { ADAPTERS, DAI, LITE_PSM, SUSDS, USDC, WETH, noTokenCall, stepCall } from './test_fixtures.js';

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
const { makerPsm, uniswapV3, weth, skyConverter, erc4626, portalDeposit, lifi, check } = adapters({
  chainId: 1n,
  configs: ADAPTERS,
});
const BALANCE = { address: DAI, abi: erc20Abi, functionName: 'balanceOf', args: [RECIPIENT] } as const;
/** Fixture tokens with literal types, so that the compiler checks the lanes that use them. */
const DAI_LITERAL = '0x1000000000000000000000000000000000000001' as const;
const USDC_LITERAL = '0x2000000000000000000000000000000000000002' as const;
const LITERAL_PSM = { ...LITE_PSM, stable: DAI_LITERAL, gem: USDC_LITERAL };
const unbounded = (lane: LaneBuilder) => lane.step(makerPsm.buyGem({ psm: LITE_PSM, minOut: UNBOUNDED }));

describe('compilePaidLane', () => {
  test('a lane with no steps is paid at the recipient and has no call', () => {
    expect(compile(DAI, lane => lane.to(RECIPIENT))).toEqual({ paidAt: RECIPIENT, calls: [] });
  });

  test('each step pays the next adapter, the last pays the recipient', () => {
    const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: UNBOUNDED });
    const swap = uniswapV3.exactIn({ path: { tokenIn: USDC, hops: [{ fee: 500, tokenOut: WETH }] }, minOut: 2n });
    const unwrap = weth.unwrap();
    expect(compile(DAI, lane => lane.step(sell).step(swap).step(unwrap).to(RECIPIENT))).toEqual({
      paidAt: ADAPTERS.makerPsm.address,
      calls: [
        stepCall(sell, ADAPTERS.uniswapV3.address),
        stepCall(swap, ADAPTERS.weth.address),
        stepCall(unwrap, RECIPIENT),
      ],
    });
  });

  test('the last swap pays the adapter of the step that ends the lane', () => {
    const convert = skyConverter.daiToUsds();
    const deposit = erc4626.deposit({ vault: SUSDS, minOut: 2250n });
    const portal = portalDeposit.deposit({ portal: SUSDS_PORTAL, recipientCommitment: COMMITMENT });
    expect(compile(DAI, lane => lane.step(convert).step(deposit).end(portal))).toEqual({
      paidAt: ADAPTERS.skyConverter.address,
      calls: [
        stepCall(convert, ADAPTERS.erc4626.address),
        stepCall(deposit, ADAPTERS.portalDeposit.address),
        noTokenCall(portal),
      ],
    });
  });

  test('an ending step in first position: the lane is paid at its adapter', () => {
    const portal = portalDeposit.deposit({ portal: { address: FRIEND, asset: DAI }, recipientCommitment: COMMITMENT });
    expect(compile(DAI, lane => lane.end(portal))).toEqual({
      paidAt: ADAPTERS.portalDeposit.address,
      calls: [noTokenCall(portal)],
    });
  });

  test('steps of no token chain after a step that puts out no token, and one ends the lane', () => {
    const portal = portalDeposit.deposit({ portal: SUSDS_PORTAL, recipientCommitment: COMMITMENT });
    const first = check.holds(BALANCE, 1n);
    const second = check.holds(BALANCE, 2n);
    expect(compile(SUSDS.share, lane => lane.step(portal).step(first).end(second)).calls).toEqual([
      noTokenCall(portal),
      noTokenCall(first),
      noTokenCall(second),
    ]);
  });

  test('a literal token and a plain Address mix in a lane', () => {
    // The fixtures are plain `Address`, so the literal is the lane token.
    const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: MIN_OUT });
    expect(compile(DAI_LITERAL, lane => lane.step(sell).to(RECIPIENT)).calls).toHaveLength(1);
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
      const sell = makerPsm.buyGem({ psm: LITERAL_PSM, minOut: MIN_OUT });
      // @ts-expect-error a DAI step on a USDC lane
      expect(() => compile(USDC_LITERAL, lane => lane.step(sell).to(RECIPIENT))).toThrow(/takes .* but the lane holds/);
    });

    test('a lane whose last swap has no bound', () => {
      expect(() => compile(DAI, lane => unbounded(lane).to(RECIPIENT))).toThrow(/psmBuyGem on .* must have a bound/);
    });

    test('a zero recipient', () => {
      expect(() => compile(DAI, lane => lane.to(zeroAddress))).toThrow(/must not be zero/);
    });

    test('a lane that ends with a step that pays a token', () => {
      const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: MIN_OUT });
      // @ts-expect-error a step that pays a token does not end a lane
      const build: BuildLane = lane => lane.end(sell);
      expect(build).toBeDefined();
      expect(() => compilePaidLane(DAI, { steps: [sell], recipient: undefined }, [])).toThrow(
        /ends holding .* and has no recipient/,
      );
    });

    test('a lane that stops after a step, without `to` or `end`', () => {
      const sell = makerPsm.buyGem({ psm: LITE_PSM, minOut: MIN_OUT });
      // @ts-expect-error a lane is complete only with `to` or `end`
      const build: BuildLane = lane => lane.step(sell);
      expect(build).toBeDefined();
    });

    test('a step of no token after a swap, since the token sits on the next adapter', () => {
      const sell = makerPsm.buyGem({ psm: LITERAL_PSM, minOut: MIN_OUT });
      const holds = check.holds(BALANCE, 1n);
      // @ts-expect-error a step of no token on a USDC lane
      expect(() => compile(DAI_LITERAL, lane => lane.step(sell).end(holds))).toThrow(/takes .* but the lane holds/);
    });

    test('a lane with no step and no recipient', () => {
      expect(() => compilePaidLane(NO_TOKEN, { steps: [], recipient: undefined }, [])).toThrow(
        /needs a step or a recipient/,
      );
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

describe('compileCalls', () => {
  test('a call lane compiles to its calls only', () => {
    const holds = check.holds(BALANCE, 1n);
    expect(
      compileCalls(
        buildFromEmptyLane<NO_TOKEN>(lane => lane.end(holds)),
        [],
      ),
    ).toEqual([noTokenCall(holds)]);
  });

  describe('refuses', () => {
    test('a call lane with a step that takes a token', () => {
      const sell = makerPsm.buyGem({ psm: LITERAL_PSM, minOut: MIN_OUT });
      // @ts-expect-error a DAI step on a lane of no token
      const build: BuildLane<NO_TOKEN> = lane => lane.step(sell).to(RECIPIENT);
      expect(() => compileCalls(buildFromEmptyLane(build), [])).toThrow(/takes .* but the lane holds/);
    });

    test('a call lane that ends at a recipient, since it has nothing to pay', () => {
      // @ts-expect-error the compiler refuses `to` on a lane of NO_TOKEN
      const build: BuildLane<NO_TOKEN> = lane => lane.to(RECIPIENT);
      expect(build).toBeDefined();
    });
  });
});

/** Compiles one lane of `token`, with its own adapters as the forbidden recipients unless `adapters` says otherwise. */
function compile<Token extends Address>(token: Token, build: BuildLane<Token>, adapters?: Address[]) {
  const spec = buildFromEmptyLane(build);
  return compilePaidLane(token, spec, adapters ?? spec.steps.map(step => step.adapter));
}
