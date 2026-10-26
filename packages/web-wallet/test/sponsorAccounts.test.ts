// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { ObsidionAccount, WebAuthnAlphaAuthProvider, type AlphaAuthProvider } from "@obsidion/sdk"

vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => {
    throw new Error("the session resolver is not under test")
  },
}))

const { sponsorAccounts } = await import("../src/features/onboarding/sponsorAccounts")
type Deps = Parameters<typeof sponsorAccounts>[0]
type Session = Deps["session"]

const KEY_A = "aa".repeat(64)
const KEY_B = "bb".repeat(64)
const ADDRESS_OF: Record<string, string> = { [KEY_A]: "0xa", [KEY_B]: "0xb" }
const TWO_KEY = "0xab"
const FPC = "0x" + "0f".repeat(32)
const sponsor = { fpcAddress: { toString: () => FPC } } as never

const address = (s: string) => ({ toString: () => s })
const account = (at: string): ObsidionAccount =>
  Object.assign(Object.create(ObsidionAccount.prototype), { getAddress: () => address(at) })
const provider = (key: string): AlphaAuthProvider =>
  ({
    getPubkeys: async () => [
      Buffer.from(key.slice(0, 64), "hex"),
      Buffer.from(key.slice(64), "hex"),
    ],
  } as never)

const record = (over: Record<string, unknown> = {}) => ({
  credentialId: "cred-a",
  l2Address: TWO_KEY,
  pubkey: KEY_A,
  isMskRoot: true,
  createdAt: 1,
  passkeySet: [KEY_A, KEY_B],
  ...over,
})

interface Harness {
  deps: Deps
  acting: ObsidionAccount
  created: AlphaAuthProvider[]
  providerFor: ReturnType<typeof vi.fn>
  recordFeePayer: ReturnType<typeof vi.fn>
  holdsSubscription: ReturnType<typeof vi.fn>
}

function harness(opts: {
  record?: ReturnType<typeof record>
  sessionKey?: string | null
  held?: string[]
  subscribed?: string[]
}): Harness {
  const held = new Map((opts.held ?? []).map((at) => [at, account(at)]))
  const created: AlphaAuthProvider[] = []
  const providerFor = vi.fn((p: { pubkeyHex: string }) => provider(p.pubkeyHex))
  const recordFeePayer = vi.fn(async () => {})
  const holdsSubscription = vi.fn(async (a: ObsidionAccount) =>
    (opts.subscribed ?? []).includes(a.getAddress().toString()),
  )
  const session: Session = {
    accountRecord: async () => opts.record as never,
    sessionKeys: async () =>
      opts.sessionKey === null
        ? undefined
        : ({ secretKey: "msk", authProvider: provider(opts.sessionKey ?? KEY_A) } as never),
    providerFor,
    recordFeePayer,
  }
  const wallet = {
    deriveAccountAddress: async (_: unknown, keys: string[]) => address(ADDRESS_OF[keys[0]!]!),
    getAccountFromAddress: async (at: { toString(): string }) => {
      const found = held.get(at.toString())
      if (!found) throw new Error("Account not found")
      return found
    },
    createObsidionAccount: async (_: unknown, p: AlphaAuthProvider) => {
      created.push(p)
      const [x, y] = await p.getPubkeys()
      const at = ADDRESS_OF[Buffer.concat([x, y]).toString("hex")]!
      const made = account(at)
      held.set(at, made)
      return made
    },
  } as never
  const acting = account(TWO_KEY)
  return {
    deps: { wallet, session, holdsSubscription },
    acting,
    created,
    providerFor,
    recordFeePayer,
    holdsSubscription,
  }
}

const payerOf = async (h: Harness) => (await sponsorAccounts(h.deps, h.acting, sponsor)).payer

