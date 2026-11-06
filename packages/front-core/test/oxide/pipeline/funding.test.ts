// @vitest-environment node
/** The funding probe: what an unswept address holds, how it is priced, and where its exit is. */
import { describe, expect, it } from "vitest"
import { erc20Abi, getAddress, zeroAddress, type Abi, type Address } from "viem"
import { CAP, DAI, DAI_ROW, FEE, pipelineWorld, salt, USDC } from "./world"

const ONE = 10n ** 18n
const TARGET = "0x00000000000000000000000000000000000000ee" as Address
const feeReadDown = (w: Awaited<ReturnType<typeof pipelineWorld>>) => {
  w.l1.failing = (c) => c.fn === "rowFor"
}

describe("funding", () => {
  it("flips a funding outside the sweep window to recoverable at either end; in-window stays sweeping", async () => {
    const w = await pipelineWorld()
    const [a, b, c] = [await w.announced(1), await w.announced(2), await w.announced(3)]
    w.pay(a.address, FEE / 2n)
    w.pay(b.address, 5n * FEE)
    // Past the window's top: the credited amount is `balance − fee`.
    w.pay(c.address, CAP + FEE + 1n)

    const result = await w.scan()

    expect(result).toMatchObject({ discovered: 3, recoverable: 2 })
    expect(await w.get(b.address)).toMatchObject({ phase: "sweeping", fee: FEE.toString() })
    expect(await w.get(a.address)).toMatchObject({ phase: "recoverable" })
    expect(await w.get(c.address)).toMatchObject({ phase: "recoverable" })
  })

  it.each([0n, 1n, CAP + FEE + 1n])(
    "finds sweepable USDC despite an unsweepable DAI balance of %s",
    async (daiBalance) => {
      const w = await pipelineWorld()
      const sipa = await w.announced(1)
      if (daiBalance > 0n) w.pay(sipa.address, daiBalance)
      const funding = w.pay(sipa.address, 5_000_000n, USDC)

      const result = await w.scan()

      expect(result).toMatchObject({ discovered: 1, active: 1 })
      expect(await w.get(sipa.address)).toMatchObject({
        phase: "sweeping",
        amount: "5",
        tokenAddress: USDC,
        tokenSymbol: "USDC",
        tokenDecimals: 6,
        ...(daiBalance === 0n ? { fundingTxHash: funding } : {}),
      })
    },
  )

  it("reads a balance the batch missed on its own, and nothing the batch read", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, 5n * FEE)
    let once = true
    w.l1.reverts = (target, fn) => {
      const missed = once && fn === "balanceOf" && target === USDC.toLowerCase()
      if (missed) once = false
      return missed
    }

    await w.scan()

    expect(w.l1.count({ method: "eth_call", fn: "balanceOf", to: USDC.toLowerCase() })).toBe(1)
    expect(w.l1.count({ method: "eth_call", fn: "balanceOf", to: DAI.toLowerCase() })).toBe(0)
    expect(await w.get(sipa.address)).toMatchObject({ phase: "sweeping", tokenAddress: DAI })
  })

  it("isolates a record whose stored secret does not parse", async () => {
    const w = await pipelineWorld()
    const broken = await w.derive(salt(2))
    await w.saved(broken, { phase: "broadcast", messageSecret: "not-a-field" })
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)

    const { scanned, claimed } = await w.pass()

    expect(scanned.failed).toBe(1)
    expect(claimed.claimed).toBe(1)
  })

  it("targets the largest normalized balance for recovery when no token is sweepable", async () => {
    const w = await pipelineWorld()
    for (const t of [DAI, USDC]) w.l1.row(t, 1, { portal: DAI_ROW.portal, sweepTip: ONE })
    const sipa = await w.announced(1)
    w.pay(sipa.address, 10n ** 12n)
    w.pay(sipa.address, 500_000n, USDC)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "recoverable",
      amount: "0.5",
      tokenAddress: USDC,
      tokenSymbol: "USDC",
    })
  })

  it.each([true, false])(
    "preserves credited metadata after delayed attribution (settled: %s)",
    async (settled) => {
      const w = await pipelineWorld()
      const sipa = await w.announced(1)
      // The funding transfer's log is not indexed yet on the first pass.
      w.l1.setBalance(sipa.address, USDC, 5_000_000n)
      const { key } = w.l1.sweep({
        sipa: sipa.address,
        token: USDC,
        gross: 5_000_000n,
        credit: 4n * ONE,
        index: 7n,
        commitment: sipa.commitment,
        portal: DAI_ROW.portal,
        block: w.l1.head - 40n,
      })
      if (settled) w.l2.settle(key)
      await w.scan()
      await w.claim()
      const funding = w.l1.tx()
      w.l1.emit(
        USDC,
        erc20Abi as Abi,
        "Transfer",
        { from: TARGET, to: sipa.address, value: 5_000_000n },
        {
          tx: funding,
          block: w.l1.head - 50n,
        },
      )
      w.l1.head += 10n

      await w.scan()
      await w.claim()

      expect(await w.get(sipa.address)).toMatchObject({
        phase: settled ? "claimed" : "pendingClaim",
        amount: "4",
        tokenAddress: DAI,
        tokenSymbol: "DAI",
        tokenDecimals: 18,
        fundingTxHash: funding,
        fundingFromAddress: getAddress(TARGET),
        fundingTokenSymbol: "USDC",
      })
    },
  )

  it("names the token a sweep took from a re-used address, over its first funding's", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, {
      phase: "claimed",
      claimedInboxIndexes: ["7"],
      netAmount: "990000",
      amount: "0.99",
      fundingTxHash: `0x${"0f".repeat(32)}`,
      fundingFromAddress: TARGET,
      fundingTokenSymbol: "USDC",
      startTime: Date.now() - 86_400_000,
      endTime: 1,
    })
    w.pay(sipa.address, 4n * ONE)
    const resweep = w.sweep(sipa, 8n)
    await w.pass()
    expect(await w.get(sipa.address)).toMatchObject({
      phase: "claimed",
      claimedInboxIndexes: ["7", "8"],
      sweepTxHash: resweep.tx,
      tokenSymbol: "DAI",
      fundingTokenSymbol: "DAI",
    })

    // A batched tx that moved two accepted tokens out of the SIPA names neither.
    w.l1.head += 200n
    w.pay(sipa.address, ONE, DAI, w.l1.head - 50n)
    w.pay(sipa.address, 1_000_000n, USDC, w.l1.head - 50n)
    const batch = w.sweep(sipa, 9n, { block: w.l1.head - 40n })
    w.l1.emit(
      USDC,
      erc20Abi as Abi,
      "Transfer",
      { from: sipa.address, to: DAI_ROW.portal, value: 1_000_000n },
      {
        tx: batch.tx,
        block: w.l1.head - 40n,
      },
    )
    await w.pass()

    expect(await w.get(sipa.address)).toMatchObject({
      claimedInboxIndexes: ["7", "8", "9"],
      sweepTxHash: batch.tx,
      fundingTokenSymbol: "DAI",
    })
  })
})

