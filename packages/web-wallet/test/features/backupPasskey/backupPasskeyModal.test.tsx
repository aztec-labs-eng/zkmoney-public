/** Guards: only a one-key account whose reads allow it starts an add, and a pending one stays. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity } from "../../support/identity"

// Before any import evaluates the feature flags.
vi.hoisted(() => vi.stubEnv("VITE_BACKUP_PASSKEY_SETTINGS", "true"))

vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  PrimaryGradientButton: (p: {
    title: string
    onClick?: () => void
    isDisabled?: boolean
    isLoading?: boolean
    testId?: string
  }) => (
    <button
      disabled={p.isDisabled || p.isLoading}
      onClick={p.onClick}
      data-testid={p.testId}
      children={p.title}
    />
  ),
}))

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
/** What this page reads of the browser: the extension on `create`, the kept wrapper, the device. */
const page = vi.hoisted(() => ({
  extension: "none" as string,
  kept: undefined as unknown,
  posture: "laptop" as string,
  userAgent: "",
}))
vi.mock("@obsidion/passkey-web", async (importOriginal) => {
  const original = await importOriginal<typeof import("@obsidion/passkey-web")>()
  return {
    ...original,
    passkeyExtensionFor: () => page.extension,
    keptPasskeyApiFor: () => page.kept,
    currentDevicePosture: () => page.posture,
    currentUserAgentInfoSync: () => original.parseUserAgent({ userAgent: page.userAgent }),
  }
})

const h = vi.hoisted(() => ({
  readAuthKeysCounted: vi.fn(),
  resolveOxideIdentity: vi.fn(),
  sessionKeys: vi.fn(),
  probePhoneReach: vi.fn(),
  addInputs: [] as unknown[],
  refresh: vi.fn(),
  deps: undefined as unknown,
  flowDeps: undefined as unknown,
  facts: undefined as unknown,
  factsRefresh: vi.fn(),
  depsFailures: 0,
  depsBuilt: 0,
  identity: null as { address: string; handle?: string } | null,
  authenticators: {} as Record<string, AuthenticatorRecord | undefined>,
  obsidionWallet: {},
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  createOxideL1Reader: () => ({ readAuthKeysCounted: h.readAuthKeysCounted }),
  resolveOxideIdentity: h.resolveOxideIdentity,
  deriveBootstrapKey: () => ({ address: BOOTSTRAP }),
}))
vi.mock("../../../src/config/oxideTuple", () => ({ l1PublicClient: () => ({}) }))
vi.mock("../../../src/features/registration/oxideGenerations", () => ({
  loadOxideGenerations: async () => GENERATIONS,
}))
vi.mock("../../../src/platform/auth/WebPasskeyIdentityMap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/platform/auth/WebPasskeyIdentityMap")>()),
  authenticatorFor: (_map: string | null, pubkeyHex: string) => h.authenticators[pubkeyHex],
}))
const fakeAuth = () => ({ sessionKeys: h.sessionKeys, probePhoneReach: h.probePhoneReach })
vi.mock("../../../src/features/backupPasskey/backupPasskeyRuntime", () => ({
  buildBackupAddDeps: async (input: unknown) => {
    h.addInputs.push(input)
    return h.deps
  },
  buildBackupFlowDeps: async () => {
    h.depsBuilt++
    if (h.depsFailures > 0) {
      h.depsFailures--
      throw new Error("locked")
    }
    return h.flowDeps
  },
}))
vi.mock("../../../src/features/backupPasskey/backupPasskeyFacts", () => ({
  useBackupEntryFacts: () => ({ facts: h.facts, refresh: h.factsRefresh }),
}))

import {
  credentialIdToMetadata,
  loadRecords,
  memoryBackend,
  memoryStore,
  RootPasskeyRequiredError,
  type AllowanceSnapshot,
  type BackupRotations,
  type MemoryBackend,
  type QueryState,
  type Store,
} from "@obsidion/front-core"
import { RotationRouteNotLiveError } from "@obsidion/sdk"
import unreadableCopy from "../../../src/features/backupPasskey/screens/UnreadableScreen/UnreadableScreen.copy"
import type { RegistrationPending } from "../../../src/features/registration/registrationRail"
import trackerCopy from "../../../src/features/backupPasskey/screens/AddTracker/AddTracker.copy"
import type { AuthenticatorRecord } from "../../../src/platform/auth/WebPasskeyIdentityMap"
import {
  OWNER,
  createdRecord,
  makeBackupAddDeps,
  makeFlowDeps,
  sent,
  signedRecord,
  testRotations,
} from "../../support/backupAdd"
import { openTestSession } from "../../support/session"
import introCopy from "../../../src/features/backupPasskey/screens/IntroScreen/IntroScreen.copy"
import keysCopy from "../../../src/features/backupPasskey/screens/KeysScreen/KeysScreen.copy"
import { fmt } from "../../../src/lib/fmt"
import { usdAtomic } from "../../../src/ui/format"
const { PasskeysModal } = await import("../../../src/ui/PasskeysModal")
const { PasskeysSheet } = await import("../../../src/ui/PasskeysSheet/PasskeysSheet")

