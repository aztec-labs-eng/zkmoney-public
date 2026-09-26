// GenerationStack — the version-agnostic contract between the app and any
// rollup generation's Aztec stack. One adapter per generation implements it;
// getGenerationStack(version) is the app's only version branch. Everything
// crosses this boundary as DTOs/hex strings — no @aztec/* types — because the
// adapters are built against different, mutually-incompatible Aztec versions.
//
// Migration ops only. Live sends go through the canonical generation's own
// service layer (front-core's token/paylink factory seams), not this interface.

import type { ExitBundleRequest, ExitBundleResult } from "./exitBundle.js"

/**
 * What a frozen generation still holds for the acting account. Mirrors the
 * exit-runner NotesEnumerated wire shape (count + total), not per-note detail —
 * the host only ever acts on the aggregate.
 */
export interface FrozenNotesEnumeration {
  noteCount: number
  /** Total exitable amount, decimal string. */
  totalAmount: string
}

/**
 * One rollup generation's stack, driven through DTOs only.
 *
 * The frozen-generation adapter is old, pinned code: the host validates every
 * result fail-closed (front-core exitBundleCodec) and never takes recipient or
 * portal addresses from adapter output — those come from host-held state.
 */
export interface GenerationStack {
  /** On-chain rollup version this stack is pinned to. */
  readonly rollupVersion: number

  /**
   * Sync this generation's PXE to its freeze point and keep it queryable.
   * The adapter discovers the anchor itself — a frozen chain's tip IS its
   * freeze block (no new blocks after demotion), so the adapter reads its own
   * node's latest block rather than taking one from the host. Returns the
   * block it landed on. Idempotent.
   */
  syncToFreeze(): Promise<number>

  /** Enumerate the frozen notes this generation still holds for the account. */
  enumerateFrozenNotes(): Promise<FrozenNotesEnumeration>

  /**
   * Build the escape-door exit proof + TEE co-signature for the frozen notes.
   * Read-only against L1; returns calldata material only — submission is the
   * host's job (it broadcasts the exit as an L1 operation for a relayer).
   */
  buildExitProof(request: ExitBundleRequest): Promise<ExitBundleResult>
}