describe("pricing", () => {
  const REGISTRATION_FEE = 14n * 10n ** 16n

  it("stamps the larger of the deposit fee and the seeded registration fee, reading the cap once", async () => {
    const w = await pipelineWorld()
    const [a, b] = [await w.derive(salt(1)), await w.derive(salt(2))]
    await w.saved(a, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: REGISTRATION_FEE.toString(),
    })
    await w.saved(b, { phase: "broadcast", intent: "registration", registrationFee: "0" })
    w.pay(a.address, 5n * FEE)
    w.pay(b.address, 5n * FEE)

    await w.scan()

    expect(await w.get(a.address)).toMatchObject({
      phase: "sweeping",
      fee: REGISTRATION_FEE.toString(),
    })
    expect(await w.get(b.address)).toMatchObject({ phase: "sweeping", fee: FEE.toString() })
    // One cap read for the window, one inside the one fee read.
    expect(w.l1.count({ fn: "TX_AMOUNT_CAP" })).toBe(2)
  })

  it.each([
    ["short of the schedule minimum", 2n * 10n ** 17n, "recoverable"],
    ["at the registration floor", 34n * 10n ** 16n, "sweeping"],
  ])("holds a registration deposit %s", async (_case, balance, phase) => {
    const w = await pipelineWorld()
    const a = await w.derive(salt(1))
    await w.saved(a, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: REGISTRATION_FEE.toString(),
    })
    w.pay(a.address, balance)

    // fee 0.14 + min 0.2 = 0.34: what `RegistrationController._checkPayment` takes.
    await w.scan({
      registrationScheduleFor: () => ({ min: 2n * 10n ** 17n, fee: REGISTRATION_FEE }),
    })

    expect(await w.get(a.address)).toMatchObject({ phase })
  })

  it("leaves a plain deposit's window at the fee", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, 5n * FEE)

    await w.scan({ registrationScheduleFor: () => ({ min: ONE, fee: ONE }) })

    expect(await w.get(sipa.address)).toMatchObject({ phase: "sweeping" })
  })

  it("records a funded SIPA's amount but holds its phase when the fee read fails", async () => {
    const w = await pipelineWorld()
    feeReadDown(w)
    const sipa = await w.announced(1)
    w.pay(sipa.address, 5n * 10n ** 14n)

    const result = await w.scan()

    expect(result).toMatchObject({ discovered: 1, failed: 0 })
    const record = (await w.get(sipa.address))!
    // An unread fee prices the window at zero, under which dust reads as sweepable.
    expect(record).toMatchObject({ phase: "broadcast", amount: "0.0005" })
    expect(record.fee).toBeUndefined()
  })

  it("holds a funded SIPA's phase when the cap read fails, and rereads the cap next run", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, 5n * FEE)
    w.l1.failing = (c) => c.fn === "TX_AMOUNT_CAP"

    await w.scan()
    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ phase: "broadcast", amount: "0.5" })
    expect(record.fee).toBeUndefined()

    w.l1.failing = () => false
    await w.scan()
    expect(await w.get(sipa.address)).toMatchObject({ phase: "sweeping", fee: FEE.toString() })
  })

  it("holds a registration SIPA's phase while its own schedule is not in hand", async () => {
    const w = await pipelineWorld()
    const a = await w.derive(salt(1))
    await w.saved(a, {
      phase: "recoverable",
      intent: "registration",
      registrationFee: REGISTRATION_FEE.toString(),
      startTime: 1,
    })
    w.pay(a.address, 5n * 10n ** 14n)

    await w.scan({ registrationScheduleFor: () => null })

    expect(await w.get(a.address)).toMatchObject({ phase: "recoverable", amount: "0.0005" })
  })

  it("recovers a registration SIPA no schedule can ever sweep", async () => {
    const w = await pipelineWorld()
    const a = await w.derive(salt(1))
    await w.saved(a, {
      phase: "broadcast",
      intent: "registration",
      registrationFee: REGISTRATION_FEE.toString(),
      startTime: 1,
    })
    w.pay(a.address, ONE)

    const result = await w.scan({ registrationScheduleFor: () => "unsweepable" })

    expect(result).toMatchObject({ recoverable: 1 })
    expect(await w.get(a.address)).toMatchObject({ phase: "recoverable", amount: "1" })
  })

  it("classifies a SIPA this wallet never registered on the fee alone", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    w.pay(sipa.address, 5n * FEE)

    await w.scan({ registrationScheduleFor: () => undefined })

    expect(await w.get(sipa.address)).toMatchObject({ phase: "sweeping" })
  })

  it("claims a swept deposit even when the fee read fails", async () => {
    const w = await pipelineWorld()
    feeReadDown(w)
    const sipa = await w.announced(1)
    w.pay(sipa.address, ONE)
    w.sweep(sipa, 7n)

    const { claimed } = await w.pass()

    expect(claimed).toMatchObject({ claimed: 1, failed: 0 })
    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ phase: "claimed", claimedInboxIndexes: ["7"] })
    expect(record.fee).toBeUndefined()
  })

  it("retries a rejected fee read for the next event in the same pass", async () => {
    const w = await pipelineWorld()
    const [a, b] = [await w.announced(1), await w.announced(2)]
    w.pay(a.address, 5n * FEE)
    w.pay(b.address, 5n * FEE)
    let failures = 1
    w.l1.failing = (c) => c.fn === "rowFor" && failures-- > 0

    await w.scan()

    expect(w.l1.count({ fn: "rowFor" })).toBe(2)
    const fees = [(await w.get(a.address))?.fee, (await w.get(b.address))?.fee]
    expect(fees.sort()).toEqual([FEE.toString(), undefined])
  })
})