const BOOTSTRAP = `0x${"b0".repeat(20)}`
const L2_ADDRESS = `0x${"12".repeat(32)}`
const GENERATIONS = { kind: "generations" }
type Key = { qx: `0x${string}`; qy: `0x${string}` }
const key = (fill: number): Key => ({
  qx: `0x${fill.toString(16).padStart(2, "0").repeat(32)}`,
  qy: `0x${(fill + 1).toString(16).padStart(2, "0").repeat(32)}`,
})
const providerFor = (k: Key) => ({
  getPubkeys: async () => [Buffer.from(k.qx.slice(2), "hex"), Buffer.from(k.qy.slice(2), "hex")],
})
const ROOT_KEY = key(0x10)
const ROOT_METADATA = credentialIdToMetadata("root-credential-id-000001")
const ready = {
  status: "ready",
  read: {},
  state: { kind: "available", available: 10 },
  refreshing: false,
}
/** The session's sponsored allowance, as each test sets it. */
const allowance = memoryStore<AllowanceSnapshot>({ status: "loading" })
const setAllowance = (snapshot: object) => allowance.set(snapshot as AllowanceSnapshot)
const DAI = 10n ** 18n
const FACTS = {
  routeLive: true,
  balance: 10n * DAI,
  fundingAmount: 2n * DAI,
  chunk: { kind: "fits" },
  plan: true,
  moves: 2,
  savingsMoving: false,
  withdrawalInFlight: false,
  links: 0,
  historicBalance: false,
}

let root: Root
let container: HTMLDivElement
const onClose = vi.fn()
const onAction = vi.fn()

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function mount(node = <PasskeysModal onClose={onClose} onAction={onAction} />) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
  await flush(2)
}

const text = () => container.textContent ?? ""
const byTestId = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
/** A1's button. */
const start = () => byTestId("backup-start")
/** A2's button. */
const proceed = () => byTestId("backup-continue")
/** A3's button, which creates the backup. */
const save = () => byTestId("backup-add")
const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
/** A saved attempt's step tracker. */
const panel = () => container.querySelector('[aria-current="step"]')
const approveButton = () => byTestId("backup-approve")
/** The modal's own key list, which A1 replaces. */
const rename = () => byTestId("passkey-rename")

/** A1, then A2, then A3 where the device has a picker. */
async function walkTo(screen: "intro" | "place") {
  await act(async () => start()!.click())
  if (screen === "place") await act(async () => proceed()!.click())
}

function listKeys(count: number) {
  h.readAuthKeysCounted.mockResolvedValue({
    entries: Array.from({ length: count }, (_, i) => ({
      key: i === 0 ? ROOT_KEY : key(0x20 + i),
      metadata: ROOT_METADATA,
    })),
    authKeyCount: count,
  })
}

let backend: MemoryBackend
let rotations: BackupRotations
let rail: Store<QueryState<RegistrationPending | false>>
/** The sponsored-rail query's answer. */
const answer = (value: RegistrationPending | false) =>
  ({ status: "ready", value, refreshing: false } as const)
const chain = () => ({ wallet: h.obsidionWallet, contractService: {} })

