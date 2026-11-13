// The cases every `MovesAccount` implementation passes.
import { getAddress, isAddressEqual, type Hex } from "viem"
import { expect, it } from "vitest"
import type { MoveQuote } from "../../../src/engine/moveTransition"
import type {
  DepositClaim,
  MoveRoute,
  MoveRoutes,
  MovesAccount,
  RouteHolding,
} from "../../../src/core/services/moves/types"
import { NONCE, OTHER_NONCE, type MoveL1 } from "./moveRoutesContract"

export interface MovesAccountSubject<
  L1 extends MoveL1,
  H extends RouteHolding,
  R extends MoveRoute,
  Q extends MoveQuote,
> {
  l1: () => L1 | Promise<L1>
  routes: (l1: L1) => MoveRoutes<H, R, Q>
  /** An account holding at least twice `amount` on the holding's base bridge. */
  account: (l1: L1) => MovesAccount | Promise<MovesAccount>
  holding: H
  amount: bigint
  /** A deposit to `account` on the holding's held bridge that it has not claimed. */
  claimable: (l1: L1, account: MovesAccount) => Promise<DepositClaim & { messageKey: Hex }>
  /** Keeps a deposit's L1→L2 message off L2; the returned call lands it. */
  withhold: (l1: L1, messageKey: Hex) => Promise<() => Promise<void>>
  /** Withholds a burn's tx effect from the node; the returned call indexes it. */
  unindex: (l1: L1, txHash: string) => Promise<() => Promise<void>>
  /** The time, in ms, the harness's L2 stamped a burn's block with. */
  burnedAt: (l1: L1, txHash: string) => Promise<number>
  /** Keeps a burn's epoch unproven on L1; the returned call proves it. */
  unprove: (l1: L1, txHash: string) => Promise<() => Promise<void>>
}

const TIP_RECIPIENT = getAddress(`0x${"7e".repeat(20)}`)

const ofTx = <B extends { txHash: string }>(burns: readonly B[], txHash: string) =>
  burns.filter((burn) => burn.txHash === txHash)

export function movesAccountContract<
  L1 extends MoveL1,
  H extends RouteHolding,
  R extends MoveRoute,
  Q extends MoveQuote,
