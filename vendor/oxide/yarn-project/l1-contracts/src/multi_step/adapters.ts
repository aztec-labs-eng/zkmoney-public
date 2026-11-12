import { acrossSteps } from './steps/across.js';
import { type CctpConfig, cctpSteps } from './steps/cctp.js';
import { checkSteps } from './steps/check.js';
import { curveSteps } from './steps/curve.js';
import { erc4626Steps } from './steps/erc4626.js';
import { lifiSteps } from './steps/lifi.js';
import { makerPsmSteps } from './steps/maker_psm.js';
import { portalDepositSteps } from './steps/portal_deposit.js';
import { type SkyConverterConfig, skyConverterSteps } from './steps/sky_converter.js';
import type { AdapterConfig, Chain } from './steps/step.js';
import { uniswapV3Steps } from './steps/uniswap_v3.js';
import { userOpSteps } from './steps/user_op.js';
import { type WethConfig, wethSteps } from './steps/weth.js';

/** An address, plus what the adapter fixes at deploy time. */
export type AdapterConfigs = {
  makerPsm: AdapterConfig;
  curve: AdapterConfig;
  uniswapV3: AdapterConfig;
  erc4626: AdapterConfig;
  portalDeposit: AdapterConfig;
  across: AdapterConfig;
  lifi: AdapterConfig;
  userOp: AdapterConfig;
  check: AdapterConfig;
  weth: WethConfig;
  skyConverter: SkyConverterConfig;
  cctp: CctpConfig;
};

/** The steps of each adapter in `configs`. An absent or `undefined` config has none, and other keys are ignored. */
export function adapters<const A extends Partial<AdapterConfigs>>(p: { chainId: bigint; configs: A }): Adapters<A> {
  const bound = Object.entries(p.configs).flatMap(([key, config]) => {
    const steps = STEPS[key as keyof AdapterConfigs] as ((config: unknown, chain: Chain) => unknown) | undefined;
    return steps && config !== undefined ? [[key, steps(config, { chainId: p.chainId })]] : [];
  });
  return Object.fromEntries(bound);
}

/** Required where the config is, optional where it may be `undefined`. */
type Adapters<A extends Partial<AdapterConfigs>> = {
  [K in AdapterKey<A> as undefined extends A[K] ? never : K]: StepsOf<K, A[K]>;
} & {
  [K in AdapterKey<A> as undefined extends A[K] ? (A[K] extends undefined ? never : K) : never]?: StepsOf<
    K,
    NonNullable<A[K]>
  >;
};

type AdapterKey<A> = keyof A & keyof AdapterConfigs;

/** The steps of adapter `K`, with the token types of its config `C`. */
type StepsOf<K extends keyof AdapterConfigs, C> = K extends 'weth'
  ? C extends WethConfig<infer Weth>
    ? ReturnType<typeof wethSteps<Weth>>
    : never
  : K extends 'skyConverter'
    ? C extends SkyConverterConfig<infer Dai, infer Usds>
      ? ReturnType<typeof skyConverterSteps<Dai, Usds>>
      : never
    : K extends 'cctp'
      ? C extends CctpConfig<infer Usdc>
        ? ReturnType<typeof cctpSteps<Usdc>>
        : never
      : ReturnType<(typeof STEPS)[K]>;

const STEPS = {
  makerPsm: makerPsmSteps,
  curve: curveSteps,
  uniswapV3: uniswapV3Steps,
  weth: wethSteps,
  skyConverter: skyConverterSteps,
  erc4626: erc4626Steps,
  portalDeposit: portalDepositSteps,
  across: acrossSteps,
  cctp: cctpSteps,
  lifi: lifiSteps,
  userOp: userOpSteps,
  check: checkSteps,
};
