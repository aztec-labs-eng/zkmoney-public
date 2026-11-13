/**
 * The page's owner of a rotated wallet's previous one-key account: what it finds and registers per
 * session, what its check reads, and how it runs the move with one signature per chunk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { assignReads } from "../../support/fakeReads"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { TxExecutionResult, TxStatus } from "@aztec-labs/stdlib/tx"
import {
  createSavedPreviousAccount,
  memoryBackend,
  openDatabase,
  type SavedPreviousAccount,
} from "@obsidion/front-core"
import {
  ObsidionAccount,
  WebAuthnAlphaAuthProvider,
  type AlphaAuthProvider,
  type TxHashCallback,
} from "@obsidion/sdk"
import type { PreviousAccountState } from "../../../src/features/backupPasskey/previousAccountWatcher"

const h = vi.hoisted(() => {
  return {
    now: 0,
    auth: {} as Record<string, unknown>,
    providerFor: vi.fn(),
    unlocked: undefined as unknown,
    record: undefined as unknown,
    pipeline: { passFor: vi.fn(), historyFor: vi.fn() },
    balance: 0n,
    txStatus: "pending" as string,
    signGate: undefined as Promise<void> | undefined,
    tokenService: {} as Record<string, ReturnType<typeof vi.fn>>,
    sponsor: vi.fn(),
    identity: vi.fn(),
    shape: vi.fn(),
    l2TokenService: vi.fn(),
    feeTuple: {} as Record<string, string>,
    savingsTuple: undefined as Record<string, string> | undefined,
    savingsBalance: 0n,
    savingsService: {} as Record<string, ReturnType<typeof vi.fn>>,
    /** What the session prices Savings' shares at; unpriced when unset. */
    savingsValue: undefined as ((shares: bigint) => Promise<bigint | undefined>) | undefined,
    caps: {} as Record<string, bigint>,
    wallet: undefined as unknown,
  }
})

const fakeAuth = () => h.auth
vi.mock("../../../src/features/registration/registrationResume", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/features/registration/registrationResume")
  >()),
  unlockedSessionKeys: async () => h.unlocked,
}))
vi.mock("../../../src/config/classArtifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/config/classArtifacts")>()),
  getWebOxideToken: async (_wallet: unknown, _contracts: unknown, l2Token: string) => ({ l2Token }),
}))
vi.mock("../../../src/features/backupPasskey/backupMoveTokens", () => ({
  backupMoveTokens: async () => (h.savingsTuple ? [MAIN_L2, SAVINGS_L2] : [MAIN_L2]),
  moveCap: async (_reads: unknown, token: string) =>
    h.caps[token === SAVINGS_L2 ? SAVINGS_PORTAL : h.feeTuple.portal!] ?? 10n ** 19n,
}))
vi.mock("../../../src/features/token/l2TokenService", () => ({ l2TokenService: h.l2TokenService }))
vi.mock("../../../src/features/registration/claimSponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/registration/claimSponsorship")>()),
  claimSponsorContext: h.sponsor,
}))
vi.mock("../../../src/features/registration/oxideGenerations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/registration/oxideGenerations")>()),
  loadOxideGenerations: async () => ({
    rollupVersion: "7",
    admissibleRollupVersions: new Set(["6", "7"]),
  }),
}))
vi.mock("@obsidion/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/sdk")>()),
  readSpendShape: h.shape,
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  resolveOxideIdentity: h.identity,
}))

const { getPreviousAccountWatcher, resetPreviousAccountWatcherForTests } = await import(
  "../../../src/features/backupPasskey/previousAccountWatcher"
)
const { openTestSession } = await import("../../support/session")

const ROOT = "aa".repeat(64)
const BACKUP = "bb".repeat(64)
const SESSION = AztecAddress.fromStringUnsafe(`0x${"0e".repeat(32)}`)
const PREVIOUS = AztecAddress.fromStringUnsafe(`0x${"0d".repeat(32)}`)
const PREVIOUS_KEY = PREVIOUS.toString()
const ELSEWHERE = AztecAddress.fromStringUnsafe(`0x${"0c".repeat(32)}`)
const MSK = new Fr(0x5e55n)
const HASH = `0x${"0a".repeat(32)}`
const T0 = 1_800_000_000_000
const FEE_TOKEN = "0x00000000000000000000000000000000000000d1"
const ONE = 10n ** 18n
const DUST = 10n ** 16n
const MAIN_L2 = `0x${"01".repeat(32)}`
const SAVINGS_L2 = `0x${"02".repeat(32)}`
const SAVINGS_PORTAL = "0x00000000000000000000000000000000000000b0"
const main = (amount: bigint) => ({ kind: "main", amount, dust: DUST })
const IDLE: PreviousAccountState = { signs: false, moving: false, checking: false, refusals: 0 }

const keyProvider = (key: string) =>
  ({
    getPubkeys: async () => [
      Buffer.from(key.slice(0, 64), "hex"),
      Buffer.from(key.slice(64), "hex"),
    ],
  } as unknown as AlphaAuthProvider)

const rootRecord = (over: Record<string, unknown> = {}) => ({
  credentialId: "cred-root",
  l2Address: SESSION.toString(),
  pubkey: ROOT,
  isMskRoot: true,
  createdAt: 1,
  passkeySet: [ROOT, BACKUP],
  ...over,
})

