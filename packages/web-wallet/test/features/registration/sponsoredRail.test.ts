// @vitest-environment node
/** The sponsored-rail check: asked while subscribed and pending, waiting out a message import. */
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createPace } from "@obsidion/core/cadence"
import { fixed, memoryStore, queries } from "@obsidion/front-core"
import type { ContractService, ObsidionAccount, ObsidionWallet } from "@obsidion/sdk"
import type { ClaimSponsorDeps } from "../../../src/features/registration/claimSponsorship"
import type { RegistrationPending } from "../../../src/features/registration/registrationRail"
import { sponsoredRail } from "../../../src/features/registration/registrationTasks"
import { sponsoredRailPending } from "../../../src/features/registration/sponsoredRailReadiness"

const MESSAGE: RegistrationPending = { pending: "message" }
const IMPORT: RegistrationPending = { pending: "import", messageHash: Fr.ONE }

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A rail whose reads answer `answers` in turn, then the last one again. */
function rail(answers: (RegistrationPending | false)[], read?: typeof sponsoredRailPending) {
  const pace = createPace({ signalled: true })
  const query = queries({ pace, visible: memoryStore(true).readonly, now: () => Date.now() })
  let imported = () => {}
  let reads = 0
  const entry = sponsoredRail(
    {
      wallet: fixed("wallet", { node: {} } as ObsidionWallet),
      contractService: fixed("contractService", {} as ContractService),
      account: fixed("account", {} as ObsidionAccount),
    },
    { page: { query } } as unknown as ClaimSponsorDeps["session"],
    {
      read:
        read ?? (async () => answers[Math.min(reads++, answers.length - 1)] as RegistrationPending),
      imported: () => new Promise<boolean>((resolve) => (imported = () => resolve(true))),
    },
  )
  return {
    reads: () => reads,
    pace,
    imported: () => imported(),
    entry,
    value: () => {
      const s = entry.get()
      return s.status === "ready" ? s.value : undefined
    },
  }
}

describe("sponsoredRail", () => {
  it("asks again on each poll while subscribed, and stops when the last subscriber leaves", async () => {
    const r = rail([MESSAGE])
    const off = r.entry.subscribe(() => {})
    await settle()
    r.pace.wake()
    await settle()
    expect([r.reads(), r.value()]).toEqual([2, MESSAGE])

    off()
    r.pace.wake()
    await settle()
    expect(r.reads()).toBe(2)
  })

  it("stops asking once the account can ride the rail", async () => {
    const r = rail([MESSAGE, false])
    const off = r.entry.subscribe(() => {})
    await settle()
    r.pace.wake()
    await settle()
    r.pace.wake()
    await settle()
    expect([r.reads(), r.value()]).toEqual([2, false])
    off()
  })

  it("keeps a read that cannot answer as read-error", async () => {
    const r = rail([], sponsoredRailPending)
    expect(await r.entry.read()).toEqual({ pending: "read-error" })
  })

  it("asks again once the message imports", async () => {
    const r = rail([IMPORT, MESSAGE])
    const read = r.entry.read()
    await settle()
    expect(r.reads()).toBe(1)
    r.imported()
    expect(await read).toEqual(MESSAGE)
    expect(r.reads()).toBe(2)
  })
})
