import { afterEach, describe, expect, it } from "vitest"
import type {
  ExitBundleRequest,
  ExitBundleResult,
  FrozenNotesEnumeration,
  GenerationStack,
} from "@obsidion/core/types"
import {
  ExitBundleCodecError,
  clearGenerationStacks,
  getGenerationStack,
  registerGenerationStack,
} from "../../src/index.js"
import golden from "./fixtures/exit-bundle-golden.json"

const goldenResult = golden.bundleMessages.exitResult as ExitBundleResult
const goldenRequest = golden.hostMessages.exitRequest as ExitBundleRequest

function fakeStack(version: number, buildResult: unknown): GenerationStack {
  return {
    rollupVersion: version,
    async syncToFreeze() {
      return 42
    },
    async enumerateFrozenNotes(): Promise<FrozenNotesEnumeration> {
      return { noteCount: 1, totalAmount: "5" }
    },
    async buildExitProof() {
      return buildResult as ExitBundleResult
    },
  }
}

afterEach(() => clearGenerationStacks())

describe("getGenerationStack factory", () => {
  it("returns the registered adapter per version — the sole version branch", async () => {
    registerGenerationStack(4, () => fakeStack(4, goldenResult))
    registerGenerationStack(5, () => fakeStack(5, goldenResult))
    expect(getGenerationStack(4).rollupVersion).toBe(4)
    expect(getGenerationStack(5).rollupVersion).toBe(5)
  })

  it("memoizes instances — an adapter stays resident", () => {
    let constructed = 0
    registerGenerationStack(4, () => {
      constructed++
      return fakeStack(4, goldenResult)
    })
    getGenerationStack(4)
    getGenerationStack(4)
    expect(constructed).toBe(1)
  })

  it("throws on an unregistered version", () => {
    expect(() => getGenerationStack(6)).toThrow(/No GenerationStack registered/)
  })

  it("passes a valid exit-result through unchanged", async () => {
    registerGenerationStack(4, () => fakeStack(4, goldenResult))
    const result = await getGenerationStack(4).buildExitProof(goldenRequest)
    expect(result).toEqual(goldenResult)
  })

  it("rejects a malformed adapter result fail-closed", async () => {
    registerGenerationStack(4, () => fakeStack(4, { ...goldenResult, proof: 123 }))
    await expect(getGenerationStack(4).buildExitProof(goldenRequest)).rejects.toThrow(
      ExitBundleCodecError,
    )
  })

  it("rejects a wrong message type (status instead of exit-result) fail-closed", async () => {
    registerGenerationStack(4, () => fakeStack(4, golden.bundleMessages.status))
    await expect(getGenerationStack(4).buildExitProof(goldenRequest)).rejects.toThrow(
      ExitBundleCodecError,
    )
  })
})