const backupRecord = () =>
  rootRecord({
    credentialId: "cred-backup",
    pubkey: BACKUP,
    isMskRoot: false,
    backup: { envelopeHex: "01".repeat(62) },
  })

/** The session as the auth service hands it out: one signer object per session. */
function signIn(key: string, record: unknown = key === ROOT ? rootRecord() : backupRecord()) {
  h.record = record
  h.unlocked = {
    account: { getAddress: () => SESSION },
    secretKey: MSK,
    authProvider: keyProvider(key),
    pubkeyHex: `0x${key}`,
  }
}

/** The PXE side: one account per address, signed for by the newest registration's provider. */
function fakeWallet() {
  const previousAccount: ObsidionAccount = Object.assign(Object.create(ObsidionAccount.prototype), {
    getAddress: () => PREVIOUS,
  })
  const created: AlphaAuthProvider[] = []
  let signer: AlphaAuthProvider | undefined
  let held = false
  const wallet = {
    node: {
      getTxReceipt: vi.fn(async () => ({
        status: h.txStatus,
        executionResult: TxExecutionResult.SUCCESS,
      })),
      getBlockData: async () => ({
        header: { globalVariables: { timestamp: BigInt(Math.floor(Date.now() / 1000)) } },
      }),
    },
    deriveAccountAddress: vi.fn(async (_msk: unknown, keys: readonly string[]) => {
      if (keys.length === 2) return SESSION
      return keys[0] === ROOT ? PREVIOUS : ELSEWHERE
    }),
    getAccountFromAddress: async (at: AztecAddress) => {
      if (!held || !at.equals(PREVIOUS)) throw new Error("Account not found")
      return previousAccount
    },
    createObsidionAccount: vi.fn(async (_msk: unknown, provider: AlphaAuthProvider) => {
      created.push(provider)
      signer = provider
      held = true
      return previousAccount
    }),
  }
  h.wallet = wallet
  return {
    wallet: wallet as never,
    derive: wallet.deriveAccountAddress,
    receipts: wallet.node.getTxReceipt,
    previousAccount,
    created,
    signer: () => signer,
    /** An earlier session left the account registered under `provider`. */
    leftWith: (provider: AlphaAuthProvider) => {
      signer = provider
      held = true
    },
  }
}

let saved: SavedPreviousAccount
let offSaved: () => void
/** Savings' shares priced as `h.savingsValue` stands when the watcher reads them. */
const savingsValue = async (shares: bigint) => h.savingsValue?.(shares)
/** Waits for the session's saved copy of the previous account to read `address`. */
const savedReads = (address: string | undefined) =>
  vi.waitFor(() => expect(saved.address.get()).toBe(address))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const idle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  h.now = T0
  vi.spyOn(Date, "now").mockImplementation(() => h.now)
  resetPreviousAccountWatcherForTests()
  saved = createSavedPreviousAccount(openDatabase(memoryBackend()))
  offSaved = saved.address.subscribe(() => {})
  h.balance = 0n
  h.txStatus = TxStatus.PENDING
  h.signGate = undefined
  h.feeTuple = {
    portal: "0x00000000000000000000000000000000000000a0",
    token: FEE_TOKEN,
    l2Token: MAIN_L2,
  }
  h.savingsTuple = undefined
  h.savingsBalance = 0n
  h.savingsValue = undefined
  h.caps = {}
  h.auth = {
    sessionKeys: async () =>
      h.unlocked && {
        secretKey: MSK,
        authProvider: (h.unlocked as { authProvider: unknown }).authProvider,
      },
    accountRecord: vi.fn(async () => h.record),
    providerFor: h.providerFor,
    recordFeePayer: async () => undefined,
  }
  h.providerFor
    .mockReset()
    .mockImplementation((p: { pubkeyHex: string }) => keyProvider(p.pubkeyHex))
  h.unlocked = undefined
  h.pipeline.passFor.mockReset().mockResolvedValue({ completed: true })
  h.pipeline.historyFor.mockReset().mockResolvedValue({ completed: true })
  const session = openTestSession({ auth: fakeAuth(), contractService: { contracts: true } })
  assignReads(session.page.chain, {
    feeTokenBridgeTuple: async () => h.feeTuple,
    teeSignerOfToken: async () => ({ signer: true }),
  })
  getPreviousAccountWatcher().serve({ session, saved, pipeline: h.pipeline, savingsValue })
  h.tokenService = {
    getBalance: vi.fn(async () => h.balance),
    fetchTokenInformation: vi.fn(async () => ({ decimals: 18 })),
    setTeeSigner: vi.fn(),
    sendTokenSponsored: vi.fn(
      async (
        _to: unknown,
        amount: string,
        _sponsor: unknown,
        opts: { onTxHash: TxHashCallback; signal?: AbortSignal },
      ) => {
        await h.signGate
        opts.signal?.throwIfAborted()
        await opts.onTxHash(HASH, { expiresAtMs: Date.now() + 60_000 })
        h.balance -= BigInt(amount)
        h.txStatus = TxStatus.FINALIZED
      },
    ),
  }
  h.savingsService = {
    getBalance: vi.fn(async () => h.savingsBalance),
    fetchTokenInformation: vi.fn(async () => ({ decimals: 18 })),
    setTeeSigner: vi.fn(),
    sendTokenSponsored: vi.fn(
      async (
        _to: unknown,
        amount: string,
        _sponsor: unknown,
        opts: { onTxHash: TxHashCallback },
      ) => {
        await opts.onTxHash(HASH, { expiresAtMs: Date.now() + 60_000 })
        h.savingsBalance -= BigInt(amount)
        h.txStatus = TxStatus.FINALIZED
      },
    ),
  }
  h.l2TokenService
    .mockReset()
    .mockImplementation(async (_page: unknown, _account: unknown, token: string) =>
      token === SAVINGS_L2 ? h.savingsService : h.tokenService,
    )
  h.sponsor.mockReset().mockResolvedValue({ fpcAddress: "fpc", fpcArtifact: { artifact: true } })
  h.identity.mockReset().mockResolvedValue({ kind: "verified", identity: {} })
  h.shape.mockReset().mockImplementation(async (_wallet: unknown, token: { l2Token: string }) => {
    const balance = token.l2Token === SAVINGS_L2 ? h.savingsBalance : h.balance
    return { notes: balance > 0n ? [balance] : [], depositTotal: 0n, balance }
  })
})

