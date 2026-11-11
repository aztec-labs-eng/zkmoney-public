/** Guards: sponsored spends wait out a backup passkey's switch and balance move. */
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { BackupRotationRecord, BackupRotations } from "@obsidion/front-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity } from "../../support/identity"
import { signedRecord, storedRotation, testRotations, TWO_KEY, word } from "../../support/backupAdd"

const ONE_KEY = word(10)
vi.mock("../../../src/features/registration/openRegistration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/features/registration/openRegistration")>()),
  useNameClaimPending: () => false,
  useRegistrationDepositOwed: () => false,
}))
vi.mock("../../../src/features/registration/sponsoredRailReadiness", () => ({
  useSponsoredRailPending: () => false,
}))
vi.mock("../../../src/features/contacts/ContactDetailScreen/ContactDetailScreen", () => ({
  ContactDetailScreen: () => <div>contact page</div>,
}))
const { showErrorModal } = vi.hoisted(() => ({ showErrorModal: vi.fn() }))
vi.mock("../../../src/errors/errorModal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/errors/errorModal")>()),
  showErrorModal,
}))

const { ActionGate, ContactRoute } = await import("../../../src/App")
const { useActionGuard } = await import("../../../src/features/actionGate")
const { useBalanceMovingPause } = await import(
  "../../../src/features/backupPasskey/balanceMovingPause"
)
const { setUpgradeStatus } = await import("../../../src/features/migration/migrationDialog")
const { checkUpgradeLock } = await import("../../../src/features/migration/upgradeLock")
type Action = Parameters<typeof ActionGate>[0]["action"]

const record = (over: Partial<BackupRotationRecord>) => signedRecord(over)
const moving = () => record({ phase: "rerooted", reroot: { switched: true } })

const { openTestSession } = await import("../../support/session")
const { defaultConfig } = await import("../../support/page")
const { closeSession } = await import("../../../src/session/session")
describe("sponsored spends during a backup passkey's balance move", () => {
  let host: HTMLDivElement
  let root: Root
  let rotations: BackupRotations

  beforeEach(async () => {
    // The wallet's mount reads each account's upgrade runs once a page; until then flows wait.
    await checkUpgradeLock(defaultConfig, TWO_KEY)
    await checkUpgradeLock(defaultConfig, ONE_KEY)
    localStorage.clear()
    rotations = testRotations()
    openTestSession({ backupRotations: rotations })
    await setIdentity({ address: TWO_KEY, handle: "taga" })
    setUpgradeStatus({ state: "none", registration: false })
    showErrorModal.mockReset()
    host = document.createElement("div")
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    closeSession()
    host.remove()
  })

  const save = (r: BackupRotationRecord) => act(() => rotations.put(r))
  const render = async (node: ReactNode) => {
    await act(async () => root.render(node))
  }
  const mount = (action: Action, path: string = action) =>
    render(
      <MemoryRouter key={path} initialEntries={[`/${path}`]}>
        <Routes>
          <Route path="/" element={<div>home screen</div>} />
          <Route element={<ActionGate action={action} />}>
            <Route path={path} element={<div>{path} screen</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  const paused = () => !!host.querySelector('[data-testid="balance-moving"]')

  it.each([["rerooted", {}]] as const)(
    "pauses withdraw and link creation while the record is %s",
    async (phase, over) => {
      await save(record({ phase, ...over }))
      for (const [action, path] of [
        ["withdraw", "withdraw"],
        ["link", "links/new"],
      ] as const) {
        await mount(action, path)
        expect(paused()).toBe(true)
        expect(host.textContent).toContain("Moving your balance")
        expect(host.textContent).toContain("once the move finishes")
        expect(host.textContent).not.toContain(`${path} screen`)
      }
    },
  )

  it("opens them once the move is done, without a reload", async () => {
    await save(moving())
    await mount("withdraw")
    expect(paused()).toBe(true)
    await save(record({ phase: "done", rotation: storedRotation({ signature: undefined }) }))
    expect(paused()).toBe(false)
    expect(host.textContent).toContain("withdraw screen")
  })

  it("pauses a send or a request payment from a contact's page", async () => {
    await save(moving())
    await render(
      <MemoryRouter initialEntries={["/contacts/bob/send"]}>
        <Routes>
          <Route path="contacts/:idOrTag" element={<ContactRoute />}>
            <Route path="send" element={<div>pay flow</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(paused()).toBe(true)
    expect(host.textContent).not.toContain("pay flow")
  })

  it("says why at the press and starts nothing", async () => {
    await save(moving())
    let guard!: ReturnType<typeof useActionGuard>
    function Probe() {
      guard = useActionGuard()
      return null
    }
    await render(<Probe />)
    const run = vi.fn()
    for (const action of ["send", "withdraw", "link", "savings", "claim"] as const) {
      act(() => guard(action, run))
    }
    expect(run).not.toHaveBeenCalled()
    expect(showErrorModal).toHaveBeenCalledTimes(5)
    expect(showErrorModal).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Moving your balance" }),
    )
    act(() => guard("deposit", run))
    expect(run).toHaveBeenCalledOnce()
  })

  it("holds a Savings move's press while the add has yet to switch, and says why", async () => {
    // A move started now would land for the one-key account after the switch, unclaimed.
    await save(record({ phase: "funded" }))
    await setIdentity({ address: ONE_KEY, handle: "taga" })
    let guard!: ReturnType<typeof useActionGuard>
    function Probe() {
      guard = useActionGuard()
      return null
    }
    await render(<Probe />)
    const run = vi.fn()
    act(() => guard("savings", run))
    expect(run).not.toHaveBeenCalled()
    expect(showErrorModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Finish adding your backup passkey" }),
    )
    await save(record({ phase: "rerooted", reroot: { switched: true } }))
    await setIdentity({ address: TWO_KEY, handle: "taga" })
    await save(record({ phase: "done" }))
    act(() => guard("savings", run))
    expect(run).toHaveBeenCalledOnce()
  })

  it("holds a payment link refund's press until the move is done", async () => {
    await save(moving())
    let pause!: ReturnType<typeof useBalanceMovingPause>
    function Probe() {
      pause = useBalanceMovingPause()
      return null
    }
    await render(<Probe />)
    const run = vi.fn()
    act(() => pause(run))
    expect(run).not.toHaveBeenCalled()
    expect(showErrorModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Moving your balance" }),
    )
    await save(record({ phase: "done" }))
    act(() => pause(run))
    expect(run).toHaveBeenCalledOnce()
  })
})
