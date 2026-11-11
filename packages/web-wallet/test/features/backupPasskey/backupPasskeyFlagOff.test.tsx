/** Guards: with the flag off, no add shows, a funded rotation drives on, a bad record reloads. */
import { createPace } from "@obsidion/core/cadence"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity } from "../../support/identity"

// Before any import evaluates the feature flags.
vi.hoisted(() => vi.stubEnv("VITE_BACKUP_PASSKEY_SETTINGS", "false"))

vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Icon: () => null,
  IconCircle: () => null,
  RowChevron: () => null,
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
  PrimaryGradientButton: ({
    title,
    onClick,
    testId,
  }: {
    title: string
    onClick?: () => void
    testId?: string
  }) => (
    <button onClick={onClick} data-testid={testId}>
      {title}
    </button>
  ),
  GlassCircleButton: ({
    ariaLabel,
    onClick,
    testId,
  }: {
    ariaLabel?: string
    onClick?: () => void
    testId?: string
  }) => <button aria-label={ariaLabel} onClick={onClick} data-testid={testId} />,
  StatusPill: ({ label }: { label: string }) => <span>{label}</span>,
  SettingsRow: ({ label, trailing }: { label: string; trailing?: React.ReactNode }) => (
    <div>
      <span data-label>{label}</span>
      {trailing}
    </div>
  ),
}))

const h = vi.hoisted(() => ({
  readAuthKeysCounted: vi.fn(),
  resolveOxideIdentity: vi.fn(),
  sessionKeys: vi.fn(),
  buildBackupAddDeps: vi.fn(),
  flowDeps: undefined as unknown,
  depsBuilt: 0,
  obsidionWallet: {},
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  createOxideL1Reader: () => ({ readAuthKeysCounted: h.readAuthKeysCounted }),
  resolveOxideIdentity: h.resolveOxideIdentity,
  deriveBootstrapKey: () => ({ address: `0x${"b0".repeat(20)}` }),
}))
vi.mock("../../../src/config/oxideTuple", () => ({ l1PublicClient: () => ({}) }))
vi.mock("../../../src/features/registration/oxideGenerations", () => ({
  loadOxideGenerations: async () => ({ kind: "generations" }),
}))
vi.mock("../../../src/features/registration/generationAddresses", () => ({
  generationAddresses: () => () => ({}),
}))
const fakeAuth = () => ({ sessionKeys: h.sessionKeys })
vi.mock("../../../src/features/backupPasskey/backupPasskeyRuntime", () => ({
  buildBackupAddDeps: h.buildBackupAddDeps,
  buildBackupFlowDeps: async () => {
    h.depsBuilt++
    return h.flowDeps
  },
}))

import { memoryBackend, RootPasskeyRequiredError, type BackupRotations } from "@obsidion/front-core"
import { getRotationDriver } from "../../../src/features/backupPasskey/rotationDrive"
import {
  OWNER,
  createdRecord,
  makeFlowDeps,
  receipt,
  sent,
  signedRecord,
  testRotations,
  word,
} from "../../support/backupAdd"
import { openTestSession } from "../../support/session"
const { PasskeysModal } = await import("../../../src/ui/PasskeysModal")

const ROOT_KEY = { qx: `0x${"10".repeat(32)}`, qy: `0x${"11".repeat(32)}` }
const FUNDED = () => signedRecord({ phase: "funded", ...sent(1) })

let root: Root
let container: HTMLDivElement
let flow: ReturnType<typeof makeFlowDeps>
let rotations: BackupRotations
const chain = () => ({ wallet: h.obsidionWallet, contractService: {} })

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function render(node: React.ReactNode) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(node))
  await flush(3)
}

const byTestId = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)
const text = () => container.textContent ?? ""
/** A saved attempt's step tracker. */
const panel = () => container.querySelector('[aria-current="step"]')
const entry = () => byTestId("backup-add")
/** The modal's own key list. */
const rename = () => byTestId("passkey-rename")

beforeEach(() => {
  rotations = testRotations()
  openTestSession({ ...chain(), auth: fakeAuth(), backupRotations: rotations })
  localStorage.clear()
  h.depsBuilt = 0
  h.resolveOxideIdentity.mockResolvedValue({
    kind: "verified",
    identity: { account: OWNER, nameHash: "0x", generations: [] },
  })
  h.readAuthKeysCounted.mockResolvedValue({
    entries: [{ key: ROOT_KEY, metadata: "0x" }],
    authKeyCount: 1,
  })
  h.sessionKeys.mockResolvedValue({
    secretKey: {},
    authProvider: {
      getPubkeys: async () => [
        Buffer.from(ROOT_KEY.qx.slice(2), "hex"),
        Buffer.from(ROOT_KEY.qy.slice(2), "hex"),
      ],
    },
  })
  flow = makeFlowDeps({ store: rotations })
  // The funding stays on its way, so the record stays funded while the panel watches it.
  flow.world.receipts.set(word(0x101), receipt(TxStatus.PENDING))
  h.flowDeps = flow.deps
})

afterEach(async () => {
  getRotationDriver().stop()
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

beforeEach(() => setIdentity({ address: `0x${"12".repeat(32)}`, handle: "brave-otter-42" }))

describe("the Passkeys modal with the backup flag off", () => {
  it("offers no add on a one-key account with no saved rotation", async () => {
    await render(<PasskeysModal onClose={() => {}} />)
    expect(text()).toContain("Keys on the account")
    expect(entry()).toBeNull()
    expect(panel()).toBeNull()
    expect(h.buildBackupAddDeps).not.toHaveBeenCalled()
    expect(h.depsBuilt).toBe(0)
  })

  it("shows a funded rotation and keeps driving it, with no new entry", async () => {
    await rotations.put(FUNDED())
    // The wallet's mount starts the session's driver whatever the flag; it does the driving.
    getRotationDriver().start({
      store: rotations,
      deps: async () => flow.deps,
      owns: () => true,
      pace: createPace(),
    })
    await render(<PasskeysModal onClose={() => {}} />)
    expect(panel()).not.toBeNull()
    expect(rename()).not.toBeNull()
    expect(entry()).toBeNull()
    expect(h.depsBuilt).toBe(1)
    expect(flow.deps.node.getTxReceipt).toHaveBeenCalledWith(word(0x101))
    expect((await rotations.get(OWNER))?.phase).toBe("funded")
  })

  it("keeps today's panel when only the first passkey can approve", async () => {
    await rotations.put(createdRecord())
    vi.mocked(flow.deps.prepare).mockRejectedValueOnce(new RootPasskeyRequiredError())
    await render(<PasskeysModal onClose={() => {}} />)
    await act(async () => byTestId("backup-approve")!.click())
    await flush(3)
    expect(panel()).not.toBeNull()
    expect(byTestId("backup-first-passkey-sign-out")).toBeNull()
  })

  it("offers the reload while a saved record does not read, and shows no rotation", async () => {
    const backend = memoryBackend()
    backend.entries.set(
      `acct/backupRotations/${OWNER.toLowerCase()}`,
      JSON.stringify({ ...FUNDED(), phase: "typo" }),
    )
    rotations = testRotations(backend)
    openTestSession({ ...chain(), auth: fakeAuth(), backupRotations: rotations })
    await render(<PasskeysModal onClose={() => {}} />)
    expect(panel()).toBeNull()
    expect(entry()).toBeNull()
    expect(rename()).not.toBeNull()
    expect(byTestId("backup-store-retry")).not.toBeNull()
  })
})
