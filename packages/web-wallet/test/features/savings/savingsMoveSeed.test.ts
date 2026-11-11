/**
 * A move's row is on the feeds from the moment the user confirms: the move record rides the burn's
 * seed through `runBurn`, and follows the seed's fate when the burn never goes out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { testPage, testCore } from "../../support/page"
import { openTestSession } from "../../support/session"
import type { SavingsMoveRecord, SavingsMoves, WithdrawalRecord } from "@obsidion/front-core"

vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  // The burn in these runs is never sent: nothing to stamp, nothing to recover.
  trackWithdrawalSubmission: () => ({
    txHash: undefined,
    stamp: async () => {},
    recover: async () => null,
    stop: () => {},
  }),
}))
const fakeAuth = () => ({ getSecretKey: async () => undefined })

const { runBurn } = await import("../../../src/features/withdraw/withdrawGateway")
const { dropMoveWithSeed } = await import("../../../src/features/savings/savingsGateway")
const { savingsMoveStatus } = await import("../../../src/features/savings/SavingsMoveRow")
const { activeNamespace, closeSession, switchSession } = await import("../../../src/session/session")
const { pageSessionDeps } = await import("../../../src/app/sessionDeps")
type Session = import("../../../src/session/session").Session
beforeEach(
  () =>
    void switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage(fakeAuth()))),
)
afterEach(closeSession)
const withdrawals = () => openTestSession().withdrawals

const ESCROW = "0x00000000000000000000000000000000000000ee" as const
const seed = (): Omit<WithdrawalRecord, "localId" | "operationId"> => ({
  recipient: ESCROW,
  recipientProvenance: "saved-recipient",
  recipientAlias: "Main Account",
  amount: "25",
  rawAmount: (25n * 10n ** 18n).toString(),
  relayerTip: "1",
  tokenSymbol: "sUSDS",
  tokenDecimals: 18,
  phase: "submitting",
  startTime: 1_700_000_000_000,
  skyMove: {
    direction: "out",
    factory: "0x00000000000000000000000000000000000000f1",
    recipientCommitment: `0x${"01".repeat(32)}`,
    recoveryCommitment: `0x${"02".repeat(32)}`,
    relayerTip: "1",
    nonce: `0x${"03".repeat(32)}`,
  },
})
const moveOf = (record: WithdrawalRecord): SavingsMoveRecord => ({
  direction: "out",
  withdrawalLocalId: record.localId,
  escrow: ESCROW,
  nonce: record.skyMove!.nonce,
  recipientCommitment: record.skyMove!.recipientCommitment,
  amount: record.rawAmount!,
  startTime: record.startTime,
})

describe("a Savings move's row during its burn", () => {
  const op = { operationId: "op-1", leaveToChain: vi.fn() } as never
  const wallet = { networkId: "0xnet", node: {} } as never
  let moves: SavingsMoves
  let session: Session
  beforeEach(async () => {
    session = openTestSession({ wallet })
    moves = session.savingsMoves
    await moves.ready
  })
  afterEach(() => vi.restoreAllMocks())

  const burnWithMove = (burn: (record: WithdrawalRecord) => Promise<never>) => {
    let seeded: WithdrawalRecord | undefined
    return {
      run: runBurn({
        op,
        session,
        record: seed(),
        onSeeded: async (record) => {
          seeded = record
          await moves.put(moveOf(record))
        },
        burn,
      }).catch(async (err: unknown) => {
        await dropMoveWithSeed(moves, withdrawals(), seeded?.localId)
        throw err
      }),
      seeded: () => seeded,
    }
  }

  it("shows the move, moving, from the seed while the burn is still proving", async () => {
    let release!: (err: Error) => void
    const proving = new Promise<never>((_, reject) => (release = reject))
    const { run, seeded } = burnWithMove(() => proving)
    await vi.waitFor(() => expect(seeded()).toBeDefined())
    const move = await moves.get(seeded()!.localId)
    expect(move?.direction).toBe("out")
    expect(savingsMoveStatus(move!, (await withdrawals().get(seeded()!.localId))!)).toBe(
      "Moving to Main Account",
    )
    release(new Error("Cancelled"))
    await expect(run).rejects.toThrow("Cancelled")
  })

  it("leaves no row when the user cancels before anything is sent", async () => {
    const { run, seeded } = burnWithMove(async () => {
      throw new Error("Cancelled")
    })
    await expect(run).rejects.toThrow("Cancelled")
    expect(await withdrawals().get(seeded()!.localId)).toBeUndefined()
    expect(await moves.all()).toEqual([])
  })

  it("shows the move as failed, with the reason, when the burn fails after confirm", async () => {
    const { run, seeded } = burnWithMove(async () => {
      throw new Error("Proof generation failed")
    })
    await expect(run).rejects.toThrow("Proof generation failed")
    const burn = (await withdrawals().get(seeded()!.localId))!
    expect(burn.phase).toBe("failed")
    expect(burn.failure).toEqual({ code: "withdrawal.failed", detail: "Proof generation failed" })
    expect(savingsMoveStatus((await moves.get(seeded()!.localId))!, burn)).toBe("Failed")
  })
})
