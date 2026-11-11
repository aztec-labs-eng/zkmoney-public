// @vitest-environment node
/**
 * The backup entry's open-paylink fact: a fresh device stores its links only once the rescan
 * rebuilds them from chain, so the fact waits for a complete pass and follows the rows after it.
 */
import { describe, expect, it } from "vitest"
import type { OperationRecord, PaylinkRecord, RecordSet } from "@obsidion/front-core"
import { selectBackupLinks } from "../../../src/features/backupPasskey/backupPasskeyFacts"

const ACCOUNT = `0x${"11".repeat(32)}`
const TOKEN = "0xtoken"
const NOW = 1_800_000_000

/** A link the account made on another device, as the rescan rebuilds it. */
const rebuilt = {
  id: "link",
  amountAtomic: 1n,
  flavor: "direct",
  timestamp: (NOW - 600) * 1000,
  txHash: `0x${"ab".repeat(32)}`,
  paylink: "https://wallet.example/link#frag",
  payToEmailSecret: `0x${"44".repeat(32)}`,
  fallbackSecret: `0x${"55".repeat(32)}`,
  obsidionAccountAddress: ACCOUNT,
  fromClaimable: 0,
  untilClaimable: NOW + 86_400,
  refundableUntil: NOW + 86_400,
} as PaylinkRecord

const NO_OPS = { records: [], loaded: true, failed: false }

const rows = (records: PaylinkRecord[], over: Partial<RecordSet<PaylinkRecord>> = {}) => ({
  records,
  loaded: true,
  failed: false,
  ...over,
})

const opts = (account = ACCOUNT) => ({ account, token: TOKEN, nowSec: NOW })
const count = (out: ReturnType<typeof selectBackupLinks>) =>
  typeof out === "object" ? out.open.length : out

describe("selectBackupLinks", () => {
  it.each([
    ["before any pass ends", undefined, rows([rebuilt]), undefined],
    ["while the rows load", true, rows([], { loaded: false }), undefined],
    ["after a pass that failed or deferred a link", false, rows([rebuilt]), "unreadable"],
    ["when the rows failed to load", true, rows([], { failed: true }), "unreadable"],
    ["after a complete pass, with the rebuilt link", true, rows([rebuilt]), 1],
    ["after a complete pass, with no link", true, rows([]), 0],
  ] as const)("%s", (_, rescanned, open, expected) => {
    expect(count(selectBackupLinks(rescanned, open, NO_OPS, opts()))).toBe(expected)
  })

  it("does not count another account's link", () => {
    const other = opts(`0x${"22".repeat(32)}`)
    expect(count(selectBackupLinks(true, rows([rebuilt]), NO_OPS, other))).toBe(0)
  })

  it("waits for the moved token before it reads the links", () => {
    const noToken = { ...opts(), token: undefined }
    expect(selectBackupLinks(true, rows([rebuilt]), NO_OPS, noToken)).toBe(undefined)
  })

  it("holds the add on a link whose create operation has not been sent", () => {
    const draft = { ...rebuilt, operationId: "create-1", txHash: undefined }
    const op = {
      operationId: "create-1",
      flow: "paylink-create",
      summary: "$1",
      state: "local",
      startedAt: 1,
    } as OperationRecord
    const ops = { records: [op], loaded: true, failed: false }
    expect(selectBackupLinks(true, rows([rebuilt, draft]), ops, opts())).toMatchObject({
      open: [rebuilt],
      hold: { kind: "creating" },
    })
  })

  it("holds the add on a link past its cancel window until it expires, then takes it back", () => {
    const closing = { ...rebuilt, refundableUntil: NOW + 10, untilClaimable: NOW + 60 }
    expect(selectBackupLinks(true, rows([closing]), NO_OPS, opts())).toEqual({
      open: [],
      claimed: [],
      hold: { kind: "expiry", until: NOW + 60 },
    })
    const later = { ...opts(), nowSec: NOW + 61 }
    expect(selectBackupLinks(true, rows([closing]), NO_OPS, later)).toEqual({
      open: [closing],
      claimed: [],
    })
  })
})