beforeEach(async () => {
  backend = memoryBackend()
  rotations = testRotations(backend)
  rail = memoryStore<QueryState<RegistrationPending | false>>(answer(false))
  openTestSession({
    auth: fakeAuth(),
    ...chain(),
    backupRotations: rotations,
    railPending: rail.readonly,
    sponsoredAllowance: { snapshot: allowance.readonly, refresh: h.refresh },
  })
  localStorage.clear()
  page.extension = "none"
  page.kept = undefined
  page.posture = "laptop"
  page.userAgent = MAC_CHROME_UA
  h.probePhoneReach.mockReset()
  h.probePhoneReach.mockResolvedValue("ok")
  h.addInputs.length = 0
  h.authenticators = {}
  await setIdentity({ address: L2_ADDRESS, handle: "brave-otter-42" })
  h.sessionKeys.mockResolvedValue({ secretKey: {}, authProvider: providerFor(ROOT_KEY) })
  h.depsFailures = 0
  h.depsBuilt = 0
  setAllowance(ready)
  h.facts = FACTS
  h.factsRefresh.mockReset()
  h.resolveOxideIdentity.mockResolvedValue({
    kind: "verified",
    identity: { account: OWNER, nameHash: "0x", generations: [] },
  })
  listKeys(1)
  h.deps = makeBackupAddDeps({
    store: rotations,
    seal: async () => new Uint8Array(62).fill(1),
  }).deps
  h.flowDeps = makeFlowDeps({ store: rotations }).deps
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe("the Passkeys modal's start screens", () => {
  it("lists the key with the backup missing, and walks A1, A2 and A3 to the add", async () => {
    await mount()
    expect(text()).toContain(keysCopy.title)
    expect(text()).toContain(keysCopy.current)
    expect(text()).toContain(keysCopy.notAdded)
    expect(rename()).toBeNull()
    await walkTo("place")
    expect(radios().find((r) => r.checked)?.value).toBe("phone")
    await act(async () =>
      radios()
        .find((r) => r.value === "key")!
        .click(),
    )
    await act(async () => save()!.click())
    await flush(2)
    expect(h.addInputs).toMatchObject([{ choice: "key" }])
  })

  it("quotes the cost and time on A2", async () => {
    const quote = {
      total: (7n * DAI) / 10n,
      fixed: DAI / 2n,
      network: DAI / 5n,
      takesMs: 45 * 60_000,
    }
    h.facts = { ...FACTS, quote }
    await mount()
    await walkTo("intro")
    expect(text()).toContain(fmt(introCopy.costValue, { amount: usdAtomic(quote.total) }))
    expect(text()).toContain(fmt(introCopy.timeValue, { minutes: 45 }))
  })

  it("starts the add from A2 on a phone, which has no picker", async () => {
    page.posture = "phone"
    await mount()
    await walkTo("intro")
    await act(async () => proceed()!.click())
    await flush(2)
    expect(h.addInputs).toHaveLength(1)
    expect(h.addInputs[0]).not.toHaveProperty("choice")
  })

  it("holds the picker while the add runs, and closing the sheet ends the creation", async () => {
    const seen: { signal?: AbortSignal } = {}
    h.deps = makeBackupAddDeps({
      store: rotations,
      driver: (_, options) => {
        seen.signal = options.signal
        return new Promise(() => {})
      },
    }).deps
    await mount()
    await walkTo("place")
    await act(async () => save()!.click())
    await flush(2)
    expect(radios().every((r) => r.disabled)).toBe(true)
    expect(save()?.disabled).toBe(true)
    expect(seen.signal?.aborted).toBe(false)
    await act(async () => root.unmount())
    container.remove()
    expect(seen.signal?.aborted).toBe(true)
    await mount()
  })
})

describe("the Passkeys modal's add entry", () => {
  it("shows nothing of the add on a two-key account", async () => {
    listKeys(2)
    await mount()
    expect(start()).toBeNull()
    expect(rename()).not.toBeNull()
    expect(text()).not.toContain(keysCopy.title)
  })

  it("sends A1's button to what holds the add instead of A2", async () => {
    // The session signs with a key the account does not list.
    h.sessionKeys.mockResolvedValue({ secretKey: {}, authProvider: providerFor(key(0x40)) })
    await mount()
    await walkTo("intro")
    expect(start()).toBeNull()
    expect(proceed()).toBeNull()
  })

  it("opens on an account with no subscription yet, whose first allowance covers the flow", async () => {
    // The publish, the funding and two moves.
    setAllowance({ ...ready, state: { kind: "not-subscribed", maxTx: 4, renews: true } })
    await mount()
    await walkTo("intro")
    expect(proceed()?.disabled).toBe(false)
    await act(async () => root.unmount())
    container.remove()
    setAllowance({ ...ready, state: { kind: "not-subscribed", maxTx: 3, renews: true } })
    await mount()
    await walkTo("intro")
    expect(proceed()).toBeNull()
  })

  it("waits while the sign-up registration is still reaching the rollup", async () => {
    setAllowance({ ...ready, state: { kind: "not-subscribed", maxTx: 10, renews: true } })
    rail.set(answer({ pending: "message" }))
    await mount()
    await walkTo("intro")
    expect(proceed()).toBeNull()
    await act(async () => root.unmount())
    container.remove()
    rail.set({ status: "pending" })
    await mount()
    expect(start()?.disabled).toBe(true)
  })

  it("says the add cancels the open payment links, and counts their refunds against the allowance", async () => {
    h.facts = { ...FACTS, links: 2 }
    await mount()
    await walkTo("intro")
    expect(text()).toContain(fmt(introCopy.links.many, { count: 2 }))
    await act(async () => root.unmount())
    container.remove()
    // The publish, the funding, two refunds and two moves: one more than five uses.
    setAllowance({ ...ready, state: { kind: "available", available: 5 } })
    await mount()
    await walkTo("intro")
    expect(proceed()).toBeNull()
  })

  it("holds A1's button while a read is pending", async () => {
    setAllowance({ status: "loading" })
    await mount()
    expect(start()?.disabled).toBe(true)
    await act(async () => root.unmount())
    container.remove()
    setAllowance({ status: "unavailable", error: new Error("rpc") })
    await mount()
    await walkTo("intro")
    expect(proceed()).toBeNull()
  })

  it("an attempt abandoned by closing the modal while its record is being written saves nothing", async () => {
    await rotations.ready
    const apply = backend.apply
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let writes = 0
    backend.apply = async (ops) => {
      if (writes++ === 0) await held
      return apply(ops)
    }
    await mount()
    await walkTo("place")
    await act(async () => save()!.click())
    await flush(3)
    expect(writes).toBe(1)
    await act(async () => root.unmount())
    container.remove()
    release()
    await flush(3)
    expect(await rotations.get(OWNER)).toBeNull()
    expect(await loadRecords(rotations.view)).toEqual([])
    backend.apply = apply
    await mount()
    expect(start()?.disabled).toBe(false)
  })

  it("a closed prompt raises its sheet, whose Try again asks for the passkey again", async () => {
    let asked = 0
    h.deps = makeBackupAddDeps({
      store: rotations,
      driver: async () => {
        asked++
        throw new DOMException("Dismissed", "NotAllowedError")
      },
    }).deps
    await mount()
    await walkTo("place")
    await act(async () => save()!.click())
    await flush(3)
    expect(panel()).toBeNull()
    expect(save()).toBeNull()
    await act(async () => byTestId("backup-failed-retry")!.click())
    await flush(3)
    expect(asked).toBe(2)
    expect(h.addInputs).toMatchObject([{ choice: "phone" }, { choice: "phone" }])
    expect(await rotations.get(OWNER)).toBeNull()
  })

  it("shows a pending record even once the account lists two keys, with no new entry", async () => {
    listKeys(2)
    await rotations.put(createdRecord())
    await mount()
    await flush(2)
    expect(panel()).not.toBeNull()
    expect(start()).toBeNull()
    // The attempt's sheet stands alone, under no title or key list of the modal's.
    expect(rename()).toBeNull()
  })

  it("closes the sheet from a paid add's Close, and the add goes on", async () => {
    await rotations.put(signedRecord({ phase: "funded", ...sent(Date.now()) }))
    await mount()
    await flush(2)
    const close = container.querySelector<HTMLButtonElement>('[data-testid="backup-close"]')
    await act(async () => close!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect((await rotations.get(OWNER))?.phase).toBe("funded")
  })

  it("shows the pending panel when the account's keys cannot be read", async () => {
    h.readAuthKeysCounted.mockRejectedValue(new Error("rpc"))
    await rotations.put(createdRecord())
    await mount()
    await flush(2)
    // The pending attempt's screens stand in place of the key read's sheet.
    expect(text()).not.toContain(unreadableCopy.title.keys)
    expect(panel()).not.toBeNull()
    expect(start()).toBeNull()
    expect(approveButton()?.textContent).toBe(
      fmt(trackerCopy.approve, { approver: trackerCopy.yourPasskey }),
    )
  })

  it("shows the pending panel when the account does not verify", async () => {
    h.resolveOxideIdentity.mockResolvedValue({ kind: "unverified" })
    await rotations.put(createdRecord())
    await mount()
    await flush(2)
    expect(panel()).not.toBeNull()
    expect(start()).toBeNull()
  })

  it("blocks the add while a saved record does not read, and offers the reload", async () => {
    backend.entries.set(
      `acct/backupRotations/${OWNER.toLowerCase()}`,
      JSON.stringify({ owner: OWNER, phase: "typo" }),
    )
    rotations = testRotations(backend)
    openTestSession({ ...chain(), auth: fakeAuth(), backupRotations: rotations })
    h.deps = makeBackupAddDeps({ store: rotations }).deps
    await mount()
    await flush(2)
    expect(start()).toBeNull()
    expect(panel()).toBeNull()
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="backup-store-retry"]')
    expect(retry?.textContent).toBe(unreadableCopy.reload)
  })

  it("acts on no record while the account read is still out", async () => {
    let settle: (identity: unknown) => void = () => {}
    h.resolveOxideIdentity.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const other = `0x${"22".repeat(20)}`
    await rotations.put(signedRecord({ owner: other, phase: "funded", ...sent(1) }))
    await mount()
    await flush(3)
    expect(text()).toContain("Loading")
    expect(panel()).toBeNull()
    expect(h.depsBuilt).toBe(0)
    expect((await rotations.get(other))?.phase).toBe("funded")
    settle({ kind: "verified", identity: { account: OWNER, nameHash: "0x", generations: [] } })
    await flush(3)
    expect(panel()).toBeNull()
    expect(start()?.disabled).toBe(false)
    expect(h.depsBuilt).toBe(0)
    expect((await rotations.get(other))?.phase).toBe("funded")
  })

  it("treats an identity read that could not conclude as a failed read, with a retry", async () => {
    h.resolveOxideIdentity.mockResolvedValueOnce({ kind: "inconclusive" })
    await mount()
    await flush(2)
    expect(text()).toContain(unreadableCopy.title.keys)
    expect(container.querySelector('[data-testid="keys-retry"]')).toBeNull()
    expect(text()).not.toContain("not registered yet")
    expect(start()).toBeNull()
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="backup-keys-retry"]')
    await act(async () => retry!.click())
    await flush(3)
    expect(start()?.disabled).toBe(false)
  })

  it("offers a retry when the pending record's dependencies cannot be built", async () => {
    h.depsFailures = 1
    await rotations.put(createdRecord())
    await mount()
    await flush(2)
    expect(panel()).toBeNull()
    expect(text()).toContain(unreadableCopy.title.deps)
    expect(text()).toContain(unreadableCopy.lead.online)
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="backup-deps-retry"]')
    await act(async () => retry!.click())
    await flush(2)
    expect(panel()).not.toBeNull()
  })
})