afterEach(async () => {
  // Work a test left running ends on its own fakes, not the next test's.
  await idle()
  offSaved()
  resetPreviousAccountWatcherForTests()
  vi.restoreAllMocks()
})

describe("finding and registering the previous account", () => {
  it("registers it with a provider that refuses to sign on a session signed with the backup passkey", async () => {
    const pxe = fakeWallet()
    signIn(BACKUP)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    expect(pxe.created).toHaveLength(1)
    expect(h.providerFor).not.toHaveBeenCalled()
    const [refusing] = pxe.created as WebAuthnAlphaAuthProvider[]
    expect(refusing).toBeInstanceOf(WebAuthnAlphaAuthProvider)
    await expect(refusing!.signChallenge(Buffer.alloc(32))).rejects.toThrow("cannot sign")
    expect(watcher.state.get()).toMatchObject({ address: PREVIOUS_KEY, signs: false })
    await savedReads(PREVIOUS_KEY)
  })

  it("finds and saves the account for the session's opening task, registering nothing", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()

    expect(await watcher.locate(pxe.wallet)).toBe(PREVIOUS_KEY)
    await savedReads(PREVIOUS_KEY)
    expect(pxe.created).toHaveLength(0)
    expect(h.pipeline.passFor).not.toHaveBeenCalled()
  })

  it("names the previous account to its history scan once registered", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    expect(await getPreviousAccountWatcher().registeredAddress(pxe.wallet)).toBe(PREVIOUS_KEY)
    expect(pxe.created).toHaveLength(1)
  })

  it("throws when a new session takes over while it registers, so the scan retries soon", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    const create = (pxe.wallet as { createObsidionAccount: ReturnType<typeof vi.fn> })
      .createObsidionAccount
    const real = create.getMockImplementation()! as (...args: unknown[]) => unknown
    const gate = deferred()
    create.mockImplementationOnce(async (...args: unknown[]) => {
      await gate.promise
      return real(...args)
    })
    const watcher = getPreviousAccountWatcher()
    const answer = watcher.registeredAddress(pxe.wallet)
    await vi.waitFor(() => expect(create).toHaveBeenCalled())

    signIn(ROOT)
    void watcher.check(pxe.wallet)
    await idle()
    gate.resolve()
    await expect(answer).rejects.toMatchObject({ code: "aborted" })
  })

  it("finds nothing while the wallet is locked, and has nothing to read", async () => {
    const pxe = fakeWallet()
    const watcher = getPreviousAccountWatcher()

    await watcher.check(pxe.wallet)
    expect(watcher.state.get()).toEqual({ ...IDLE, checkFailed: false })
    expect(pxe.derive).not.toHaveBeenCalled()
    expect(pxe.created).toHaveLength(0)
    expect(h.pipeline.passFor).not.toHaveBeenCalled()
  })

  it("publishes a failed search, and searches again on the next check, leaving no rejection unhandled", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const pxe = fakeWallet()
      signIn(ROOT)
      const unreadable = new Error("records unreadable")
      ;(h.auth.accountRecord as ReturnType<typeof vi.fn>).mockRejectedValueOnce(unreadable)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      expect(watcher.state.get()).toMatchObject({ checking: false, checkFailed: true })
      expect(watcher.state.get().address).toBeUndefined()

      await watcher.check(pxe.wallet)
      expect(watcher.state.get()).toMatchObject({ address: PREVIOUS_KEY, checkFailed: false })
      await idle()
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("starts over under a new session, keeping the account and its holdings while it searches", async () => {
    h.balance = ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    expect(watcher.state.get()).toMatchObject({ signs: true, holdings: [main(ONE)] })

    const seen: PreviousAccountState[] = []
    const off = watcher.state.subscribe(() => seen.push(watcher.state.get()))
    signIn(BACKUP)
    h.pipeline.passFor.mockReturnValueOnce(new Promise(() => {}))
    void watcher.check(pxe.wallet)
    await vi.waitFor(() =>
      expect(watcher.state.get()).toMatchObject({ address: PREVIOUS_KEY, signs: false }),
    )
    off()

    expect(seen.length).toBeGreaterThan(0)
    for (const state of seen) {
      expect(state).toMatchObject({ address: PREVIOUS_KEY, holdings: [main(ONE)] })
    }
  })

  it("clears the state and the bell's address when the new session has no previous account", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    await savedReads(PREVIOUS_KEY)

    signIn(ROOT, rootRecord({ passkeySet: undefined }))
    await watcher.check(pxe.wallet)
    expect(watcher.state.get()).toEqual({ ...IDLE, checkFailed: false })
    await savedReads(undefined)
  })

  it("clears the state when the session ends", async () => {
    h.balance = ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    watcher.stop()
    expect(watcher.state.get()).toEqual(IDLE)
  })
})

