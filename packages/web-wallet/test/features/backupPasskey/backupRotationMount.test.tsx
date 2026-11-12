/** Guards: the mount waits for the PXE, drives the account's rotation once, and no other's. */
import { StrictMode, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { TxStatus } from "@aztec-labs/stdlib/tx"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setIdentity } from "../../support/identity"
import { testPage } from "../../support/page"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"

const boot = vi.hoisted(() => ({
  status: "booting" as "booting" | "ready",
  identity: undefined as { address: string } | undefined,
  made: undefined as unknown as ReturnType<typeof import("../../support/backupAdd").makeFlowDeps>,
}))

vi.mock("../../../src/ui/PxeBoot", () => ({ usePxeBoot: () => ({ bootStatus: boot.status }) }))
vi.mock("../../../src/features/backupPasskey/backupPasskeyRuntime", () => ({
  buildBackupFlowDeps: vi.fn(async () => boot.made.deps),
}))

import { BackupRotationMount } from "../../../src/features/backupPasskey/BackupRotationMount"
import { buildBackupFlowDeps } from "../../../src/features/backupPasskey/backupPasskeyRuntime"
import { getRotationDriver } from "../../../src/features/backupPasskey/rotationDrive"
import {
  OWNER,
  SIPA,
  makeFlowDeps,
  receipt,
  sent,
  signedRecord,
  word,
} from "../../support/backupAdd"

/** The one-key account the test records' change was built over. */
const ONE_KEY = word(10)
const { closeSession } = await import("../../../src/session/session")
const { openTestSession } = await import("../../support/session")
beforeEach(() => openTestSession({ wallet: { tag: "wallet" } }).milestones.mark("firstBalance"))
afterEach(closeSession)

let root: Root
let container: HTMLDivElement

const flush = async (rounds = 1) => {
  for (let i = 0; i < rounds; i++) await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

async function untilPhase(phase: string, cap = 40) {
  for (let i = 0; i < cap; i++) {
    if ((await boot.made.store.get(OWNER))?.phase === phase) return
    await flush()
  }
}

async function render() {
  await act(async () => root.render(<BackupRotationMount />))
  await flush()
}

beforeEach(async () => {
  boot.status = "booting"
  await setIdentity({ address: ONE_KEY })
  boot.made = makeFlowDeps()
  openTestSession({ wallet: { tag: "wallet" }, backupRotations: boot.made.store })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  getRotationDriver().stop()
  vi.clearAllMocks()
})

describe("BackupRotationMount", () => {
  it("reads nothing before the PXE is up, then takes a funded rotation through the re-root", async () => {
    const { deps, store, world } = boot.made
    await store.put(signedRecord({ phase: "funded", ...sent() }))
    world.receipts.set(word(0x101), receipt(TxStatus.PENDING))
    await render()
    await flush(5)
    expect(deps.verify).not.toHaveBeenCalled()

    boot.status = "ready"
    await render()
    await flush(3)
    expect(buildBackupFlowDeps).toHaveBeenCalledWith({
      session: expect.objectContaining({ backupRotations: boot.made.store }),
      owner: OWNER,
      switchAccount: expect.any(Function),
    })
    expect(getRotationDriver().drive(OWNER)?.resume).toEqual({ wait: "sweep" })

    world.receipts.set(word(0x101), receipt(TxStatus.FINALIZED))
    world.sweep = { index: "1", blockNumber: 90, blockHash: word(0x90), credited: 1400n }
    world.rows.set("wdraw_backup_attempt-1", {
      phase: "done",
      l2TxHash: word(0x101),
      withdrawalId: word(0x77),
      startTime: 5,
      recipient: SIPA,
    })
    getRotationDriver().check(OWNER)
    await untilPhase("rerooted")
    expect(deps.reroot).toHaveBeenCalledTimes(1)
    await flush(5)
    expect(getRotationDriver().drive(OWNER)?.resume).toEqual({ wait: "approval", watch: true })
    expect(deps.move.send).not.toHaveBeenCalled()
    // Its re-root commits its two-key account, then hands it to the page's committed session.
    const reRooted = { tag: "two-key" } as never
    await writeDeviceKeys(testPage().database, { storageId: "two-key" })
    vi.mocked(buildBackupFlowDeps).mock.calls[0][0].switchAccount!(reRooted)
    const committed = openTestSession()
    expect(committed.namespace.id).toBe("two-key")
    expect(committed.account!.get()).toEqual({ status: "ready", value: reRooted })
  })

  it("publishes once under StrictMode, where the mount's effect runs twice", async () => {
    boot.status = "ready"
    await boot.made.store.put(signedRecord())
    await act(async () =>
      root.render(
        <StrictMode>
          <BackupRotationMount />
        </StrictMode>,
      ),
    )
    await untilPhase("published")
    await flush(3)
    expect(boot.made.deps.publish).toHaveBeenCalledTimes(1)
    expect(boot.made.deps.verify).toHaveBeenCalledTimes(2)
  })

  it("leaves a record of another account alone", async () => {
    boot.status = "ready"
    await setIdentity({ address: word(0x99) })
    await boot.made.store.put(signedRecord({ phase: "funded", ...sent() }))
    await render()
    await flush(5)
    expect(boot.made.deps.verify).not.toHaveBeenCalled()
    expect(getRotationDriver().getSnapshot().size).toBe(0)
  })
})
