// @vitest-environment node
/**
 * The hand-off in two steps. `resolveHandoff`: the passkey's key is settled first, each candidate
 * is derived under it, which anchor names the account, how the address hint narrows without ever
 * deciding, and that resolving writes nothing. `adoptHandoff`: the order of the writes, what a
 * failure between them leaves behind, and that a cancelled attempt adopts nothing.
 */
import { Fr } from "@aztec/aztec.js/fields"
import type { RecoverPasskeyResult } from "@obsidion/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnchorTier, CandidateProbe } from "@obsidion/front-core"
import type { CampaignSlot } from "../src/features/onboarding/recoveryProbes"

const h = vi.hoisted(() => ({
  adoptKnownPasskey: vi.fn(),
  beginRecovery: vi.fn(),
  recoverFromHandoffMaterial: vi.fn(),
  recoverFromCache: vi.fn(),
  awaitHandoffMaterial: vi.fn(),
  commitSecret: vi.fn(),
  recordRecoveryMetadata: vi.fn(),
  addWebauthnAccount: vi.fn(),
  tiers: [] as AnchorTier[],
  /** Tiers built from what the material said of itself; `tiers` when unset. */
  tiersFor: undefined as undefined | ((campaign?: CampaignSlot) => AnchorTier[]),
  enterTiers: vi.fn(),
  /** Lets a test hold the chain reads open while it checks what the passkey path already did. */
  generationsGate: undefined as undefined | Promise<void>,
}))

vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({
    rpId: "localhost",
    adoptKnownPasskey: h.adoptKnownPasskey,
    beginRecovery: h.beginRecovery,
    recoverFromHandoffMaterial: h.recoverFromHandoffMaterial,
    recoverFromCache: h.recoverFromCache,
    commitSecret: h.commitSecret,
    recordRecoveryMetadata: h.recordRecoveryMetadata,
  }),
}))
vi.mock("../src/platform/storage/handoffMaterial", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/platform/storage/handoffMaterial")>()),
  awaitHandoffMaterial: h.awaitHandoffMaterial,
}))
vi.mock("../src/features/onboarding/recoveryProbes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/onboarding/recoveryProbes")>()),
  anchorTiers: (_config: unknown, _generations: unknown, campaign?: CampaignSlot) =>
    h.tiersFor?.(campaign) ?? h.tiers,
  enterTiers: h.enterTiers,
}))
const FACTORY = `0x${"11".repeat(20)}`
const OTHER_FACTORY = `0x${"19".repeat(20)}`
const ZERO_NAME = `0x${"0".repeat(64)}`
const generationOn = (accountFactory: string, fpc: string) => ({
  fpcAddress: fpc,
  accountFactory,
  implementation: `${accountFactory.slice(0, 40)}dd`,
  namePortal: `${accountFactory.slice(0, 40)}ee`,
  rollupVersion: "1",
})
/** One published generation that admits and holds no name: the legitimate nameless-user control. */
const chain = {
  catalog: [generationOn(FACTORY, `0x${"0b".repeat(32)}`)] as unknown[],
  names: {} as Record<string, string>,
  record: null as { l2Address: string; rollupVersion: bigint } | null,
}
const published = {
  reader: {
    predictAccountAddress: async (factory: string) =>
      factory === OTHER_FACTORY ? `0x${"39".repeat(20)}` : `0x${"33".repeat(20)}`,
    readNameOf: async (_registry: string, account: string) => chain.names[account] ?? ZERO_NAME,
    readAccountMetadataRegistry: async () => `0x${"23".repeat(20)}`,
    readUserRecord: async () => chain.record,
    readNamePortalRegistry: async () => `0x${"22".repeat(20)}`,
    readFactoryImplementation: async (factory: string) => `${factory.slice(0, 40)}dd`,
  },
  registry: `0x${"22".repeat(20)}`,
  rollupVersion: "1",
  get catalog() {
    return chain.catalog
  },
}
vi.mock("../src/features/onboarding/oxideGenerations", () => ({
  loadOxideGenerations: async () => {
    if (h.generationsGate) await h.generationsGate
    return published
  },
  generationFactories: () => [FACTORY, OTHER_FACTORY],
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  AccountStorage: { get: () => ({ addWebauthnAccount: h.addWebauthnAccount }) },
}))