describe("the check", () => {
  it("runs the previous account's claims pass, then reads and publishes what it holds", async () => {
    h.balance = 2n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()

    await watcher.check(pxe.wallet)
    expect(h.pipeline.passFor).toHaveBeenCalledTimes(1)
    const [recipient, tokenServiceFor] = h.pipeline.passFor.mock.calls[0]!
    expect(recipient).toBe(PREVIOUS)
    await tokenServiceFor("0xl2")
    expect(h.l2TokenService.mock.lastCall?.slice(1)).toEqual([pxe.previousAccount, "0xl2"])
    expect(watcher.state.get()).toMatchObject({
      address: PREVIOUS_KEY,
      holdings: [main(2n * ONE)],
      claimsIncomplete: false,
      checking: false,
      checkFailed: false,
      signs: true,
    })
  })

  it("publishes that a check runs, joining a second one to it", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    const gate = deferred<{ completed: boolean }>()
    h.pipeline.passFor.mockReturnValueOnce(gate.promise)
    const watcher = getPreviousAccountWatcher()
    const first = watcher.check(pxe.wallet)
    expect(watcher.state.get().checking).toBe(true)
    expect(watcher.check(pxe.wallet)).toBe(first)

    gate.resolve({ completed: true })
    await first
    expect(watcher.state.get().checking).toBe(false)
    expect(h.pipeline.passFor).toHaveBeenCalledTimes(1)
  })

  it("publishes a claims pass that fell short, with what the account holds", async () => {
    h.balance = ONE
    h.pipeline.passFor.mockResolvedValue({ completed: false })
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()

    await watcher.check(pxe.wallet)
    expect(watcher.state.get()).toMatchObject({
      holdings: [main(ONE)],
      claimsIncomplete: true,
      checkFailed: false,
    })
  })

  it("publishes a failed check when the balance read fails, keeping the last holdings", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    h.balance = ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    h.tokenService.getBalance!.mockRejectedValueOnce(new Error("node down"))
    await watcher.check(pxe.wallet)
    expect(watcher.state.get()).toMatchObject({ holdings: [main(ONE)], checkFailed: true })
  })

  it("publishes a failed check when the claims pass throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    h.pipeline.passFor.mockRejectedValue(new Error("rpc down"))
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()

    await watcher.check(pxe.wallet)
    expect(watcher.state.get()).toMatchObject({ checking: false, checkFailed: true })
  })

  it("registers the account once across checks", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    await watcher.check(pxe.wallet)

    expect(pxe.created).toHaveLength(1)
    expect(h.pipeline.passFor).toHaveBeenCalledTimes(2)
  })

  describe("on a deployment with Savings", () => {
    beforeEach(() => {
      h.savingsTuple = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_L2 }
    })

    it("reads Savings' shares beside Main's token, priced by the session", async () => {
      h.balance = ONE
      h.savingsBalance = 3n * ONE
      h.savingsValue = async () => 4n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()

      await watcher.check(pxe.wallet)
      expect(watcher.state.get().holdings).toEqual([
        main(ONE),
        { kind: "savings", amount: 3n * ONE, dust: DUST, value: 4n * ONE },
      ])
    })

    it("leaves the shares unpriced while the session fails to read their price", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      h.savingsBalance = 3n * ONE
      h.savingsValue = async () => Promise.reject(new Error("no price"))
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      expect(watcher.state.get().holdings?.[1]).toEqual({
        kind: "savings",
        amount: 3n * ONE,
        dust: DUST,
      })
    })
  })
})

describe("the history read", () => {
  it("records the account's deposits after registering it, claiming nothing", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()

    expect(await watcher.readHistory(pxe.wallet)).toBe(true)
    expect(pxe.created).toHaveLength(1)
    expect(h.pipeline.historyFor).toHaveBeenCalledWith(PREVIOUS)
    const create = (pxe.wallet as { createObsidionAccount: ReturnType<typeof vi.fn> })
      .createObsidionAccount
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(
      h.pipeline.historyFor.mock.invocationCallOrder[0]!,
    )
    expect(h.pipeline.passFor).not.toHaveBeenCalled()
    expect(h.tokenService.getBalance).not.toHaveBeenCalled()
  })

  it("answers incomplete when the scan fell short", async () => {
    const pxe = fakeWallet()
    signIn(ROOT)
    h.pipeline.historyFor.mockResolvedValueOnce({ completed: false })
    expect(await getPreviousAccountWatcher().readHistory(pxe.wallet)).toBe(false)
  })

  it("has nothing to read on a wallet with no previous account", async () => {
    const pxe = fakeWallet()
    signIn(ROOT, rootRecord({ passkeySet: undefined }))

    expect(await getPreviousAccountWatcher().readHistory(pxe.wallet)).toBe(true)
    expect(h.pipeline.historyFor).not.toHaveBeenCalled()
  })
})