describe("sponsorAccounts", () => {
  it("lets the acting account pay when this browser holds no record for it", async () => {
    const h = harness({ record: undefined })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).not.toHaveBeenCalled()
  })

  it("takes an entry naming the acting account without a chain read", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: TWO_KEY, passkey: KEY_A } } }),
    })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).not.toHaveBeenCalled()
  })

  it("takes the held account an entry names without registering anything", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xa", passkey: KEY_A } } }),
      held: ["0xa"],
    })
    expect((await payerOf(h)).getAddress().toString()).toBe("0xa")
    expect(h.created).toHaveLength(0)
    expect(h.recordFeePayer).not.toHaveBeenCalled()
  })

  it("registers the payer with the session's own signer when the session signs with its key", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xa", passkey: KEY_A } } }),
      sessionKey: KEY_A,
    })
    expect((await payerOf(h)).getAddress().toString()).toBe("0xa")
    expect(h.providerFor).toHaveBeenCalledWith({
      credentialId: "cred-a",
      pubkeyHex: KEY_A,
      passkeys: [KEY_A],
    })
    expect(h.created).toEqual([h.providerFor.mock.results[0]!.value])
  })

  it("registers the payer with a signer that refuses when the session signs with another key", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xa", passkey: KEY_A } } }),
      sessionKey: KEY_B,
    })
    expect((await payerOf(h)).getAddress().toString()).toBe("0xa")
    expect(h.providerFor).not.toHaveBeenCalled()
    const [silent] = h.created as WebAuthnAlphaAuthProvider[]
    expect(silent).toBeInstanceOf(WebAuthnAlphaAuthProvider)
    const [x, y] = await silent!.getPubkeys()
    expect(Buffer.concat([x, y]).toString("hex")).toBe(KEY_A)
    await expect(silent!.signChallenge(Buffer.alloc(32))).rejects.toThrow("cannot sign")
  })

  it("refuses an entry whose key no longer derives the account it names", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xelse", passkey: KEY_A } } }),
    })
    await expect(payerOf(h)).rejects.toThrow("does not derive")
  })

  it("needs the unlocked wallet to register the payer", async () => {
    const h = harness({
      record: record({ feePayer: { [FPC]: { address: "0xa", passkey: KEY_A } } }),
      sessionKey: null,
    })
    await expect(payerOf(h)).rejects.toThrow("locked")
  })

  it("lets a one-key account pay itself without probing", async () => {
    const h = harness({ record: record({ passkeySet: undefined }) })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).not.toHaveBeenCalled()
  })

  it("lets a two-key account that holds the note pay itself and writes nothing", async () => {
    const h = harness({ record: record(), subscribed: [TWO_KEY] })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).toHaveBeenCalledTimes(1)
    expect(h.recordFeePayer).not.toHaveBeenCalled()
  })

  it("discovers the single-key payer of a two-key account with no entry, and writes it", async () => {
    const h = harness({ record: record(), subscribed: ["0xa"] })
    expect((await payerOf(h)).getAddress().toString()).toBe("0xa")
    expect(h.recordFeePayer).toHaveBeenCalledWith("cred-a", FPC, { address: "0xa", passkey: KEY_A })
    // The acting account first, then the set in order; the first subscribed account ends the probe.
    expect(h.holdsSubscription.mock.calls.map(([a]) => a.getAddress().toString())).toEqual([
      TWO_KEY,
      "0xa",
    ])
  })

  it("discovers the payer on a device that opened the account with the backup passkey, and writes it on the backup's record", async () => {
    const h = harness({
      record: record({
        credentialId: "cred-b",
        pubkey: KEY_B,
        isMskRoot: false,
        backup: { envelopeHex: "01".repeat(62) },
      }),
      sessionKey: KEY_B,
      subscribed: ["0xa"],
    })
    expect((await payerOf(h)).getAddress().toString()).toBe("0xa")
    expect(h.recordFeePayer).toHaveBeenCalledWith("cred-b", FPC, { address: "0xa", passkey: KEY_A })
    expect(h.providerFor).not.toHaveBeenCalled()
    const [silent] = h.created as WebAuthnAlphaAuthProvider[]
    expect(h.created).toHaveLength(1)
    await expect(silent!.signChallenge(Buffer.alloc(32))).rejects.toThrow("cannot sign")
  })

  it("lets the acting account pay when no single-key account subscribed, and writes nothing", async () => {
    const h = harness({ record: record() })
    expect(await payerOf(h)).toBe(h.acting)
    expect(h.holdsSubscription).toHaveBeenCalledTimes(3)
    expect(h.recordFeePayer).not.toHaveBeenCalled()
  })
})
