# Multi-step routes

Builders for the `MultiStepExecutor` payload. A route splits the withdrawn token into lanes, and each lane runs steps on adapters.

## Model

A **step** is one adapter call: the adapter spends its whole balance and pays the next adapter, or the recipient. A step that pays nothing on L1 puts out `NO_TOKEN`.

A **lane** is a chain of steps. It only accepts a step that takes the token it holds. Literal addresses are checked by the compiler, plain `Address` values by the route at runtime, and the two mix.

The executor pays each lane first, then runs every step in order. A route has three kinds of lanes.

- A **fixed** lane gets an amount.
- A **call** lane starts with no token (`NO_TOKEN`), so the executor pays it nothing. A step in it can make a token, and the lane then pays it on. It runs where it is declared.
- The **remainder** lane gets the rest and runs last. A route whose tips and any fixed lanes spend everything closes with `noRemainder()` instead, and the executor reverts if something remains.

## Use

Bind the adapters of a deployment once. An adapter that fixes a token or a settler at deploy time takes it beside its address.

```ts
const { makerPsm, uniswapV3, weth, skyConverter, erc4626, portalDeposit, check } = adapters({
  chainId: 1n,
  configs: {
    makerPsm: { address: '0x…' },
    uniswapV3: { address: '0x…' },
    weth: { address: '0x…', weth: WETH },
    skyConverter: { address: '0x…', dai: DAI, usds: USDS },
    erc4626: { address: '0x…' },
    portalDeposit: { address: '0x…' },
    check: { address: '0x…' },
  },
});
```

Build the route. The remainder lane closes it.

```ts
const compiledRoute = withdrawalRoute({ token: DAI })
  // 1 DAI straight to a friend.
  .fixed(1_000000000000000000n, lane => lane.to(friend))
  // 10 DAI → USDS → sUSDS shares into the sUSDS portal.
  .fixed(10_000000000000000000n, lane =>
    lane
      .step(skyConverter.daiToUsds())
      .step(erc4626.deposit({ vault: SUSDS, minOut: 9_000000000000000000n }))
      .end(portalDeposit.deposit({ portal: SUSDS_PORTAL, recipientCommitment })),
  )
  // Revert unless a view call returns the expected result, with no token.
  .call(lane => lane.end(check.holds(read, expected)))
  // The rest: DAI → USDC → WETH → ETH.
  .remainder(lane =>
    lane
      .step(makerPsm.buyGem({ psm: LITE_PSM, minOut: 2495_000000n }))
      .step(
        uniswapV3.exactIn({
          path: { tokenIn: USDC, hops: [{ fee: 500, tokenOut: WETH }] },
          minOut: 1_000000000000000000n,
        }),
      )
      .step(weth.unwrap())
      .to(user),
  );
```

A lane ends at an address with `to`, or with `end` at a step that puts out `NO_TOKEN`. A swap step takes a `minOut`. `UNBOUNDED` is zero, written out so the choice shows.

## Recovery

Instead of running the route, the recovery account signs `multiStepRecoveryDigest` and anyone sends `encodeMultiStepRecover` to the executor, which pays the withdrawn token to the signed recipient.

## Guards

A route fails to build when the executor or an adapter would reject it, or when funds would be unprotected: a step that takes the wrong token, an unbounded last swap. The error names the step or the lane.

## Add an adapter

1. Add the ABI to `scripts/gen_abis.mjs` and its export to `artifacts.ts`.
2. Add `steps/<name>.ts` with the market types and `<name>Steps(config)`, built on `adapterSteps(address, abi)`.
3. Add it to `AdapterConfigs` and `STEPS` in `adapters.ts`.
4. Export the module from `index.ts`.