describe("exits", () => {
  it("settles a recoverable SIPA emptied without a sweep as recovered", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "recoverable", startTime: 1, amount: "0.4" })

    await w.scan()

    // Which transaction emptied it is not knowable from here.
    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({ phase: "recovered" })
    expect(record.recoveryTxHash).toBeUndefined()
  })

  it("marks an unswept SIPA holding only ETH recoverable in ETH", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    // A token fee priced on an earlier pass must not price the ETH.
    await w.saved(sipa, { phase: "broadcast", startTime: 1, amount: "0", fee: "140" })
    w.l1.setBalance(sipa.address, zeroAddress, 10n ** 16n)

    expect(await w.scan()).toMatchObject({ recoverable: 1 })
    const record = (await w.get(sipa.address))!
    expect(record).toMatchObject({
      phase: "recoverable",
      amount: "0.01",
      tokenAddress: zeroAddress,
      tokenSymbol: "ETH",
      tokenDecimals: 18,
    })
    expect(record.fee).toBeUndefined()
  })

  it("never turns a claimed deposit holding leftover ETH into an ETH recovery", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    const claimed = {
      phase: "claimed" as const,
      startTime: 1,
      endTime: 2,
      amount: "14.75",
      netAmount: "14750000000000000000",
      fee: "250000000000000000",
      tokenSymbol: "DAI",
      sweepTxHash: `0x${"5e".repeat(32)}` as const,
      inboxIndex: "4",
      claimedInboxIndexes: ["4"],
    }
    await w.saved(sipa, claimed)
    w.l1.setBalance(sipa.address, zeroAddress, 10n ** 16n)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject(claimed)
  })

  it("settles a SIPA its recovery emptied as recovered, stamping its tx", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "sweeping", startTime: 1, amount: "15" })
    w.pay(sipa.address, 15n * ONE)
    const recovery = w.l1.transfer(DAI, sipa.address, TARGET, 15n * ONE, w.l1.head - 10n)

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({
      phase: "recovered",
      recoveryTxHash: recovery,
    })
  })

  it("leaves an empty SIPA alone unless it was recoverable and nothing was ever claimed off it", async () => {
    const w = await pipelineWorld()
    const [a, b] = [await w.announced(1), await w.announced(2)]
    // A `sweeping` zero balance is funds that never arrived, not funds pulled back out.
    await w.saved(a, { phase: "sweeping", startTime: 1 })
    // A claim off this SIPA explains the empty balance without any recovery.
    await w.saved(b, { phase: "recoverable", startTime: 1, claimedInboxIndexes: ["4"] })

    await w.scan()

    expect(await w.get(a.address)).toMatchObject({ phase: "sweeping" })
    expect(await w.get(b.address)).toMatchObject({ phase: "recoverable" })
  })

  it("does not clobber a recovery that landed while the pass read the chain", async () => {
    const w = await pipelineWorld()
    const sipa = await w.announced(1)
    await w.saved(sipa, { phase: "sweeping", startTime: 1 })
    const hash = `0x${"9a".repeat(32)}` as const
    w.l1.before = async (call) => {
      if (call.fn !== "aggregate3") return
      w.l1.before = () => {}
      await w.store.apply(sipa.address, {
        type: "recoverySent",
        txHash: hash,
        confirmed: true,
        token: { tokenAddress: DAI },
      })
    }

    await w.scan()

    expect(await w.get(sipa.address)).toMatchObject({ phase: "recovered", recoveryTxHash: hash })
  })
})