describe("the Passkeys sheet's sign-out", () => {
  it("opens the logout prompt from B4 when only the first passkey can approve, and backs out", async () => {
    await rotations.put(createdRecord())
    const flow = makeFlowDeps({ store: rotations }).deps
    vi.mocked(flow.prepare).mockRejectedValueOnce(new RootPasskeyRequiredError())
    h.flowDeps = flow
    await mount(
      <MemoryRouter>
        <PasskeysSheet onClose={onClose} />
      </MemoryRouter>,
    )
    await flush()
    await act(async () => approveButton()!.click())
    await flush(3)
    const signOut = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="backup-first-passkey-sign-out"]')
    await act(async () => signOut()!.click())
    await flush()
    const prompt = () => document.querySelector('[aria-label="Log out"]')
    expect(prompt()).not.toBeNull()
    expect(panel()).toBeNull()
    // Cancel goes back to B4, and B4's Close back to the step it was raised over.
    const cancel = [...prompt()!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")
    await act(async () => cancel!.click())
    await flush()
    expect(prompt()).toBeNull()
    expect(signOut()).not.toBeNull()
    const close = [...container.querySelectorAll("button")].find((b) => b.textContent === "Close")
    await act(async () => close!.click())
    await flush()
    expect(approveButton()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe("the network's sheet raised over a step", () => {
  it("closes back to the step a missing route stopped", async () => {
    await rotations.put(createdRecord())
    const flow = makeFlowDeps({ store: rotations }).deps
    vi.mocked(flow.prepare).mockRejectedValueOnce(new RotationRouteNotLiveError("off"))
    h.flowDeps = flow
    await mount()
    await flush()
    await act(async () => approveButton()!.click())
    await flush(3)
    expect(approveButton()).toBeNull()
    const close = container.querySelector<HTMLButtonElement>(
      '[data-testid="backup-unavailable-close"]',
    )
    await act(async () => close!.click())
    await flush()
    expect(approveButton()).not.toBeNull()
  })
})
