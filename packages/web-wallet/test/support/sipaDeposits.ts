import {
  encodeRecord,
  loadRecords,
  selectSipaDeposit,
  sipaDepositId,
  type SipaDeposit,
  type SipaDepositFields,
  type SipaObservation,
} from "@obsidion/front-core"
import { openedSession } from "../../src/session/session"
import { openTestSession } from "./session"

/** The open session's deposit store; opens the namespace's session when none is. */
export const testSipaDeposits = () => (openedSession.get() ?? openTestSession()).sipaDeposits

/** Saves `fields` as the record at its address, or lays them over the record already there. */
export async function seedSipaDeposit(fields: SipaDepositFields): Promise<void> {
  const store = testSipaDeposits()
  if (await store.adopt(fields)) return
  const { sipaAddress, ...rest } = fields
  await patchSipaDeposit(sipaAddress, rest)
}

/** Lays `patch` over the record at `address`, as a pass that read it would. */
export async function patchSipaDeposit(
  address: string,
  patch: Partial<SipaDeposit>,
): Promise<SipaDeposit | undefined> {
  return testSipaDeposits().apply(address, { type: "observed", fields: patch as SipaObservation })
}

/**
 * Writes the record at `address` as `patch` laid over it, past every fence the transition keeps:
 * a fixture's state, not an event a writer sends. Resolves once the session's view holds it.
 */
export async function forceSipaDeposit(address: string, patch: Partial<SipaDeposit>) {
  const { db, sipaDeposits } = openedSession.get() ?? openTestSession()
  const held = await sipaDeposits.get(address)
  if (!held) throw new Error(`no deposit record at ${address}`)
  await db.write(async (w) =>
    w.put(`acct/sipaDeposits/${sipaDepositId(address)}`, encodeRecord({ ...held, ...patch })),
  )
  await loadRecords(sipaDeposits.view)
}

/** The session's loaded record at `address`, read as the views read it. */
export const viewedSipaDeposit = (address: string) =>
  selectSipaDeposit(testSipaDeposits().view.get(), address) ?? null

/** `sipa`'s record holds `amount`, in fee-token units; one is seeded when absent. */
export async function holdAtSipa(sipa: string, amount: bigint): Promise<void> {
  const seen = { observedFrom: "1", heldBalance: amount.toString() }
  if (await testSipaDeposits().get(sipa)) {
    await patchSipaDeposit(sipa, seen)
    return
  }
  await seedSipaDeposit({
    sipaAddress: sipa as SipaDeposit["sipaAddress"],
    phase: "resolved",
    networkId: "0xnet",
    amount: "0",
    startTime: Date.now(),
    ...seen,
  } as never)
}