const { adoptHandoff, resolveHandoff, HANDOFF_POLICY_VERSION, primeHandoffMaterial, __resetPrimedHandoffMaterialForTests, CeremonyRequiredError} = await import(
  "../src/features/onboarding/oxideOnboarding"
)
const { GateCancelledError, isGateCancelled } = await import(
  "../src/features/identity/ceremonyGate"
)
const { campaignSlotProbe } = await import("../src/features/onboarding/recoveryProbes")

const first = Fr.random()
const second = Fr.random()
const FIRST_ADDR = `0x${"11".repeat(32)}`
const SECOND_ADDR = `0x${"2a".repeat(32)}`
const ADDRESS = { [first.toString()]: FIRST_ADDR, [second.toString()]: SECOND_ADDR }
/** The passkey's real key: the addresses above exist only under it. */
const KEY = "ab"
const deriveAccountAddress = vi.fn(async (msk: Fr, pubkeyHex: string) => ({
  toString: () => (pubkeyHex === KEY ? ADDRESS[msk.toString()]! : "0xnever"),
}))
const wallet = { deriveAccountAddress } as never
const config = {} as never
const gate = async () => ({ signal: new AbortController().signal, reach: "unknown" as const })
/** A gate whose first call starts `controller`'s attempt; an "again" call refuses a cancelled one. */
const gateOf = (controller: AbortController) => async (options?: { again?: AbortSignal }) => {
  if (options?.again?.aborted) throw new GateCancelledError()
  return { signal: options?.again ?? controller.signal, reach: "unknown" as const }
}
const hints = { credentialId: "cred", pubkeyHex: KEY }
/** The signing keys the wallet was asked to derive under. */
const keysDerivedUnder = () => new Set(deriveAccountAddress.mock.calls.map(([, key]) => key))
const current = (expectedL2Address: string) => ({
  ...hints,
  expectedL2Address,
  policyVersion: HANDOFF_POLICY_VERSION,
})

function recovered(partial: Partial<RecoverPasskeyResult> = {}): RecoverPasskeyResult {
  return {
    authProvider: { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] } as never,
    credentialId: "cred",
    pubkey: KEY,
    candidates: { first, second },
    preferredSlot: "first",
    hasPersistedSlot: false,
    candidateSource: "webauthn",
    ...partial,
  } as RecoverPasskeyResult
}

/** A probe that anchors the listed addresses and answers absent for the rest. */
const anchoring =
  (...addresses: string[]): CandidateProbe =>
  async (_msk, address) =>
    addresses.includes(address) ? "anchored" : "absent"
const absent: CandidateProbe = async () => "absent"
const tier = (name: string, probe: CandidateProbe): AnchorTier => ({ name, probes: [probe] })

beforeEach(() => {
  __resetPrimedHandoffMaterialForTests()
  vi.clearAllMocks()
  h.adoptKnownPasskey.mockResolvedValue(recovered())
  h.awaitHandoffMaterial.mockResolvedValue(null)
  h.recoverFromCache.mockResolvedValue(undefined)
  h.tiers = []
  h.tiersFor = undefined
})

