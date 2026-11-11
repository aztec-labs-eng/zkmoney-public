import { describe, expect, it } from "vitest"
import { backupLinkHold, backupLinks } from "../../src/core/services/paylink/creatorLinkAction"
import type { PaylinkRecord } from "../../src/engine/paylinkTransition"
import type { TransactionStatus } from "../../src/types"

const TOKEN = "0xToken"

/** A link and its funding's status. */
type Link = PaylinkRecord & { status: TransactionStatus }
const statusOf = (link: Link) => link.status

/** A link made today: cancellable from creation until its expiry at 2000. */
const row = (overrides: Partial<Link> = {}): Link =>
  ({
    id: "0xid",
    timestamp: 0,
    amountAtomic: 1n,
    flavor: "direct",
    payToEmailSecret: "0xsecret",
    status: "success",
    txHash: "0xrow",
    paylink: "https://x/#frag",
    fallbackSecret: "0xtag",
    tokenAddress: "0xtoken",
    fromClaimable: 1000,
    untilClaimable: 2000,
    refundableUntil: 2000,
    ...overrides,
  } as Link)
const hold = (link: Link, nowSec: number) => backupLinkHold(link, link.status, nowSec, TOKEN)

describe("backupLinkHold", () => {
  it("holds nothing for a link the add can cancel now or reclaim after its expiry", () => {
    expect(hold(row(), 500)).toBeUndefined()
    expect(hold(row(), 1999)).toBeUndefined()
    expect(hold(row({ tokenAddress: undefined }), 500)).toBeUndefined()
  })

  it("holds the add on a create still in flight", () => {
    expect(hold(row({ status: "pending" }), 500)).toEqual({ kind: "creating" })
  })

  it("holds the add on a link in a retired deployment's token", () => {
    expect(hold(row({ tokenAddress: "0xold" }), 500)).toEqual({ kind: "token" })
  })

  it("asks for a cancel while a link's window, which closes before its expiry, is open, then holds until expiry", () => {
    const gap = row({ refundableUntil: 1500 })
    expect(hold(gap, 500)).toEqual({ kind: "cancel" })
    // Inside the cancel margin a cancel could no longer land.
    expect(hold(gap, 1480)).toEqual({ kind: "expiry", until: 2000 })
    expect(hold(gap, 2000)).toEqual({ kind: "expiry", until: 2000 })
    expect(hold(gap, 2001)).toBeUndefined()
    const none = row({ refundableUntil: undefined })
    expect(hold(none, 500)).toEqual({ kind: "expiry", until: 2000 })
  })
})

describe("backupLinks", () => {
  const ACCOUNT = "0xme"
  const opts = { account: ACCOUNT, network: "0xnet", token: TOKEN, nowSec: 500 }
  const mine = (overrides: Partial<Link> = {}) =>
    row({ obsidionAccountAddress: ACCOUNT, networkId: "0xnet", ...overrides })

  it("lists the account's open links on the network, leaving out spent, others' and other rollups'", () => {
    const open = mine({ txHash: "0xopen" })
    const rows = [
      open,
      mine({ isRefunded: true }),
      mine({ obsidionAccountAddress: "0xother" }),
      mine({ networkId: "0xold" }),
    ]
    expect(backupLinks(rows, statusOf, opts)).toEqual({ open: [open], claimed: [] })
  })

  it("lists apart the links a recipient's claim spent in the moved token, which a reorg can reopen", () => {
    const claimed = mine({ txHash: "0xclaimed", isClaimed: true })
    const rows = [
      claimed,
      // A self-claim drops the link from its row: nothing is left to take back.
      mine({ isClaimed: true, claimedBy: "self", paylink: undefined }),
      mine({ isClaimed: true, isRefunded: true }),
      mine({ isClaimed: true, tokenAddress: "0xold" }),
      mine({ isClaimed: true, obsidionAccountAddress: "0xother" }),
    ]
    expect(backupLinks(rows, statusOf, opts)).toEqual({ open: [], claimed: [claimed] })
  })

  it("names a create in flight first, then a retired token, then a link to cancel, then the latest expiry", () => {
    // Its cancel window closes within the cancel margin of now.
    const gap = (until: number) => mine({ refundableUntil: 520, untilClaimable: until })
    expect(backupLinks([gap(2000), gap(3000)], statusOf, opts).hold).toEqual({
      kind: "expiry",
      until: 3000,
    })
    const cancellable = mine({ refundableUntil: 1500 })
    expect(backupLinks([gap(3000), cancellable], statusOf, opts).hold).toEqual({ kind: "cancel" })
    expect(
      backupLinks([cancellable, mine({ tokenAddress: "0xold" })], statusOf, opts).hold,
    ).toEqual({
      kind: "token",
    })
    const all = [gap(2000), mine({ tokenAddress: "0xold" }), mine({ status: "pending" }), mine()]
    expect(backupLinks(all, statusOf, opts)).toEqual({
      open: [all[3]],
      claimed: [],
      hold: { kind: "creating" },
    })
  })
})
