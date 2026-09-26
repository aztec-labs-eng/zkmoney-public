// Backward-compat re-export shim.
//
// The canonical home for shared constants is `@obsidion/core/constants`.
// This module retains only the SDK-local constants whose consumers are
// SDK-internal (and so don't meet the cross-cutting bar for core).
//
// New code should import directly from `@obsidion/core/constants` where possible.

import type { WaitOpts } from "@aztec/aztec.js/contracts"
import { TxStatus } from "@aztec/stdlib/tx"

export * from "@obsidion/core/constants"

// ── SDK-local: stays in SDK ──────────────────────────────────────────

/**
 * Product-wallet default for tx waits (`ObsidionWallet.defaultWaitOpts`): resolve as soon as the
 * tx is in a proposed L2 block, instead of aztec.js' CHECKPOINTED default. PROPOSED is already an
 * included tier for the wallet (front-core `INCLUDED_TIERS`); `ReorgMonitor` handles the rare
 * proposed-block reorg. Test/backend wallets override to `{}` — see `ObsidionWallet.defaultWaitOpts`.
 * (Lives in sdk, not core — `TxStatus` is a runtime `@aztec/*` value, which core cannot import.)
 */
export const DEFAULT_WAIT_OPTS: WaitOpts = {
  waitForStatus: TxStatus.PROPOSED,
}

/**
 * Padding capacity for alpha account entrypoint witness arrays.
 * Used by the alpha auth providers (WebAuthnAlphaAuthProvider,
 * EcdsaK256AlphaAuthProvider).
 */
export const MAX_WITNESS_LEN = 500

/**
 * Slot used by alpha account entrypoint when pushing intent capsules.
 * Single in-tree consumer: ObsidionAccountEntrypoint.
 */
export const CAPSULE_SLOT = 1234