describe("resolveHandoff", () => {
  it("a hand-off before the deposit registered the name resolves through the campaign's record", async () => {
    const registry = vi.fn(absent)
    const campaign = vi.fn(anchoring(SECOND_ADDR))
    h.tiers = [tier("registry", registry), tier("campaign", campaign)]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.msk.toString()).toBe(second.toString())
    expect(resolved.slot).toBe("second")
    expect(registry).toHaveBeenCalledTimes(2)
    expect(h.adoptKnownPasskey).toHaveBeenCalledWith(expect.objectContaining(hints))
    // Both candidates are derived under the hinted key, the one the signature confirmed.
    expect(keysDerivedUnder()).toEqual(new Set([KEY]))
    // Resolving decides only: nothing is committed or recorded until adoption.
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
  })

  it("a key the addresses were not derived under anchors nowhere: refused, nothing written", async () => {
    h.adoptKnownPasskey.mockResolvedValue(recovered({ pubkey: "cd" }))
    const registry = vi.fn(anchoring(FIRST_ADDR, SECOND_ADDR))
    h.tiers = [tier("registry", registry)]
    await expect(resolveHandoff(wallet, {} as never, config, hints, gate)).rejects.toMatchObject({
      name: "NoWalletForPasskeyError",
    })
    expect(keysDerivedUnder()).toEqual(new Set(["cd"]))
    expect(registry.mock.calls.map(([, address]) => address)).toEqual(["0xnever", "0xnever"])
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
  })

  it("material that lands after the primed wait gave up is still taken at the tap", async () => {
    // A minimal store for the real take; the wait itself stays the stub, answering empty.
    const store = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    h.awaitHandoffMaterial.mockResolvedValueOnce(null)
    h.recoverFromHandoffMaterial.mockResolvedValue(recovered())
    h.tiers = [tier("registry", anchoring(SECOND_ADDR))]
    try {
      primeHandoffMaterial("cred")
      await new Promise((r) => setTimeout(r, 0))
      // The frame's write arrives after the wait ended.
      store.set(
        "webwallet.handoff",
        JSON.stringify({
          v: 1,
          derivedAt: Date.now(),
          rpId: "localhost",
          credentialId: "cred",
          pubkeyHex: `0x${"ab".repeat(64)}`,
          candidates: { first: `0x${"11".repeat(32)}` },
        }),
      )
      const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
      // Taken from storage, once: no ceremony was asked for.
      expect(resolved.slot).toBe("second")
      expect(h.recoverFromHandoffMaterial).toHaveBeenCalledTimes(1)
      expect(h.adoptKnownPasskey).not.toHaveBeenCalled()
      expect(h.beginRecovery).not.toHaveBeenCalled()
      expect(store.has("webwallet.handoff")).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("asks the passkey before the chain, so the tap that opened it still counts as activation", async () => {
    // A passkey prompt may only open on a live user activation. Awaiting the tuple, the node and
    // the FPC catalog first spends it, and the browser then offers another device instead of the
    // passkey on this one.
    let releaseChain!: () => void
    h.generationsGate = new Promise<void>((r) => (releaseChain = r))
    h.tiers = [tier("registry", anchoring(FIRST_ADDR))]
    try {
      const pending = resolveHandoff(wallet, {} as never, config, hints, gate)
      await new Promise((r) => setTimeout(r, 0))
      // The key was asked for while the chain reads are still outstanding.
      expect(h.awaitHandoffMaterial).toHaveBeenCalled()

      releaseChain()
      const resolved = await pending
      expect(resolved.slot).toBe("first")
    } finally {
      h.generationsGate = undefined
    }
  })

  it("the Registry record wins over the campaign's answer", async () => {
    const campaign = vi.fn(anchoring(FIRST_ADDR, SECOND_ADDR))
    h.tiers = [tier("registry", anchoring(FIRST_ADDR)), tier("campaign", campaign)]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.slot).toBe("first")
    expect(campaign).not.toHaveBeenCalled()
  })

  it("an address hint under the current policy probes only the candidate it names", async () => {
    const registry = vi.fn(anchoring(SECOND_ADDR))
    h.tiers = [tier("registry", registry)]
    // Hex digits are compared case-insensitively; the `0x` prefix is part of the contract.
    const resolved = await resolveHandoff(
      wallet,
      {} as never,
      config,
      current(`0x${"2A".repeat(32)}`),
      gate,
    )
    expect(resolved.slot).toBe("second")
    expect(registry).toHaveBeenCalledTimes(1)
    expect(registry.mock.calls[0]![1]).toBe(SECOND_ADDR)
  })

  it("a hint naming the sibling costs one more pass over both candidates, not the account", async () => {
    const registry = vi.fn(anchoring(FIRST_ADDR))
    h.tiers = [tier("registry", registry)]
    const resolved = await resolveHandoff(wallet, {} as never, config, current(SECOND_ADDR), gate)
    expect(resolved.slot).toBe("first")
    // One narrowed probe of the sibling, then both candidates.
    expect(registry).toHaveBeenCalledTimes(3)
  })

  it("a hint under an unknown policy version, matching neither candidate, or malformed is ignored", async () => {
    const registry = vi.fn(anchoring(FIRST_ADDR))
    h.tiers = [tier("registry", registry)]
    await resolveHandoff(
      wallet,
      {} as never,
      config,
      { ...hints, expectedL2Address: SECOND_ADDR },
      gate,
    )
    await resolveHandoff(wallet, {} as never, config, current(`0x${"33".repeat(32)}`), gate)
    await resolveHandoff(wallet, {} as never, config, current("2a".repeat(32)), gate)
    await resolveHandoff(wallet, {} as never, config, current(`0X${"2a".repeat(32)}`), gate)
    expect(registry).toHaveBeenCalledTimes(8)
  })

  it("this browser's own record for the passkey beats the hint and asks no anchor", async () => {
    h.adoptKnownPasskey.mockResolvedValue(recovered({ expectedAddress: FIRST_ADDR }))
    const registry = vi.fn(anchoring(SECOND_ADDR))
    h.tiers = [tier("registry", registry)]
    const resolved = await resolveHandoff(wallet, {} as never, config, current(SECOND_ADDR), gate)
    expect(resolved.slot).toBe("first")
    expect(registry).not.toHaveBeenCalled()
  })

  it("no anchor is a refusal with nothing written", async () => {
    h.tiers = [tier("registry", absent), tier("campaign", absent)]
    await expect(resolveHandoff(wallet, {} as never, config, hints, gate)).rejects.toMatchObject({
      name: "NoWalletForPasskeyError",
    })
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    // A hand-off never asks the sign-in's claim-ledger tier.
    expect(h.enterTiers).not.toHaveBeenCalled()
  })

  it("an anchor that cannot answer aborts instead of refusing", async () => {
    h.tiers = [
      tier("registry", absent),
      tier("campaign", async () => {
        throw new Error("campaign down")
      }),
    ]
    await expect(resolveHandoff(wallet, {} as never, config, hints, gate)).rejects.toThrow(
      /campaign down/,
    )
  })

  it("bridge material for the hinted credential is adopted with no ceremony", async () => {
    const material = {
      v: 1,
      derivedAt: 1,
      rpId: "localhost",
      credentialId: "cred",
      pubkeyHex: "0xab",
      candidates: {},
    }
    h.awaitHandoffMaterial.mockResolvedValue(material)
    h.recoverFromHandoffMaterial.mockResolvedValue(recovered({ transports: ["usb"] }))
    h.tiers = [tier("registry", anchoring(SECOND_ADDR))]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.slot).toBe("second")
    // The material's result is adopted as it came, creation list included.
    expect(resolved.recovered.transports).toEqual(["usb"])
    expect(h.awaitHandoffMaterial).toHaveBeenCalledWith("cred", "localhost", 2_000)
    expect(h.recoverFromHandoffMaterial).toHaveBeenCalledWith(material)
    expect(h.adoptKnownPasskey).not.toHaveBeenCalled()
    expect(h.beginRecovery).not.toHaveBeenCalled()
  })

  it("a record left by a retired deployment does not send the hand-off to the ceremony", async () => {
    // The same passkey onboarded here before a roll: the record's address is one no candidate
    // derives any more. The material is good; only the cached address is stale.
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockResolvedValue(
      recovered({ expectedAddress: `0x${"de".repeat(32)}` }),
    )
    h.tiers = [tier("registry", anchoring(SECOND_ADDR))]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    // The anchors named it, and no prompt was opened.
    expect(resolved.slot).toBe("second")
    expect(h.adoptKnownPasskey).not.toHaveBeenCalled()
    expect(h.beginRecovery).not.toHaveBeenCalled()
  })

  it("a stale record still cannot pass material no anchor names", async () => {
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockResolvedValue(
      recovered({ expectedAddress: `0x${"de".repeat(32)}` }),
    )
    h.tiers = [tier("registry", absent)]
    await expect(
      resolveHandoff(wallet, {} as never, config, hints, gate, undefined, true),
    ).rejects.toBeInstanceOf(CeremonyRequiredError)
  })

  it("a record the ceremony's own keys cannot derive either is stale, and fails nothing closed", async () => {
    // One slot in the material, so a ceremony is still worth trying; it returns both, and the
    // record matches neither — a retired deployment's address.
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    const stale = `0x${"de".repeat(32)}`
    h.recoverFromHandoffMaterial.mockResolvedValue(
      recovered({ candidates: { first }, expectedAddress: stale }),
    )
    h.adoptKnownPasskey.mockResolvedValue(recovered({ expectedAddress: stale }))
    h.tiers = [tier("registry", anchoring(SECOND_ADDR))]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.slot).toBe("second")
  })

  it("the slot the campaign's material names is its account, and no outside record is asked", async () => {
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred", slot: "second" })
    h.recoverFromHandoffMaterial.mockResolvedValue(recovered())
    const ledger = vi.fn(absent)
    h.tiersFor = (campaign) => [
      tier("registry", absent),
      ...(campaign ? [tier("campaign", campaignSlotProbe(campaign))] : []),
      tier("reservation", ledger),
    ]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.slot).toBe("second")
    expect(resolved.msk.toString()).toBe(second.toString())
    expect(ledger).not.toHaveBeenCalled()
    expect(h.adoptKnownPasskey).not.toHaveBeenCalled()
  })

  it("material naming no slot leaves the outside records to decide", async () => {
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockResolvedValue(recovered())
    const seen: (CampaignSlot | undefined)[] = []
    h.tiersFor = (campaign) => {
      seen.push(campaign)
      return [tier("registry", absent), tier("reservation", anchoring(FIRST_ADDR))]
    }
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.slot).toBe("first")
    expect(seen).toEqual([undefined])
  })

  it("material no anchor names is spent once, then the ceremony decides", async () => {
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockResolvedValue(recovered())
    let probes = 0
    h.tiers = [
      tier("registry", async (_msk, address) =>
        ++probes > 2 && address === FIRST_ADDR ? "anchored" : "absent",
      ),
    ]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.slot).toBe("first")
    expect(h.awaitHandoffMaterial).toHaveBeenCalledTimes(1)
    expect(h.adoptKnownPasskey).toHaveBeenCalledTimes(1)
    expect(h.adoptKnownPasskey).toHaveBeenCalledWith(expect.objectContaining(hints))
  })

  it("a discoverable hand-off falls back to a discoverable ceremony, not a pinned one", async () => {
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockResolvedValue(recovered())
    h.beginRecovery.mockResolvedValue(recovered())
    let probes = 0
    h.tiers = [
      tier("registry", async (_msk, address) =>
        ++probes > 2 && address === FIRST_ADDR ? "anchored" : "absent",
      ),
    ]
    const resolved = await resolveHandoff(
      wallet,
      {} as never,
      config,
      { ...hints, discover: true },
      gate,
    )
    expect(resolved.slot).toBe("first")
    // The fallback carries `discover` through, so it asks openly instead of pinning the credential.
    expect(h.beginRecovery).toHaveBeenCalledWith(expect.objectContaining({ discover: true }))
    expect(h.adoptKnownPasskey).not.toHaveBeenCalled()
  })

  it("material that does not derive this browser's own record is spent, then the ceremony decides", async () => {
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    // The campaign evaluated one slot; this browser recorded the account under the other.
    h.recoverFromHandoffMaterial.mockResolvedValue(
      recovered({ candidates: { first }, expectedAddress: SECOND_ADDR }),
    )
    h.adoptKnownPasskey.mockResolvedValue(recovered({ expectedAddress: SECOND_ADDR }))
    const registry = vi.fn(absent)
    h.tiers = [tier("registry", registry)]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.slot).toBe("second")
    expect(h.adoptKnownPasskey).toHaveBeenCalledTimes(1)
    expect(registry).not.toHaveBeenCalled()
  })

  it("the session's own key serves a hand-off for the same passkey with no ceremony", async () => {
    h.recoverFromCache.mockResolvedValue(recovered())
    h.tiers = [tier("registry", anchoring(FIRST_ADDR))]
    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(resolved.slot).toBe("first")
    expect(h.adoptKnownPasskey).not.toHaveBeenCalled()
  })

  it("a held key for another passkey does not answer a hand-off naming a different one", async () => {
    h.recoverFromCache.mockResolvedValue(recovered({ credentialId: "someone-else" }))
    h.tiers = [tier("registry", anchoring(FIRST_ADDR))]
    await resolveHandoff(wallet, {} as never, config, hints, gate)
    expect(h.adoptKnownPasskey).toHaveBeenCalledTimes(1)
  })

  it("without a public key the credential is recovered instead of adopted", async () => {
    h.beginRecovery.mockResolvedValue(recovered())
    h.tiers = [tier("registry", anchoring(FIRST_ADDR))]
    await resolveHandoff(wallet, {} as never, config, { credentialId: "cred" }, gate)
    expect(h.beginRecovery).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "cred" }))
    expect(h.adoptKnownPasskey).not.toHaveBeenCalled()
  })

  /** A fresh-browser recovery: the key is one of two until a second assertion settles it. */
  function unsettled(settlesTo = KEY) {
    const settle = vi.fn(async (pubkey?: string) => recovered({ pubkey: pubkey ?? settlesTo }))
    return {
      credentialId: "cred",
      candidates: { first, second },
      preferredSlot: "first" as const,
      expectedAddress: undefined,
      candidateSource: "webauthn" as const,
      authenticatorType: "platform" as const,
      pubkeyCandidates: [KEY, "cd"],
      settle,
    }
  }

  it("a fresh browser's recovery is settled by a second assertion before any anchor is asked", async () => {
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    const order: string[] = []
    begun.settle.mockImplementation(async () => {
      order.push("settle")
      return recovered()
    })
    const again = vi.fn(async (options?: { again?: AbortSignal }) => {
      order.push(options?.again ? "gate-again" : "gate")
      return { signal: new AbortController().signal, reach: "unknown" as const }
    })
    h.tiers = [
      tier("registry", async (_msk, address) => {
        order.push("probe")
        return address === SECOND_ADDR ? "anchored" : "absent"
      }),
    ]
    const resolved = await resolveHandoff(
      wallet,
      {} as never,
      config,
      { credentialId: "cred" },
      again,
    )
    expect(order).toEqual(["gate", "gate-again", "settle", "probe", "probe"])
    expect(begun.settle).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    expect(keysDerivedUnder()).toEqual(new Set([KEY]))
    expect(resolved.recovered.pubkey).toBe(KEY)
    expect(resolved.slot).toBe("second")
  })

  it("a second assertion settling on the wrong key derives no anchored address", async () => {
    h.beginRecovery.mockResolvedValue(unsettled("cd"))
    h.tiers = [tier("registry", anchoring(FIRST_ADDR, SECOND_ADDR))]
    await expect(
      resolveHandoff(wallet, {} as never, config, { credentialId: "cred" }, gate),
    ).rejects.toMatchObject({
      name: "NoWalletForPasskeyError",
    })
    expect(keysDerivedUnder()).toEqual(new Set(["cd"]))
  })

  it("spent material, then a fallback recovery on a fresh browser, is settled the same way", async () => {
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockResolvedValue(recovered())
    const begun = unsettled()
    h.beginRecovery.mockResolvedValue(begun)
    let probes = 0
    h.tiers = [
      tier("registry", async (_msk, address) =>
        ++probes > 2 && address === FIRST_ADDR ? "anchored" : "absent",
      ),
    ]
    const resolved = await resolveHandoff(
      wallet,
      {} as never,
      config,
      { credentialId: "cred" },
      gate,
    )
    expect(h.beginRecovery).toHaveBeenCalledTimes(1)
    expect(begun.settle).toHaveBeenCalledWith(undefined, expect.any(AbortSignal))
    expect(resolved.recovered.pubkey).toBe(KEY)
  })

  it("a fallback ceremony recovering a different key than the material's derives and adopts under that key", async () => {
    const MATERIAL_KEY = "aa"
    const CEREMONY_KEY = "bb"
    // The addresses exist only under the ceremony's key; the material's key derives nothing.
    const derive = vi.fn(async (msk: Fr, pubkeyHex: string) => ({
      toString: () => (pubkeyHex === CEREMONY_KEY ? ADDRESS[msk.toString()]! : "0xnever"),
    }))
    const create = vi.fn(async (msk: Fr) => ({
      getAddress: () => ({ toString: () => ADDRESS[msk.toString()]! }),
      getCompleteAddress: () => ({ toString: () => `${ADDRESS[msk.toString()]!}:complete` }),
    }))
    const rekeyed = { deriveAccountAddress: derive, createObsidionAccount: create } as never
    h.awaitHandoffMaterial.mockResolvedValue({ credentialId: "cred" })
    h.recoverFromHandoffMaterial.mockResolvedValue(
      recovered({ pubkey: MATERIAL_KEY, transports: ["usb"] }),
    )
    h.beginRecovery.mockResolvedValue(recovered({ pubkey: CEREMONY_KEY }))
    const registry = vi.fn(anchoring(FIRST_ADDR))
    h.tiers = [tier("registry", registry)]

    const resolved = await resolveHandoff(
      rekeyed,
      {} as never,
      config,
      { credentialId: "cred" },
      gate,
    )
    expect(resolved.recovered.pubkey).toBe(CEREMONY_KEY)
    expect(resolved.slot).toBe("first")
    // The material pass derived both candidates under its own key, the fallback under the ceremony's.
    expect(derive.mock.calls.map(([, key]) => key)).toEqual([
      MATERIAL_KEY,
      MATERIAL_KEY,
      CEREMONY_KEY,
      CEREMONY_KEY,
    ])
    expect(registry.mock.calls.map(([, address]) => address)).toEqual([
      "0xnever",
      "0xnever",
      FIRST_ADDR,
      SECOND_ADDR,
    ])

    const keys = await adoptHandoff(rekeyed, resolved)
    expect(keys.secretKey).toBe(first)
    expect(create).toHaveBeenCalledWith(first, resolved.recovered.authProvider)
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ l2Address: FIRST_ADDR, pubkey: CEREMONY_KEY, prfSlot: "first" }),
      expect.any(Function),
    )
    // The spent material's creation list goes with it; the ceremony result carries none.
    expect(h.recordRecoveryMetadata.mock.calls[0]![0].transports).toBeUndefined()
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${FIRST_ADDR}:complete`,
      expect.objectContaining({ pubkey: CEREMONY_KEY }),
    )
  })

  it("a hint, material or the session's key is settled already and asks no second assertion", async () => {
    const again = vi.fn(async () => ({ signal: new AbortController().signal, reach: "unknown" as const }))
    h.recoverFromCache.mockResolvedValue(recovered())
    h.tiers = [tier("registry", anchoring(FIRST_ADDR))]
    await resolveHandoff(wallet, {} as never, config, hints, again)
    h.recoverFromCache.mockResolvedValue(undefined)
    await resolveHandoff(wallet, {} as never, config, hints, again)
    expect(h.adoptKnownPasskey).toHaveBeenCalledTimes(1)
    expect(again).not.toHaveBeenCalledWith(expect.objectContaining({ again: expect.anything() }))
  })

  it("cancelled while the anchors resolve: refused with nothing returned", async () => {
    const controller = new AbortController()
    h.beginRecovery.mockResolvedValue(recovered())
    h.tiers = [
      tier("registry", async (_msk, address) => {
        controller.abort()
        return address === FIRST_ADDR ? "anchored" : "absent"
      }),
    ]
    await expect(
      resolveHandoff(wallet, {} as never, config, { credentialId: "cred" }, gateOf(controller)),
    ).rejects.toSatisfy(isGateCancelled)
    expect(h.commitSecret).not.toHaveBeenCalled()
  })

  it("the attempt the gate started travels with the resolution", async () => {
    const controller = new AbortController()
    h.beginRecovery.mockResolvedValue(recovered())
    h.tiers = [tier("registry", anchoring(FIRST_ADDR))]
    const resolved = await resolveHandoff(
      wallet,
      {} as never,
      config,
      { credentialId: "cred" },
      gateOf(controller),
    )
    expect(resolved.attempt).toBe(controller.signal)
  })
})

describe("adoptHandoff", () => {
  const account = {
    getAddress: () => ({ toString: () => SECOND_ADDR }),
    getCompleteAddress: () => ({ toString: () => `${SECOND_ADDR}:complete` }),
  }
  const building = { ...(wallet as object), createObsidionAccount: async () => account } as never
  const resolved = () => ({ recovered: recovered(), msk: second, slot: "second" as const })

  it("builds the account and its record, runs the caller's step, then commits and persists", async () => {
    const order: string[] = []
    h.recordRecoveryMetadata.mockImplementation(async () => void order.push("record"))
    h.commitSecret.mockImplementation(async () => void order.push("commit"))
    h.addWebauthnAccount.mockImplementation(async () => void order.push("persist"))
    const keys = await adoptHandoff(building, resolved(), async () => void order.push("before"))
    expect(order).toEqual(["record", "before", "commit", "persist"])
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ l2Address: SECOND_ADDR, prfSlot: "second", isMskRoot: true }),
      expect.any(Function),
    )
    expect(h.addWebauthnAccount).toHaveBeenCalledWith(
      "Account 1",
      `${SECOND_ADDR}:complete`,
      expect.objectContaining({ credentialId: "cred", pubkey: "ab" }),
    )
    expect(keys.secretKey).toBe(second)
  })

  it("the material's creation transports reach the record write", async () => {
    await adoptHandoff(building, { ...resolved(), recovered: recovered({ transports: ["usb"] }) })
    expect(h.recordRecoveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ transports: ["usb"] }),
      expect.any(Function),
    )
  })

  it("a step that fails before the commit leaves the session and the account record untouched", async () => {
    await expect(
      adoptHandoff(building, resolved(), async () => {
        throw new Error("hand-off cancelled")
      }),
    ).rejects.toThrow(/cancelled/)
    // The breadcrumb may exist: a later unlock only verifies against it.
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a failed commit persists no account record", async () => {
    h.commitSecret.mockRejectedValueOnce(new Error("storage"))
    await expect(adoptHandoff(building, resolved())).rejects.toThrow(/storage/)
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a resolution whose attempt was cancelled adopts nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    const create = vi.fn(async () => account)
    const cancelled = { ...(wallet as object), createObsidionAccount: create } as never
    await expect(
      adoptHandoff(cancelled, { ...resolved(), attempt: controller.signal }),
    ).rejects.toSatisfy(isGateCancelled)
    expect(create).not.toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a cancel that lands while the account is being built commits nothing", async () => {
    const controller = new AbortController()
    const create = vi.fn(async () => {
      controller.abort()
      return account
    })
    const cancelledMidway = { ...(wallet as object), createObsidionAccount: create } as never
    await expect(
      adoptHandoff(cancelledMidway, { ...resolved(), attempt: controller.signal }),
    ).rejects.toSatisfy(isGateCancelled)
    expect(create).toHaveBeenCalledTimes(1)
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  })

  it("a live attempt adopts as one with none", async () => {
    const controller = new AbortController()
    const keys = await adoptHandoff(building, { ...resolved(), attempt: controller.signal })
    expect(keys.secretKey).toBe(second)
    expect(h.commitSecret).toHaveBeenCalledTimes(1)
  })
})

describe("a hand-off is adopted only when the account behind it is confirmed", () => {
  const NAME = `0x${"ab".repeat(32)}`
  const ACCOUNT = `0x${"33".repeat(20)}`
  const OTHER_ACCOUNT = `0x${"39".repeat(20)}`

  beforeEach(() => {
    chain.catalog = [generationOn(FACTORY, `0x${"0b".repeat(32)}`)]
    chain.names = {}
    chain.record = null
    h.adoptKnownPasskey.mockResolvedValue(recovered({ expectedAddress: FIRST_ADDR }))
    h.tiers = [tier("registry", anchoring(FIRST_ADDR))]
  })

  const adoptedNothing = () => {
    expect(h.commitSecret).not.toHaveBeenCalled()
    expect(h.recordRecoveryMetadata).not.toHaveBeenCalled()
    expect(h.addWebauthnAccount).not.toHaveBeenCalled()
  }

  it("a stored address does not excuse a catalog this rollup cannot use", async () => {
    chain.catalog = [{ ...generationOn(FACTORY, `0x${"0b".repeat(32)}`), rollupVersion: "6" }]

    await expect(
      resolveHandoff(wallet, {} as never, config, current(FIRST_ADDR), gate),
    ).rejects.toThrow(/cannot say which account/)
    adoptedNothing()
  })

  it("a stored address does not excuse a record written for another rollup", async () => {
    chain.names = { [ACCOUNT]: NAME }
    chain.record = { l2Address: FIRST_ADDR, rollupVersion: 6n }

    await expect(
      resolveHandoff(wallet, {} as never, config, current(FIRST_ADDR), gate),
    ).rejects.toThrow(/cannot confirm/)
    adoptedNothing()
  })

  it("a stored address does not excuse two named accounts", async () => {
    chain.catalog = [
      generationOn(FACTORY, `0x${"0b".repeat(32)}`),
      generationOn(OTHER_FACTORY, `0x${"0a".repeat(32)}`),
    ]
    chain.names = { [ACCOUNT]: NAME, [OTHER_ACCOUNT]: NAME }

    await expect(
      resolveHandoff(wallet, {} as never, config, current(FIRST_ADDR), gate),
    ).rejects.toThrow(/more than one registered account/)
    adoptedNothing()
  })

  it("a campaign anchor does not excuse a name this device cannot attribute", async () => {
    h.adoptKnownPasskey.mockResolvedValue(recovered({}))
    h.tiers = [tier("registry", absent), tier("campaign", anchoring(FIRST_ADDR))]
    chain.names = { [ACCOUNT]: NAME }
    chain.record = { l2Address: `0x${"cc".repeat(32)}`, rollupVersion: 1n }

    await expect(resolveHandoff(wallet, {} as never, config, hints, gate)).rejects.toThrow(
      /cannot confirm/,
    )
    adoptedNothing()
  })

  it("a nameless campaign signup still resolves, because it owns no account yet", async () => {
    h.adoptKnownPasskey.mockResolvedValue(recovered({}))
    h.tiers = [tier("registry", absent), tier("campaign", anchoring(FIRST_ADDR))]

    const resolved = await resolveHandoff(wallet, {} as never, config, hints, gate)

    expect(resolved.slot).toBe("first")
  })
})
