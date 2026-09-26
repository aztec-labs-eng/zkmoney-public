import { describe, expect, it } from "vitest"
import type {
  ExitBundleRequest,
  ExitBundleResult,
  FrozenNotesEnumeration,
  GenerationStack,
} from "@obsidion/core/types"
import { parseExitBundleMessage } from "../../src/index.js"
import golden from "./fixtures/exit-bundle-golden.json"

/**
 * GenerationStack contract: a plain in-memory adapter must satisfy
 * the interface with DTOs only — no @aztec types — and its buildExitProof
 * output must survive the host's fail-closed codec unchanged, since the host
 * validates every adapter result as untrusted input.
 */
class FakeGenerationStack implements GenerationStack {
  readonly rollupVersion = 4
  /** The fake's "chain tip" — a frozen chain's tip is its freeze block. */
  private readonly freezeBlock = 1234
  syncedTo: number | null = null

  async syncToFreeze(): Promise<number> {
    this.syncedTo = this.freezeBlock
    return this.freezeBlock
  }

  async enumerateFrozenNotes(): Promise<FrozenNotesEnumeration> {
    return { noteCount: 2, totalAmount: "12000000000" }
  }

  async buildExitProof(_request: ExitBundleRequest): Promise<ExitBundleResult> {
    return golden.bundleMessages.exitResult as ExitBundleResult
  }
}

describe("GenerationStack contract", () => {
  it("a DTO-only in-memory adapter satisfies the interface", async () => {
    const stack: GenerationStack = new FakeGenerationStack()
    const freezeBlock = await stack.syncToFreeze()
    expect(freezeBlock).toBe(1234)
    expect((stack as FakeGenerationStack).syncedTo).toBe(1234)
    const notes = await stack.enumerateFrozenNotes()
    expect(notes.noteCount).toBe(2)
    expect(notes.totalAmount).toBe("12000000000")
  })

  it("buildExitProof output round-trips the fail-closed host codec unchanged", async () => {
    const stack: GenerationStack = new FakeGenerationStack()
    const result = await stack.buildExitProof(golden.hostMessages.exitRequest as ExitBundleRequest)
    expect(parseExitBundleMessage(result)).toEqual(result)
    // and via the JSON string form the boundary actually carries
    expect(parseExitBundleMessage(JSON.stringify(result))).toEqual(result)
  })
})
