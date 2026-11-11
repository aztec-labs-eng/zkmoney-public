// @vitest-environment node
import { memoryBackend, openDatabase } from "@obsidion/front-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DeviceBoundPasskeyError,
  LaptopPasskeyRefusedError,
  NoPrfError,
  PhoneRequiredError,
  UnsupportedProviderError,
} from "@obsidion/passkey-web"
import {
  LOCAL_REFUSAL_LIMIT,
  countingLocalRefusals,
  countsAsLocalRefusal,
  localRefusalsOverLimit,
} from "../../../src/platform/auth/localRefusals"

const unsupported = () =>
  new UnsupportedProviderError("manager", { providerName: "Bitwarden", localManagers: ["gpm"] })

describe("which refusals count", () => {
  it("counts what another manager's answer causes", () => {
    expect(countsAsLocalRefusal(unsupported())).toBe(true)
    expect(countsAsLocalRefusal(new LaptopPasskeyRefusedError("unnamed", ["1password"]))).toBe(true)
    expect(countsAsLocalRefusal(new LaptopPasskeyRefusedError("not-local", ["gpm"]))).toBe(true)
    // Apple Passwords withdrawn from the row is a manager the row does not admit.
    expect(
      countsAsLocalRefusal(
        new LaptopPasskeyRefusedError("apple", ["1password"], { appleWithdrawn: true }),
      ),
    ).toBe(true)
  })

  it("counts neither 1Password's own failure nor what has its own card", () => {
    expect(countsAsLocalRefusal(new NoPrfError({ manager: "1password" }))).toBe(false)
    expect(countsAsLocalRefusal(new LaptopPasskeyRefusedError("apple", ["gpm"]))).toBe(false)
    expect(countsAsLocalRefusal(new UnsupportedProviderError("security-key"))).toBe(false)
    expect(countsAsLocalRefusal(new DeviceBoundPasskeyError())).toBe(false)
    expect(countsAsLocalRefusal(new PhoneRequiredError())).toBe(false)
    expect(countsAsLocalRefusal(new DOMException("closed", "NotAllowedError"))).toBe(false)
  })
})

describe("the count", () => {
  it("is over the limit only above it, and only while an extension answers", () => {
    expect(localRefusalsOverLimit(true, LOCAL_REFUSAL_LIMIT)).toBe(false)
    expect(localRefusalsOverLimit(true, LOCAL_REFUSAL_LIMIT + 1)).toBe(true)
    expect(localRefusalsOverLimit(false, LOCAL_REFUSAL_LIMIT + 1)).toBe(false)
  })
})

describe("counting creations on this computer", () => {
  // A scripted `create` is an extension answering the page's passkeys.
  beforeEach(() => vi.stubGlobal("navigator", { credentials: { create: async () => null } }))
  afterEach(() => vi.unstubAllGlobals())

  async function run(...creations: Promise<string>[]) {
    const backend = memoryBackend()
    const db = openDatabase(backend)
    await Promise.allSettled(creations.map((c) => countingLocalRefusals(db, c)))
    await db.write(async () => {})
    return backend.entries.get("webwallet.local-refusals")
  }

  it("counts each of two refusals close together", async () => {
    expect(await run(Promise.reject(unsupported()), Promise.reject(unsupported()))).toBe("2")
  })

  it("clears a refusal still saving when the next attempt is accepted", async () => {
    expect(await run(Promise.reject(unsupported()), Promise.resolve("made"))).toBe("0")
  })
})