>(subject: MovesAccountSubject<L1, H, R, Q>): void {
  const { holding, amount } = subject
  const otherRail = holding.rail === "skyEscrow" ? "executor" : "skyEscrow"
  const open = async () => {
    const l1 = await subject.l1()
    const routes = subject.routes(l1)
    return { l1, routes, account: await subject.account(l1), route: await routes.read(holding) }
  }
  const requestIn = async (
    { routes, account, route }: Awaited<ReturnType<typeof open>>,
    nonce = NONCE,
  ) => {
    const salts = account.salts(nonce, holding.rail)
    const recipientCommitment = await routes.commitment(salts.recipient, account.address)
    const quote = await routes.quote(route, "in", amount)
    const built = routes.build(
      route,
      {
        direction: "in",
        amount,
        from: account.address,
        nonce,
        recipientCommitment,
        recovery: { salt: salts.recovery, account: account.recoveryAccount },
      },
      quote,
    )
    const request = {
      ...built,
      direction: "in" as const,
      operationId: `op-${nonce}`,
      withdrawalLocalId: `wdraw-${nonce}`,
      holdingId: holding.id,
      nonce,
      source: holding.base,
      amount,
    }
    return { built, recipientCommitment, request }
  }
  const burnIn = async (opened: Awaited<ReturnType<typeof open>>, signal?: AbortSignal) => {
    const { request, ...made } = await requestIn(opened)
    return { ...made, result: await opened.account.burn(request, signal) }
  }

  it("derives the same salts for a nonce, and others for another nonce or rail", async () => {
    const { account } = await open()
    const salts = account.salts(NONCE, holding.rail)
    expect(account.salts(NONCE, holding.rail)).toEqual(salts)
    expect(salts.recipient.equals(salts.recovery)).toBe(false)
    for (const other of [
      account.salts(OTHER_NONCE, holding.rail),
      account.salts(NONCE, otherRail),
    ]) {
      expect(other.recipient.equals(salts.recipient)).toBe(false)
      expect(other.recovery.equals(salts.recovery)).toBe(false)
    }
  })

  it("burns the amount from its source", async () => {
    const opened = await open()
    const before = await opened.account.balance(holding.base)
    await burnIn(opened)
    expect(await opened.account.balance(holding.base)).toBe(before - amount)
  })

  it("burns nothing under a signal already aborted", async () => {
    const opened = await open()
    const before = await opened.account.balance(holding.base)
    await expect(burnIn(opened, AbortSignal.abort())).rejects.toThrow()
    expect(await opened.account.balance(holding.base)).toBe(before)
  })

  it("gives two burns in flight at once their own hash and withdrawal id", async () => {
    const opened = await open()
    const requests = [await requestIn(opened), await requestIn(opened, OTHER_NONCE)]
    const burning = requests.map(({ request }) => opened.account.burn(request))
    const hashes = (await Promise.all(burning)).map((result) => result.txHash)
    expect(new Set(hashes).size).toBe(2)
    const { burns } = await opened.account.moveBurns(holding.base, holding.rail)
    const ids = hashes.map((hash) => ofTx(burns, hash).map((burn) => burn.withdrawalId))
    expect(ids.map((of) => of.length)).toEqual([1, 1])
    expect(new Set(ids.flat()).size).toBe(2)
  })

  it("reads back a burn it sent as its rail's, from that bridge, owned by its route", async () => {
    const opened = await open()
    const { account, routes, route } = opened
    const { built, recipientCommitment, result } = await burnIn(opened)
    const mine = <B extends { txHash: string }>(burns: readonly B[]) => ofTx(burns, result.txHash)
    const [burn, ...more] = mine((await account.moveBurns(holding.base, holding.rail)).burns)
    if (!burn) throw new Error("the burn is not read back")
    expect(more).toEqual([])
    expect(burn).toMatchObject({ amount, nonce: NONCE, recipientCommitment, rail: built.rail })
    expect(burn.withdrawalId).toMatch(/^0x[0-9a-f]{64}$/)
    expect(burn.timestampMs).toBe(await subject.burnedAt(opened.l1, result.txHash))
    if (burn.rail === "skyEscrow")
      expect(isAddressEqual(burn.escrow.address, built.target)).toBe(true)
    expect(routes.owns(route, burn)).toBe(true)
    expect(mine((await account.moveBurns(holding.held, holding.rail)).burns)).toEqual([])
    expect(mine((await account.moveBurns(holding.base, otherRail)).burns)).toEqual([])
  })

  it("omits a burn the node has not indexed and says so, and reads it once it is", async () => {
    const opened = await open()
    const { l1, account } = opened
    const { result } = await burnIn(opened)
    const index = await subject.unindex(l1, result.txHash)
    const read = async () => {
      const { burns, unread } = await account.moveBurns(holding.base, holding.rail)
      return { burns: ofTx(burns, result.txHash), unread }
    }
    expect(await read()).toEqual({ burns: [], unread: true })
    await index()
    const { burns, unread } = await read()
    expect(burns.map((burn) => burn.txHash)).toEqual([result.txHash])
    expect(unread).toBe(false)
  })

  it("gives a burn's release arguments once its epoch is proven, and refuses them before", async () => {
    const opened = await open()
    const { built, result } = await burnIn(opened)
    const [burn] = ofTx(
      (await opened.account.moveBurns(holding.base, holding.rail)).burns,
      result.txHash,
    )
    if (!burn) throw new Error("the burn is not read back")
    // A Sky burn pays the executor its escrow options name; a vault move's pays its target.
    const executor = built.withdrawal.escrow?.executor ?? built.target
    const of = { txHash: result.txHash, source: holding.base, executor }
    const prove = await subject.unprove(opened.l1, result.txHash)
    await expect(opened.account.releaseArgs(of, TIP_RECIPIENT)).rejects.toMatchObject({
      code: "move.noRecovery",
    })
    await prove()
    const args = await opened.account.releaseArgs(of, TIP_RECIPIENT)
    expect(args.withdrawalId).toBe(burn.withdrawalId)
    expect(args.content.amount).toBe(amount)
    expect(isAddressEqual(args.relayerPayload, TIP_RECIPIENT)).toBe(true)
  })

  it("rejects a claim whose signal has aborted, and credits nothing", async () => {
    const { l1, account } = await open()
    const deposit = await subject.claimable(l1, account)
    const before = await account.balance(holding.held)
    await expect(account.claim(holding.held, deposit, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(await account.balance(holding.held)).toBe(before)
  })

  it("credits a deposit's claim once, however often it is claimed", async () => {
    const { l1, account } = await open()
    const deposit = await subject.claimable(l1, account)
    const before = await account.balance(holding.held)
    const { signal } = new AbortController()
    await account.claim(holding.held, deposit, signal)
    await account.claim(holding.held, deposit, signal)
    expect(await account.balance(holding.held)).toBe(before + deposit.amount)
  })

  it("reads a deposit's message as off L2, where no claim lands, until it is on it", async () => {
    const { l1, account } = await open()
    const deposit = await subject.claimable(l1, account)
    const land = await subject.withhold(l1, deposit.messageKey)
    const before = await account.balance(holding.held)
    const { signal } = new AbortController()
    expect(await account.messageReady(deposit.messageKey)).toBe(false)
    await expect(account.claim(holding.held, deposit, signal)).rejects.toThrow()
    expect(await account.balance(holding.held)).toBe(before)
    await land()
    expect(await account.messageReady(deposit.messageKey)).toBe(true)
    await account.claim(holding.held, deposit, signal)
    expect(await account.balance(holding.held)).toBe(before + deposit.amount)
  })
}
