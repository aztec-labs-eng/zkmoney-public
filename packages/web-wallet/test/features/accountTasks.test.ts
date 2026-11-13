// An account's one-shot tasks run once their needs are ready, once per session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createWithdrawals,
  fixed,
  memoryBackend,
  moveExitOffer,
  openDatabase,
  startRuntime,
  type Contacts,
  type MoveRecord,
} from "@obsidion/front-core"
import type { ObsidionAccount, ObsidionWallet, TokenService } from "@obsidion/sdk"
import { historicImports } from "../../src/features/migration/historicActivityImport"
import { namespaceOf } from "../../src/session/session"
import { testCore } from "../support/page"
import {
  rescanWithdrawals,
  withdrawalRescan,
  type RescanDeps,
  type RescanToken,
} from "../../src/features/withdraw/withdrawGateway"
import { burn, feedOf, HOUR, NOW } from "../../../front-core/test/engine/feedFixtures"
import { flush, later, onceSteps, sessions, table } from "../../../front-core/test/engine/taskTable"

const WALLET = { node: "node" } as unknown as ObsidionWallet
const ADDRESS = `0x${"0a".repeat(32)}`
const ACCOUNT = { getAddress: () => ({ toString: () => ADDRESS }) } as unknown as ObsidionAccount
const TOKEN = { symbol: "DAI" } as unknown as TokenService
const ends: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const end of ends.splice(0)) end()
  vi.useRealTimers()
})

/** Sessions whose milestones are all reached. */
function harness() {
  const h = sessions(startRuntime, { after: async () => true, reached: () => false })
  ends.push(h.end)
  return h
}

describe("the account's one-shot rescans and imports", () => {
  it("rescans Main's withdrawals once per session, once the token is ready", async () => {
    const h = harness()
    const token = later<TokenService>("token")
    const rescan = vi.fn(async () => [])
    h.tasks.push(
      withdrawalRescan(
        {
          wallet: fixed("wallet", WALLET),
          account: fixed("account", ACCOUNT),
          token: token.service,
        },
        rescan,
        async () => [],
      ),
    )
    await table(
      onceSteps(h, () => token.ready(TOKEN)),
      () => rescan.mock.calls.length,
    )
    expect(rescan).toHaveBeenLastCalledWith(WALLET, ADDRESS, [{ tokenService: TOKEN }])
  })

  it("rebuilds a move out's burn on a fresh device, so its release that never came offers the finalize", async () => {
    const h = harness()
    const withdrawals = createWithdrawals({ db: openDatabase(memoryBackend()), now: Date.now })
    const shares = { l2Token: `0x${"0b".repeat(32)}` } as NonNullable<RescanToken["tuple"]>
    const l2TxHash = `0x${"b1".repeat(32)}` as const
    // The chain's burns, by the token burned: the move out burned Savings' share token.
    const burned = burn({
      localId: "rebuilt",
      l2TxHash,
      phase: "finalizing_l1",
      startTime: NOW - 2 * HOUR,
      phaseEnteredAt: NOW - 2 * HOUR,
      endTime: undefined,
    })
    const scan: Parameters<typeof rescanWithdrawals>[1] = async (_deps, _wallet, _owner, token) => {
      if (token.tuple !== shares) return []
      return [(await withdrawals.adopt({ ...burned, networkId: "0xnet" })).record]
    }
    h.tasks.push(
      withdrawalRescan(
        {
          wallet: fixed("wallet", WALLET),
          account: fixed("account", ACCOUNT),
          token: fixed("token", TOKEN),
        },
        rescanWithdrawals({} as RescanDeps, scan),
        async () => [{ tokenService: TOKEN, tuple: shares }],
      ),
    )
    h.start()
    await flush()

    const replayed = {
      id: "m1",
      holdingId: "fea-sky",
      rail: "skyEscrow",
      direction: "out",
      amount: 90n,
      nonce: `0x${"01".repeat(32)}`,
      scanFrom: 7n,
      phase: "burned",
      startTime: NOW - 2 * HOUR,
      replayedFrom: l2TxHash,
    } as MoveRecord
    const { records } = await withdrawals.list.get()
    const [item] = feedOf({ moves: [replayed], withdrawals: [...records] }).items
    if (item?.kind !== "move") throw new Error("the feed shows no move")
    expect(moveExitOffer(item, { recoverable: true, runnable: true }, NOW)).toBe("finalize")
  })

  it("imports the account's retired activity and contacts once per session, once the wallet is ready", async () => {
    const h = harness()
    const wallet = later<ObsidionWallet>("wallet")
    const activity = vi.fn(async () => null)
    const contacts = vi.fn<(storageId: string, contacts: unknown) => Promise<number>>(async () => 0)
    const account = { storageId: "acct", contacts: {} as Contacts }
    const own = { ...testCore(), namespace: namespaceOf("acct") }
    h.tasks.push(...historicImports(wallet.service, account, own as never, { activity, contacts }))
    await table(
      onceSteps(h, () => wallet.ready(WALLET)),
      () => activity.mock.calls.length,
    )
    expect(contacts).toHaveBeenCalledTimes(2)
    expect(contacts).toHaveBeenLastCalledWith("acct", account.contacts)
    expect(activity).toHaveBeenLastCalledWith("acct")
  })
})
