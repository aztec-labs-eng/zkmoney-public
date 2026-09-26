// getGenerationStack — the app's single version branch. The platform layer
// registers one adapter factory per embedded generation; everything else asks
// by rollup version. Adapter results are untrusted input (old, pinned code),
// so buildExitProof output goes through the exit-bundle codec fail-closed
// before any consumer sees it.

import type { ExitBundleResult, GenerationStack } from "@obsidion/core/types"
import { ExitBundleCodecError, parseExitBundleMessage } from "./exitBundleCodec"

const factories = new Map<number, () => GenerationStack>()
const instances = new Map<number, GenerationStack>()

/** Wrap an adapter so every buildExitProof result is codec-validated. */
export function withFailClosedValidation(stack: GenerationStack): GenerationStack {
  return {
    get rollupVersion() {
      return stack.rollupVersion
    },
    syncToFreeze: () => stack.syncToFreeze(),
    enumerateFrozenNotes: () => stack.enumerateFrozenNotes(),
    async buildExitProof(request) {
      const raw = await stack.buildExitProof(request)
      const parsed = parseExitBundleMessage(raw)
      // Opaque by design — fail-closed errors don't leak message internals.
      if (parsed.type !== "exit-result") throw new ExitBundleCodecError()
      return parsed as ExitBundleResult
    },
  }
}

/** Platform layer registers each embedded generation's adapter factory once. */
export function registerGenerationStack(version: number, factory: () => GenerationStack): void {
  factories.set(version, factory)
  instances.delete(version)
}

/**
 * The only code that maps a rollup version to a stack. Instances are memoized
 * — an adapter owns its generation's PXE and must stay resident.
 */
export function getGenerationStack(version: number): GenerationStack {
  const existing = instances.get(version)
  if (existing) return existing
  const factory = factories.get(version)
  if (!factory) {
    throw new Error(`No GenerationStack registered for rollup version ${version}`)
  }
  const stack = withFailClosedValidation(factory())
  instances.set(version, stack)
  return stack
}

/** Test hook: drop all registrations and memoized instances. */
export function clearGenerationStacks(): void {
  factories.clear()
  instances.clear()
}
