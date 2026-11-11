/**
 * The fresh-address verdict: what the L1 reads and this wallet's own records say about a
 * destination, and which of them wins when several apply.
 */
import { describe, expect, it, vi } from "vitest"
import { getAddress, type Address } from "viem"
import type { Contact, WithdrawalRecord } from "@obsidion/front-core"
import {
  addressFacts,
  l1AddressActivities,
  verdictFromFacts,
  type AddressFacts,
  type FreshAddressVerdict,
} from "../../../src/features/withdraw/addressFacts"
import { testQuery } from "../../support/query"

const TARGET = getAddress(`0x${"dd".repeat(20)}`)
const LOWER = TARGET.toLowerCase() as Address
const OTHER = getAddress(`0x${"ee".repeat(20)}`)
const LOCKED = new Error("store locked")

const cl = (nonce = 0, balance = 0n, code = "0x") => ({
  getTransactionCount: vi.fn().mockResolvedValue(nonce),
  getBalance: vi.fn().mockResolvedValue(balance),
  getCode: vi.fn().mockResolvedValue(code),
})
const down = () => vi.fn().mockRejectedValue(new Error("rpc down"))
const allDown = () => ({ getTransactionCount: down(), getBalance: down(), getCode: down() })

const rec = (extra: Partial<WithdrawalRecord> = {}) =>
  ({ recipient: TARGET, phase: "done", ...extra } as WithdrawalRecord)

type ContactExtra = Partial<Pick<Contact, "address" | "addressKind">> & {
  deletedAt?: number
  lastUsedAt?: number
}
const contact =
  (provenance: "deposit-attested" | "saved-recipient") =>
  ({ address = TARGET, addressKind = "ethereum-l1", ...l1 }: ContactExtra = {}): Contact => ({
    name: "wallet",
    address,
    addressKind,
    l1Wallet: { provider: "manual", provenance, ...l1 },
  })
const att = contact("deposit-attested")
const sav = contact("saved-recipient")

type Client = ReturnType<typeof cl>
/** An Error in place of a list is a store that did not load. */
const rows = <T>(list: T[] | Error) =>
  list instanceof Error ? { records: [], read: false } : { records: list, read: true }
const deps = (
  client: Client = cl(),
  w: WithdrawalRecord[] | Error = [],
  c: Contact[] | Error = [],
) => ({ client, w, c })
const readFacts = async (address: Address, { client, w, c }: ReturnType<typeof deps>) => {
  const activity = await l1AddressActivities(testQuery(), () => client)(address).read()
  return addressFacts(address, activity, undefined, rows(w), rows(c))
}

const FRESH: AddressFacts = {
  code: false,
  nonce: 0,
  balance: 0n,
  local: null,
  withdrawals: 0,
  localRead: true,
}

describe("verdictFromFacts", () => {
  it.each<[string, FreshAddressVerdict, Partial<AddressFacts>]>([
    ["every read clean", "fresh", {}],
    ["code", "contract", { code: true }],
    [
      "code over a deposit link and history",
      "contract",
      {
        code: true,
        nonce: 3,
        balance: 5n,
        local: { kind: "linked-deposit" },
      },
    ],
    [
      "deposit link over history",
      "linked-deposit",
      { nonce: 3, local: { kind: "linked-deposit" } },
    ],
    [
      "prior withdrawal over history",
      "withdrew-before",
      {
        balance: 5n,
        local: { kind: "withdrew-before" },
      },
    ],
    ["nonce", "history", { nonce: 1 }],
    ["balance", "history", { balance: 1n }],
    ["history with the code read down", "history", { code: undefined, nonce: 2 }],
    [
      "a local record with every chain read down",
      "linked-deposit",
      {
        code: undefined,
        nonce: undefined,
        balance: undefined,
        local: { kind: "linked-deposit" },
      },
    ],
    ["code read down", "unknown", { code: undefined }],
    ["nonce read down", "unknown", { nonce: undefined }],
    ["balance read down", "unknown", { balance: undefined }],
    ["a local store down", "unknown", { localRead: false }],
  ])("%s -> %s", (_, verdict, facts) => {
    expect(verdictFromFacts({ ...FRESH, ...facts })).toBe(verdict)
  })
})

describe("addressFacts", () => {
  it.each<[string, FreshAddressVerdict, ReturnType<typeof deps>]>([
    ["balance", "history", deps(cl(0, 1n))],
    ["saved-recipient contact", "withdrew-before", deps(cl(), [], [sav()])],
    // precedence
    ["everything at once", "contract", deps(cl(3, 5n, "0x6000"), [rec()], [att(), sav()])],
    ["everything but code", "linked-deposit", deps(cl(3, 5n), [rec()], [att(), sav()])],
    ["saved contact, record and nonce", "withdrew-before", deps(cl(3, 5n), [rec()], [sav()])],
    // failed reads
    ["every read down, nothing local", "unknown", deps(allDown())],
    ["one read down, nothing local", "unknown", deps({ ...cl(), getBalance: down() })],
    ["every read down, attested contact", "linked-deposit", deps(allDown(), [], [att()])],
    ["getCode down, nonce 2", "history", deps({ ...cl(2), getCode: down() })],
    ["a store throws, nothing else", "unknown", deps(cl(), [], LOCKED)],
    ["records throw, attested contact", "linked-deposit", deps(cl(), LOCKED, [att()])],
    // local filters
    ["tombstoned contact", "fresh", deps(cl(), [], [att({ deletedAt: 10 })])],
    ["revived contact", "linked-deposit", deps(cl(), [], [att({ deletedAt: 10, lastUsedAt: 20 })])],
    ["removed after last use", "fresh", deps(cl(), [], [sav({ deletedAt: 30, lastUsedAt: 20 })])],
    ["aztec-l2 contact, same string", "fresh", deps(cl(), [], [sav({ addressKind: "aztec-l2" })])],
    ["failed record", "fresh", deps(cl(), [rec({ phase: "failed" })])],
    ["registration burn", "fresh", deps(cl(), [rec({ intent: "registration" })])],
    ["in-flight record", "withdrew-before", deps(cl(), [rec({ phase: "submitting" })])],
    [
      "another address",
      "fresh",
      deps(cl(), [rec({ recipient: OTHER })], [att({ address: OTHER })]),
    ],
    ["lowercase record", "withdrew-before", deps(cl(), [rec({ recipient: LOWER })])],
    ["lowercase contact", "linked-deposit", deps(cl(), [], [att({ address: LOWER })])],
  ])("%s -> %s", async (_, verdict, d) => {
    expect(verdictFromFacts(await readFacts(TARGET, d))).toBe(verdict)
  })

  it("counts the withdrawals sent to the address", async () => {
    const facts = await readFacts(
      TARGET,
      deps(cl(), [
        rec(),
        rec({ recipient: LOWER }),
        rec({ phase: "failed" }),
        rec({ recipient: OTHER }),
      ]),
    )
    expect(facts.withdrawals).toBe(2)
  })
})

describe("l1AddressActivities", () => {
  it("reads the address again on every read", async () => {
    const client = cl(0)
    const activity = l1AddressActivities(testQuery(), () => client)
    expect(await activity(TARGET).read()).toEqual({ code: false, nonce: 0, balance: 0n })
    client.getTransactionCount.mockResolvedValue(3)
    expect((await activity(TARGET).read()).nonce).toBe(3)
  })
})
