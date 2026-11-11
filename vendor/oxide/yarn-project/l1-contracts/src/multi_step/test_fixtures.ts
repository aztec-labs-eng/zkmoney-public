import type { Address } from 'viem';

import type { AdapterConfigs } from './adapters.js';
import type { CurvePool } from './steps/curve.js';
import type { Vault } from './steps/erc4626.js';
import type { Psm } from './steps/maker_psm.js';

export const DAI: Address = '0x1000000000000000000000000000000000000001';
export const USDC: Address = '0x2000000000000000000000000000000000000002';
export const USDT: Address = '0x3000000000000000000000000000000000000003';
export const WETH: Address = '0x4000000000000000000000000000000000000004';
export const USDS: Address = '0x5000000000000000000000000000000000000005';
export const SUSDS_SHARE: Address = '0x6000000000000000000000000000000000000006';

export const LITE_PSM = {
  address: '0x7000000000000000000000000000000000000001',
  stable: DAI,
  gem: USDC,
} satisfies Psm;

export const USDS_PSM = {
  address: '0x7000000000000000000000000000000000000002',
  stable: USDS,
  gem: USDC,
} satisfies Psm;

export const THREE_POOL = {
  address: '0x8000000000000000000000000000000000000001',
  coins: [DAI, USDC, USDT],
} satisfies CurvePool;

export const SUSDS = {
  asset: USDS,
  share: SUSDS_SHARE,
} satisfies Vault;

export const ADAPTERS = {
  makerPsm: { address: '0x9000000000000000000000000000000000000001' },
  curve: { address: '0x9000000000000000000000000000000000000002' },
  uniswapV3: { address: '0x9000000000000000000000000000000000000003' },
  weth: { address: '0x9000000000000000000000000000000000000004', weth: WETH },
  skyConverter: { address: '0x9000000000000000000000000000000000000005', dai: DAI, usds: USDS },
  erc4626: { address: '0x9000000000000000000000000000000000000006' },
  portalDeposit: { address: '0x9000000000000000000000000000000000000007' },
  across: { address: '0x9000000000000000000000000000000000000008' },
  cctp: { address: '0x9000000000000000000000000000000000000009', usdc: USDC },
  lifi: { address: '0x9000000000000000000000000000000000000010' },
} satisfies AdapterConfigs;
