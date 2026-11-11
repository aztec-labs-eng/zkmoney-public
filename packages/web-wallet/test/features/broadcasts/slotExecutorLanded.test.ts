/** A deposit address's broadcast lands by its own recipient's events. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { broadcastJob, fixed, type SipaDepositFields } from "@obsidion/front-core"
import { slotExecutor } from "../../../src/features/broadcasts/slotExecutor"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import {
  closeSession,
  namespaceOf,
  openSession as buildSession,
} from "../../../src/session/session"
import { testPage } from "../../support/page"
import { openTestSession } from "../../support/session"
import { seedSipaDeposit } from "../../support/sipaDeposits"

const TUPLE = {
  portal: "0x00000000000000000000000000000000000000a0",
  forwardingTable: "0x00000000000000000000000000000000000000fb",
  accountFactory: "0x00000000000000000000000000000000000000af",
  l2Token: `0x${"01".repeat(32)}`,
  rollupVersion: "1",
} as OxideEnvTuple
const SESSION = `0x${"0e".repeat(32)}`
const PREVIOUS = `0x${"0d".repeat(32)}`
const SALT = `0x0${"5a".repeat(31)}a`
const sipa = (n: number) => `0x${(0xe00 + n).toString(16).padStart(40, "0")}` as Address

/** The wallet's PXE: `recipient` holds one SIPA event, published with `SALT`. */
const walletWithEventsOf = (recipient: string) => {
  const getPrivateEvents = vi.fn(async (_event: unknown, filter: { scopes: AztecAddress[] }) =>
    filter.scopes[0]!.toString() === recipient
      ? [
          {
            event: {
              shared_secret_salt: BigInt(SALT),
              resweepable: true,
              intent_hash_hi: 0n,
              intent_hash_lo: 0n,
            },
          },
        ]
      : [],
  )
  const wallet = { networkId: "0xnet", getPrivateEvents } as never
  return { wallet, getPrivateEvents }
}

/** A deposit record for `recipient`, its address published with `SALT`. */
const recordFor = (recipient?: string) =>
  ({
    ...(recipient ? { recipientL2Address: recipient } : {}),
    messageSecret: SALT,
    recipientHash: "0x02",
    recoveryAddress: "",
    l1ChainId: 31337,
    networkId: "0xnet",
    tokenAddress: TUPLE.portal,
    amount: "5",
    tokenSymbol: "DAI",
    startTime: 1,
  } as Omit<SipaDepositFields, "sipaAddress" | "phase">)

const primed = { tuple: TUPLE }
beforeEach(async () => {
  openTestSession({
    sipaKeys: { recipient: AztecAddress.fromStringUnsafe(SESSION) },
    sipaDiscovery: {},
    primed,
  })
})

afterEach(() => closeSession())

describe("a deposit address's broadcast", () => {
  it("lands by its record's recipient, read from the block a republish names", async () => {
    await seedSipaDeposit({ sipaAddress: sipa(3), phase: "sweeping", ...recordFor(PREVIOUS) })
    const { sipaDeposits } = openTestSession()
    await sipaDeposits.oweBroadcast(sipa(3), { kind: "deposit", source: { type: "slot" } })
    await sipaDeposits.apply(sipa(3), { type: "broadcastLanded" })
    await sipaDeposits.apply(sipa(3), {
      type: "broadcastRepublish",
      sinceBlock: 40,
      at: Date.now(),
    })
    const job = broadcastJob(sipaDeposits.view.get().records, sipa(3))!
    expect(job).toMatchObject({ state: "queued", republishSince: 40 })
    const { wallet, getPrivateEvents } = walletWithEventsOf(PREVIOUS)

    expect(
      await slotExecutor(wallet, openTestSession()).landed({ ...job, source: { type: "slot" } }),
    ).toBe(true)
    const [, filter] = getPrivateEvents.mock.calls[0]!
    expect(filter).toMatchObject({ contractAddress: AztecAddress.fromStringUnsafe(TUPLE.l2Token) })
    expect(String(filter.scopes[0])).toBe(PREVIOUS)
    expect(filter).toMatchObject({ fromBlock: 40 })
  })

  it("lands by the session's account for a record with no recipient", async () => {
    await seedSipaDeposit({ sipaAddress: sipa(4), phase: "sweeping", ...recordFor() })
    const { wallet, getPrivateEvents } = walletWithEventsOf(SESSION)

    expect(
      await slotExecutor(wallet, openTestSession()).landed({ address: sipa(4) } as never),
    ).toBe(true)
    expect(String(getPrivateEvents.mock.calls[0]![1].scopes[0])).toBe(SESSION)
  })

  it("reads the deposits of the session it was built with, not the current one", async () => {
    const other = buildSession(
      pageSessionDeps(testPage(undefined, undefined, primed))(namespaceOf("other")),
    )
    await other.sipaDeposits.adopt({ sipaAddress: sipa(5), phase: "sweeping", ...recordFor() })
    const session = Object.assign(Object.create(other), {
      sipaKeys: fixed("sipaKeys", { recipient: AztecAddress.fromStringUnsafe(SESSION) }),
      sipaDiscovery: () => fixed("sipaDiscovery", {}),
    })
    const { wallet } = walletWithEventsOf(SESSION)

    try {
      expect(await slotExecutor(wallet, session).landed({ address: sipa(5) } as never)).toBe(true)
      expect(await openTestSession().sipaDeposits.get(sipa(5))).toBeUndefined()
    } finally {
      other.close()
    }
  })
})