describe("moving", () => {
  it("joins a second move to the one running: one move, one signature, to the session's account", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    const first = watcher.move()
    expect(watcher.move()).toBe(first)
    expect(watcher.state.get().moving).toBe(true)

    expect(await first).toEqual({ kind: "done" })
    const send = h.tokenService.sendTokenSponsored
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      SESSION,
      (5n * ONE).toString(),
      await h.sponsor.mock.results[0]!.value,
      {
        userAccount: pxe.previousAccount,
        useRawAmount: true,
        onTxHash: expect.any(Function),
        signal: expect.any(AbortSignal),
      },
    )
    expect(h.sponsor).toHaveBeenCalledWith(
      {
        session: expect.objectContaining({ auth: h.auth }),
        wallet: pxe.wallet,
        account: pxe.previousAccount,
        contractService: { contracts: true },
      },
      "registered",
    )
    expect(h.tokenService.setTeeSigner).toHaveBeenCalled()
    expect(h.identity).toHaveBeenCalledTimes(1)
    expect(h.identity.mock.calls[0]![0].admissibleRollupVersions).toEqual(new Set(["7"]))
    expect(h.identity.mock.calls[0]![2]).toBe(SESSION.toString())
    expect(h.identity.mock.calls[0]).toHaveLength(3)
    await vi.waitFor(() =>
      expect(watcher.state.get()).toMatchObject({
        moving: false,
        holdings: [main(0n)],
        lastResult: { kind: "done" },
      }),
    )
  })

  it("checks the destination against the record's set before every chunk, and the L1 record once per move", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    pxe.derive.mockClear()
    h.caps = { [h.feeTuple.portal]: 3n * ONE }

    expect(await watcher.move()).toEqual({ kind: "done" })
    const sent = h.tokenService.sendTokenSponsored.mock.calls.map(([, amount]) => amount)
    expect(sent).toEqual([(3n * ONE).toString(), (2n * ONE).toString()])
    expect(pxe.derive.mock.calls.map(([, keys]) => keys)).toEqual([
      [ROOT, BACKUP],
      [ROOT, BACKUP],
    ])
    expect(h.identity).toHaveBeenCalledTimes(1)
  })

  it("waits for a chunk to settle before it cuts the next", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    h.tokenService.sendTokenSponsored!.mockImplementation(
      async (
        _to: unknown,
        amount: string,
        _sponsor: unknown,
        opts: { onTxHash: TxHashCallback },
      ) => {
        await opts.onTxHash(HASH, { expiresAtMs: Date.now() + 60_000 })
        h.balance -= BigInt(amount)
      },
    )
    h.caps = { [h.feeTuple.portal]: 3n * ONE }
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    try {
      const run = watcher.move()
      await vi.waitFor(() => expect(pxe.receipts).toHaveBeenCalled())
      expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(1)

      h.txStatus = TxStatus.FINALIZED
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await run).toEqual({ kind: "done" })
      expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  describe("the run's rows", () => {
    /** Sends that stay unsettled until the test says so, each under its own hash. */
    const unsettledSends = () => {
      let sends = 0
      h.tokenService.sendTokenSponsored!.mockImplementation(
        async (
          _to: unknown,
          amount: string,
          _sponsor: unknown,
          opts: { onTxHash: TxHashCallback },
        ) => {
          await h.signGate
          await opts.onTxHash(`0x${String(++sends).padStart(64, "0")}`, {
            expiresAtMs: Date.now() + 60_000,
          })
          h.balance -= BigInt(amount)
        },
      )
    }
    const run = () => getPreviousAccountWatcher().state.get().run

    it("goes preparing, confirming, moved, then preparing again, and ends with the holdings read", async () => {
      h.balance = 5n * ONE
      h.caps = { [h.feeTuple.portal!]: 3n * ONE }
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      unsettledSends()
      vi.useFakeTimers({ toFake: ["setTimeout"] })
      try {
        const moving = watcher.move()
        await vi.waitFor(() => expect(pxe.receipts).toHaveBeenCalled())
        expect(run()).toEqual({
          rows: [{ kind: "main", moved: 0, phase: "confirming" }],
          approvals: 1,
        })

        const second = deferred()
        h.signGate = second.promise
        h.txStatus = TxStatus.FINALIZED
        await vi.advanceTimersByTimeAsync(15_000)
        await vi.waitFor(() =>
          expect(run()).toEqual({
            rows: [{ kind: "main", moved: 1, phase: "preparing" }],
            approvals: 2,
          }),
        )

        h.signGate = undefined
        second.resolve()
        expect(await moving).toEqual({ kind: "done" })
        // No frame shows the move over with the moved funds still listed.
        expect(watcher.state.get()).toMatchObject({
          moving: false,
          moved: true,
          holdings: [main(0n)],
        })
        expect(run()).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }

      await watcher.check(pxe.wallet)
      expect(watcher.state.get().moved).toBe(false)
    })

    it("counts an approval and no moved transfer for one that reverted", async () => {
      h.balance = 5n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      let sends = 0
      const second = deferred()
      h.tokenService.sendTokenSponsored!.mockImplementation(
        async (_to: unknown, _amount: string, _sponsor: unknown, opts: { onTxHash: TxHashCallback }) => {
          if (++sends === 2) await second.promise
          await opts.onTxHash(`0x${String(sends).padStart(64, "0")}`, {
            expiresAtMs: Date.now() + 60_000,
          })
          if (sends === 2) h.balance = 0n
        },
      )
      h.txStatus = TxStatus.FINALIZED
      pxe.receipts.mockResolvedValueOnce({
        status: TxStatus.FINALIZED,
        executionResult: TxExecutionResult.REVERTED,
      })

      const moving = watcher.move()
      await vi.waitFor(() =>
        expect(run()).toEqual({
          rows: [{ kind: "main", moved: 0, phase: "preparing" }],
          approvals: 2,
        }),
      )
      second.resolve()
      expect(await moving).toEqual({ kind: "done" })
    })

    it("keeps how far a stopped move got, then moves only what is left", async () => {
      h.savingsTuple = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_L2 }
      h.balance = ONE
      h.savingsBalance = 3n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      const sponsor = deferred<unknown>()
      h.sponsor
        .mockResolvedValueOnce({ fpcAddress: "fpc", fpcArtifact: {} })
        .mockReturnValueOnce(sponsor.promise)
      const leave = new AbortController()

      const moving = watcher.move({ signal: leave.signal })
      await vi.waitFor(() => expect(h.sponsor).toHaveBeenCalledTimes(2))
      leave.abort()
      sponsor.resolve({ fpcAddress: "fpc", fpcArtifact: {} })

      expect(await moving).toEqual({ kind: "stopped" })
      expect(watcher.state.get()).toMatchObject({
        moving: false,
        lastResult: { kind: "stopped" },
        run: {
          rows: [
            { kind: "main", moved: 1, done: true },
            { kind: "savings", moved: 0 },
          ],
          approvals: 1,
        },
      })
      expect(h.savingsService.sendTokenSponsored).not.toHaveBeenCalled()

      h.tokenService.sendTokenSponsored!.mockClear()
      expect(await watcher.move()).toEqual({ kind: "done" })
      expect(h.tokenService.sendTokenSponsored).not.toHaveBeenCalled()
      expect(h.savingsService.sendTokenSponsored).toHaveBeenCalledTimes(1)
      expect(watcher.state.get()).toMatchObject({ moved: true })
      expect(run()).toBeUndefined()
    })

    it("counts a balance as moved when the move stops just as its last transfer settles", async () => {
      h.savingsTuple = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_L2 }
      h.balance = ONE
      h.savingsBalance = 3n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      unsettledSends()
      const leave = new AbortController()
      vi.useFakeTimers({ toFake: ["setTimeout"] })
      try {
        const moving = watcher.move({ signal: leave.signal })
        await vi.waitFor(() => expect(pxe.receipts).toHaveBeenCalled())
        h.txStatus = TxStatus.FINALIZED
        leave.abort()
        await vi.advanceTimersByTimeAsync(15_000)

        expect(await moving).toEqual({ kind: "stopped" })
        expect(run()).toEqual({
          rows: [
            { kind: "main", moved: 1, done: true },
            { kind: "savings", moved: 0 },
          ],
          approvals: 1,
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it("keeps a balance stopped between two of its transfers as part moved", async () => {
      h.balance = 5n * ONE
      h.caps = { [h.feeTuple.portal!]: 3n * ONE }
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      const sponsor = deferred<unknown>()
      h.sponsor
        .mockResolvedValueOnce({ fpcAddress: "fpc", fpcArtifact: {} })
        .mockReturnValueOnce(sponsor.promise)
      const leave = new AbortController()

      const moving = watcher.move({ signal: leave.signal })
      await vi.waitFor(() => expect(h.sponsor).toHaveBeenCalledTimes(2))
      leave.abort()
      sponsor.resolve({ fpcAddress: "fpc", fpcArtifact: {} })

      expect(await moving).toEqual({ kind: "stopped" })
      expect(run()).toEqual({ rows: [{ kind: "main", moved: 1 }], approvals: 1 })
    })

    it("shows a transfer an earlier run left in flight on no row, and counts no approval for it", async () => {
      h.balance = 5n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      await saved.saveMove(PREVIOUS_KEY, {
        destination: SESSION.toString(),
        txHash: `0x${"0e".repeat(32)}`,
        expiresAtMs: Date.now() + 60_000,
        amount: ONE,
      })
      vi.useFakeTimers({ toFake: ["setTimeout"] })
      try {
        const moving = watcher.move()
        await vi.waitFor(() =>
          expect(run()).toEqual({ rows: [{ kind: "main", moved: 0 }], approvals: 0, earlier: true }),
        )

        h.txStatus = TxStatus.FINALIZED
        await vi.advanceTimersByTimeAsync(15_000)
        expect(await moving).toEqual({ kind: "done" })
        expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it("drops a run when a new session starts on the same earlier address, for good", async () => {
      h.balance = 5n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      const prompt = deferred()
      h.signGate = prompt.promise
      const moving = watcher.move()
      await vi.waitFor(() => expect(run()?.approvals).toBe(1))

      signIn(ROOT)
      await watcher.locate(pxe.wallet)
      expect(watcher.state.get()).toMatchObject({ address: PREVIOUS_KEY })
      expect(run()).toBeUndefined()

      h.signGate = undefined
      prompt.resolve()
      await moving
      expect(run()).toBeUndefined()
    })
  })

  describe("the approvals forecast", () => {
    const forecast = () => getPreviousAccountWatcher().state.get().forecast

    it("plans each balance worth moving under its cap, once the check has ended", async () => {
      h.savingsTuple = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_L2 }
      h.caps = { [h.feeTuple.portal!]: 3n * ONE }
      h.balance = 5n * ONE
      h.savingsBalance = ONE
      const pxe = fakeWallet()
      signIn(ROOT)

      await getPreviousAccountWatcher().check(pxe.wallet)
      await vi.waitFor(() => expect(forecast()).toEqual({ approvals: 3, upper: false }))
    })

    it("counts no approval for a last chunk the move would leave as dust", async () => {
      h.caps = { [h.feeTuple.portal!]: 3n * ONE }
      h.balance = 3n * ONE + DUST / 2n
      const pxe = fakeWallet()
      signIn(ROOT)

      await getPreviousAccountWatcher().check(pxe.wallet)
      await vi.waitFor(() => expect(forecast()).toEqual({ approvals: 1, upper: false }))
    })

    it("reads no shape of a balance the check found nothing in", async () => {
      h.savingsTuple = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_L2 }
      h.balance = ONE
      const pxe = fakeWallet()
      signIn(ROOT)

      await getPreviousAccountWatcher().check(pxe.wallet)
      await vi.waitFor(() => expect(forecast()).toEqual({ approvals: 1, upper: false }))
      const shapesRead = h.shape.mock.calls.map(([, token]) => (token as { l2Token: string }).l2Token)
      expect(shapesRead).toEqual([MAIN_L2])
    })

    it("leaves the check done and its holdings published when the plan fails or never returns", async () => {
      h.balance = 5n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      h.shape.mockRejectedValueOnce(new Error("node timeout"))

      await watcher.check(pxe.wallet)
      await idle()
      expect(watcher.state.get()).toMatchObject({
        checking: false,
        checkFailed: false,
        holdings: [main(5n * ONE)],
      })
      expect(forecast()).toBeUndefined()

      h.shape.mockReturnValueOnce(new Promise(() => {}))
      await watcher.check(pxe.wallet)
      expect(watcher.state.get()).toMatchObject({ checking: false, holdings: [main(5n * ONE)] })
      expect(await watcher.move()).toEqual({ kind: "done" })
    })

    it("plans nothing while a transfer is saved in flight", async () => {
      h.balance = 5n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.locate(pxe.wallet)
      await saved.saveMove(PREVIOUS_KEY, {
        destination: SESSION.toString(),
        txHash: HASH,
        expiresAtMs: Date.now() + 60_000,
        amount: ONE,
      })

      await watcher.check(pxe.wallet)
      await idle()
      expect(forecast()).toBeUndefined()
      expect(h.shape).not.toHaveBeenCalled()
    })

    it("plans the next move under the cap a spend refusal left", async () => {
      h.balance = 4n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      await watcher.check(pxe.wallet)
      await vi.waitFor(() => expect(forecast()).toEqual({ approvals: 1, upper: false }))
      h.tokenService.sendTokenSponsored!.mockRejectedValueOnce(
        new Error("simulation failed", { cause: new Error("Balance too low") }),
      )

      expect(await watcher.move()).toMatchObject({ kind: "refused", reason: "spend" })
      await vi.waitFor(() => expect(forecast()).toEqual({ approvals: 2, upper: false }))
    })

    it("drops a plan still being read when a move starts", async () => {
      h.balance = 5n * ONE
      const pxe = fakeWallet()
      signIn(ROOT)
      const watcher = getPreviousAccountWatcher()
      const slow = deferred<unknown>()
      h.shape.mockReturnValueOnce(slow.promise)
      await watcher.check(pxe.wallet)
      await vi.waitFor(() => expect(h.shape).toHaveBeenCalledTimes(1))

      expect(await watcher.move()).toEqual({ kind: "done" })
      slow.resolve({ notes: [5n * ONE], depositTotal: 0n, balance: 5n * ONE })
      await idle()
      expect(forecast()).toBeUndefined()
    })
  })

  it("drops the amounts a finished move moved when its closing read fails", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    h.tokenService.getBalance!.mockRejectedValueOnce(new Error("node timeout"))

    expect(await watcher.move()).toEqual({ kind: "done" })
    expect(watcher.state.get()).toMatchObject({ moving: false, moved: true })
    expect(watcher.state.get().holdings).toBeUndefined()
  })

  it("shows a move stopped before any transfer as untouched", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    const leave = new AbortController()
    leave.abort()

    expect(await watcher.move({ signal: leave.signal })).toEqual({ kind: "stopped" })
    expect(watcher.state.get()).toMatchObject({
      moving: false,
      moved: false,
      run: { rows: [{ kind: "main", moved: 0 }], approvals: 0 },
    })
  })

  it("takes no pass over a token the last check found nothing in", async () => {
    h.savingsTuple = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_L2 }
    h.balance = ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    expect(await watcher.move()).toEqual({ kind: "done" })
    const shapesRead = h.shape.mock.calls.map(([, token]) => (token as { l2Token: string }).l2Token)
    expect(shapesRead).not.toContain(SAVINGS_L2)
    expect(h.savingsService.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("waits out a move an earlier session started, then moves for the new session", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    const prompt = deferred()
    h.signGate = prompt.promise
    const first = watcher.move()
    await vi.waitFor(() => expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(1))

    signIn(ROOT)
    await watcher.check(pxe.wallet)
    const second = watcher.move()
    expect(second).not.toBe(first)
    h.signGate = undefined
    prompt.resolve()

    expect(await first).toEqual({ kind: "stopped" })
    expect(await second).toEqual({ kind: "done" })
    expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(watcher.state.get().lastResult).toEqual({ kind: "done" }))
  })

  it("stops a move before its prompt when the caller's signal aborts, and moves on the next call", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    const sponsor = deferred<unknown>()
    h.sponsor.mockReturnValueOnce(sponsor.promise)
    const leave = new AbortController()

    const run = watcher.move({ signal: leave.signal })
    await vi.waitFor(() => expect(h.sponsor).toHaveBeenCalled())
    leave.abort()
    // A sheet reopened before the stop settles shows the move, not a second Move funds.
    expect(watcher.state.get().moving).toBe(true)
    sponsor.resolve({ fpcAddress: "fpc", fpcArtifact: {} })

    expect(await run).toEqual({ kind: "stopped" })
    expect(h.tokenService.sendTokenSponsored).not.toHaveBeenCalled()
    expect(watcher.state.get()).toMatchObject({ moving: false, lastResult: { kind: "stopped" } })
    expect(await watcher.move()).toEqual({ kind: "done" })
    expect(h.balance).toBe(0n)
  })

  it("stops a move inside its send, before the prompt, when the caller's signal aborts", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    const prompt = deferred()
    h.signGate = prompt.promise
    const leave = new AbortController()

    const run = watcher.move({ signal: leave.signal })
    await vi.waitFor(() => expect(h.tokenService.sendTokenSponsored).toHaveBeenCalledTimes(1))
    leave.abort()
    prompt.resolve()

    expect(await run).toEqual({ kind: "stopped" })
    expect(h.balance).toBe(5n * ONE)
  })

  it("refuses before any prompt when the L1 record does not name the session's account", async () => {
    h.balance = 5n * ONE
    h.identity.mockResolvedValue({ kind: "unverified", accounts: [] })
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    expect(await watcher.move()).toEqual({
      kind: "refused",
      reason: "destination",
      amount: 5n * ONE,
    })
    expect(h.sponsor).not.toHaveBeenCalled()
    expect(h.tokenService.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("keeps the next move under half a spend-refused chunk, across a lock, until a move finishes", async () => {
    h.balance = 4n * ONE
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)
    h.tokenService.sendTokenSponsored!.mockRejectedValueOnce(
      new Error("simulation failed", { cause: new Error("Balance too low") }),
    )

    expect(await watcher.move()).toEqual({ kind: "refused", reason: "spend", amount: 4n * ONE })
    expect(watcher.state.get()).toMatchObject({ refusals: 1, cap: 2n * ONE })

    watcher.stop()
    signIn(ROOT)
    await watcher.check(pxe.wallet)
    expect(watcher.state.get()).toMatchObject({ refusals: 1, cap: 2n * ONE })
    h.tokenService.sendTokenSponsored!.mockClear()
    expect(await watcher.move()).toEqual({ kind: "done" })
    const sent = h.tokenService.sendTokenSponsored!.mock.calls.map(([, amount]) => amount)
    expect(sent).toEqual([(2n * ONE).toString(), (2n * ONE).toString()])
    expect(watcher.state.get()).toMatchObject({ refusals: 0, cap: undefined })
  })

  it("fails a move on a session signed with the backup passkey without asking to sign", async () => {
    h.balance = 5n * ONE
    const pxe = fakeWallet()
    signIn(BACKUP)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    const outcome = await watcher.move()
    expect(outcome).toMatchObject({ kind: "failed" })
    expect(h.tokenService.sendTokenSponsored).not.toHaveBeenCalled()
  })

  it("fails a move before any session found the account", async () => {
    fakeWallet()
    signIn(ROOT)

    expect(await getPreviousAccountWatcher().move()).toMatchObject({ kind: "failed" })
  })

  it("moves Main's token, then Savings' shares, each under its own portal's cap", async () => {
    h.savingsTuple = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_L2 }
    h.caps = { [SAVINGS_PORTAL]: 2n * ONE }
    h.balance = ONE
    h.savingsBalance = 3n * ONE
    h.savingsValue = async (shares) => shares
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    expect(await watcher.move()).toEqual({ kind: "done" })
    const amounts = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(([, amount]) => amount)
    expect(amounts(h.tokenService.sendTokenSponsored!)).toEqual([ONE.toString()])
    expect(amounts(h.savingsService.sendTokenSponsored!)).toEqual([
      (2n * ONE).toString(),
      ONE.toString(),
    ])
    expect(h.tokenService.sendTokenSponsored!.mock.invocationCallOrder[0]!).toBeLessThan(
      h.savingsService.sendTokenSponsored!.mock.invocationCallOrder[0]!,
    )
    await vi.waitFor(() =>
      expect(watcher.state.get().holdings).toEqual([
        main(0n),
        { kind: "savings", amount: 0n, dust: DUST, value: 0n },
      ]),
    )
  })

  it("leaves Savings' shares where they are when Main's move is refused", async () => {
    h.savingsTuple = { portal: SAVINGS_PORTAL, l2Token: SAVINGS_L2 }
    h.balance = 5n * ONE
    h.savingsBalance = 3n * ONE
    h.identity.mockResolvedValue({ kind: "unverified", accounts: [] })
    const pxe = fakeWallet()
    signIn(ROOT)
    const watcher = getPreviousAccountWatcher()
    await watcher.check(pxe.wallet)

    expect(await watcher.move()).toMatchObject({ kind: "refused", reason: "destination" })
    expect(h.savingsService.sendTokenSponsored).not.toHaveBeenCalled()
  })
})
