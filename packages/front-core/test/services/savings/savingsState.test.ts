import { describe, expect, it } from "vitest"
import {
  selectSavingsHolding,
  selectSettleDue,
} from "../../../src/core/services/savings/savingsState"
import type { BalanceEntry } from "../../../src/engine/balances"
import type { WithdrawalRecord } from "../../../src/core/services/bridge/types"
import type { SavingsMoveRecord } from "../../../src/core/services/savings/types"

const ONE = 10n ** 18n
const BALANCE = { scope: "sandbox:0xcomplete", tokenAddress: "0xsav" }
const SOURCE = { balance: BALANCE }
const held = (atomic: bigint, readAt = 5) => ({
  records: [
    { scope: BALANCE.scope, token: BALANCE.tokenAddress, atomic, readAt, anchor: 9 },
  ] as BalanceEntry[],
  loaded: true,
  failed: false,
})
const NONE = { records: [], loaded: true, failed: false }

describe("selectSavingsHolding", () => {
  it("values the shares the sync stored at the price read, and names their token and block", () => {
    expect(
      selectSavingsHolding(SOURCE, held(3n * ONE), { sharePrice: 2n * ONE, readAt: 1 }),
    ).toEqual({
      position: {
        shares: 3n * ONE,
        value: 6n * ONE,
        sharePrice: 2n * ONE,
        readAt: 1,
        sharesReadAt: 5,
        sharesAnchor: 9,
        sharesToken: BALANCE.tokenAddress,
      },
      hydrated: true,
    })
  })

  it("waits for both the shares and the first price answer", () => {
    expect(selectSavingsHolding(SOURCE, NONE, { sharePrice: ONE, readAt: 1 }).hydrated).toBe(false)
    expect(selectSavingsHolding(SOURCE, held(ONE), undefined).hydrated).toBe(false)
    expect(selectSavingsHolding(null, held(ONE), { sharePrice: ONE, readAt: 1 }).hydrated).toBe(
      false,
    )
  })

  it("settles without a position once a first read failed", () => {
    expect(selectSavingsHolding(SOURCE, held(ONE), null)).toEqual({
      position: null,
      hydrated: true,
    })
  })
})

const move = (over: Partial<SavingsMoveRecord> = {}) =>
  ({
    direction: "in",
    withdrawalLocalId: "w1",
    amount: "1",
    startTime: 1,
    ...over,
  } as SavingsMoveRecord)
const burn = (over: Partial<WithdrawalRecord> = {}) =>
  ({ localId: "w1", phase: "l2_mined", ...over } as WithdrawalRecord)
const SKY = { skyMove: {} } as Partial<WithdrawalRecord>
const loaded = (...records: WithdrawalRecord[]) => ({ records, hydrated: true })

describe("selectSettleDue", () => {
  it("is due while the burns load: an unadopted one may be among them", () => {
    expect(selectSettleDue([], { records: [], hydrated: false }).due).toBe(true)
    expect(selectSettleDue([], loaded()).due).toBe(false)
  })

  it("counts the Sky burns no move records, but not a plain or failed one", () => {
    const burns = loaded(
      burn({ localId: "w2", ...SKY }),
      burn({ localId: "w3" }),
      burn({ localId: "w4", ...SKY, phase: "failed" }),
    )
    expect(selectSettleDue([], burns)).toEqual({ due: true, unadopted: 1 })
  })

  it("waits on a pending move, but not on one whose burn failed: it funded nothing", () => {
    expect(selectSettleDue([move()], loaded(burn())).due).toBe(true)
    expect(selectSettleDue([move()], loaded(burn({ phase: "failed" })))).toEqual({
      due: false,
      unadopted: 0,
    })
  })

  it("rests once every move is claimed with the vault's figures", () => {
    const claimed = move({
      deposit: { claimed: true } as SavingsMoveRecord["deposit"],
      vault: {} as SavingsMoveRecord["vault"],
    })
    expect(selectSettleDue([claimed], loaded(burn({ ...SKY }))).due).toBe(false)
  })
})
