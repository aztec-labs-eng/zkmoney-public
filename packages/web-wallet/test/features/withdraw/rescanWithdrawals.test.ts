import type { WithdrawalRecord } from "@obsidion/front-core"
import type { ObsidionWallet } from "@obsidion/sdk"
import { describe, expect, it, vi } from "vitest"
import {
  rescanWithdrawals,
  type RescanDeps,
  type RescanToken,
} from "../../../src/features/withdraw/withdrawGateway"

const WALLET = {} as ObsidionWallet
const OWNER = "0xowner"
const DEPS = {} as RescanDeps
const MAIN: RescanToken = { tokenService: {} as RescanToken["tokenService"] }
const SAVINGS: RescanToken = { ...MAIN, tuple: { l2Token: "0xsavings" } as RescanToken["tuple"] }
type TokenRescan = NonNullable<Parameters<typeof rescanWithdrawals>[1]>
const record = (id: string) => ({ localId: id } as WithdrawalRecord)

/** A scan that answers from `outcomes` in turn, per token, and counts its calls. */
function scanner(outcomes: Record<string, Array<"ok" | "fail" | "skip">>) {
  const calls: string[] = []
  const scan = vi.fn<TokenRescan>(async (_deps, _wallet, _owner, token, skip) => {
    const key = token.tuple?.l2Token ?? "main"
    calls.push(key)
    await Promise.resolve()
    const outcome = outcomes[key]?.shift() ?? "ok"
    if (outcome === "fail") throw new Error("rpc down")
    if (outcome === "skip") skip()
    return [record(`${key}-${calls.length}`)]
  })
  return { scan, calls }
}

describe("rescanWithdrawals", () => {
  it("scans each token once per session, and a token a later call names then", async () => {
    const { scan, calls } = scanner({})
    const rescan = rescanWithdrawals(DEPS, scan)

    const first = await rescan(WALLET, OWNER, [MAIN])
    const again = await rescan(WALLET, OWNER, [MAIN, SAVINGS])

    expect(calls).toEqual(["main", "0xsavings"])
    expect(again).toEqual([...first, record("0xsavings-2")])
  })

  it.each([
    ["failed", { main: ["fail" as const] }, MAIN],
    ["ran without every executor", {}, { ...MAIN, partial: true }],
  ])("scans a token again after its pass %s", async (_, outcomes, first) => {
    const { scan, calls } = scanner(outcomes)
    const rescan = rescanWithdrawals(DEPS, scan)

    // The first pass may fail or resolve; either way it leaves no pass behind.
    await Promise.allSettled([rescan(WALLET, OWNER, [first])])
    await rescan(WALLET, OWNER, [MAIN])
    await rescan(WALLET, OWNER, [MAIN])

    expect(calls).toEqual(["main", "main"])
  })

  it("resolves a pass that skipped a burn, and rejects it when strict; either scans again", async () => {
    const { scan, calls } = scanner({ main: ["skip", "skip"] })

    await expect(rescanWithdrawals(DEPS, scan)(WALLET, OWNER, [MAIN])).resolves.toHaveLength(1)
    const strict = rescanWithdrawals({ ...DEPS, strict: true }, scan)
    await expect(strict(WALLET, OWNER, [MAIN])).rejects.toMatchObject({ code: "scan.incomplete" })
    await strict(WALLET, OWNER, [MAIN])

    expect(calls).toEqual(["main", "main", "main"])
  })

  it("keeps each session's passes to itself", async () => {
    const { scan, calls } = scanner({})

    await rescanWithdrawals(DEPS, scan)(WALLET, OWNER, [MAIN])
    await rescanWithdrawals(DEPS, scan)(WALLET, OWNER, [MAIN])

    expect(calls).toEqual(["main", "main"])
  })
})
