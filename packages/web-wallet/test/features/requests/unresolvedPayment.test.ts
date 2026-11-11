import { beforeEach, describe, expect, it } from "vitest"
import { memoryBackend, openDatabase } from "@obsidion/front-core"
import {
  clearPayment,
  holdPayment,
  paymentHeld,
} from "../../../src/features/requests/unresolvedPayment"
import { DEVICE_KEYS, deviceState } from "../../../src/platform/storage/deviceKeys"

const A = "0x00000000000000000000000000000000000000aA"
const B = "0x00000000000000000000000000000000000000bB"

/** A page over `entries`; `durable` says whether its database outlives the page. */
async function page(entries = new Map<string, string>(), durable = true) {
  const db = openDatabase(memoryBackend(entries))
  const device = deviceState(db, () => durable)
  await device.load()
  return { db, device, entries }
}

describe("unresolved request payments", () => {
  beforeEach(() => localStorage.clear())

  it("holds a payee's address in the page's device state until the payer clears it", async () => {
    const { db, device } = await page()
    await holdPayment(db, "mainnet", A, "s1")
    expect(paymentHeld(device.get(), "mainnet", A.toLowerCase() as typeof A)).toBe(true)
    expect(paymentHeld(device.get(), "mainnet", B)).toBe(false)
    expect(paymentHeld(device.get(), "testnet", A)).toBe(false)
    await clearPayment(db, "mainnet", A)
    expect(paymentHeld(device.get(), "mainnet", A)).toBe(false)
  })

  it("lets a refused approval drop only its own hold", async () => {
    const { db, device } = await page()
    await holdPayment(db, "mainnet", A, "s1")
    await clearPayment(db, "mainnet", A, "s2")
    expect(paymentHeld(device.get(), "mainnet", A)).toBe(true)
    await clearPayment(db, "mainnet", A, "s1")
    expect(paymentHeld(device.get(), "mainnet", A)).toBe(false)
  })

  it("refuses another send's hold until the payer clears it, and keeps the first", async () => {
    const { db, device } = await page()
    await holdPayment(db, "mainnet", A, "s1")
    await holdPayment(db, "mainnet", A, "s1")
    await expect(holdPayment(db, "mainnet", A, "s2")).rejects.toMatchObject({
      code: "deposit.sendHeld",
    })
    await clearPayment(db, "mainnet", A, "s2")
    expect(paymentHeld(device.get(), "mainnet", A)).toBe(true)
  })

  it("carries a hold an older build kept in localStorage into the database once", async () => {
    const older = JSON.stringify({ [`mainnet:${A.toLowerCase()}`]: { at: 1, submission: "s1" } })
    localStorage.setItem(DEVICE_KEYS.unresolvedPayments, older)
    const { device, entries } = await page()
    expect(paymentHeld(device.get(), "mainnet", A)).toBe(true)
    expect(entries.get(DEVICE_KEYS.unresolvedPayments)).toBe(older)
    expect(localStorage.getItem(DEVICE_KEYS.unresolvedPayments)).toBeNull()
  })

  it("keeps an older build's hold in localStorage while the database lasts only for the page", async () => {
    const older = JSON.stringify({ [`mainnet:${A.toLowerCase()}`]: { at: 1, submission: "s1" } })
    localStorage.setItem(DEVICE_KEYS.unresolvedPayments, older)
    const { device } = await page(new Map(), false)
    expect(paymentHeld(device.get(), "mainnet", A)).toBe(true)
    expect(localStorage.getItem(DEVICE_KEYS.unresolvedPayments)).toBe(older)
  })

  it("adds older builds' holds to ones this database already keeps", async () => {
    const B_KEY = `mainnet:${B.toLowerCase()}`
    const saved = JSON.stringify({ [B_KEY]: { at: 2, submission: "s2" } })
    const older = JSON.stringify({ [`mainnet:${A.toLowerCase()}`]: { at: 1, submission: "s1" } })
    localStorage.setItem(DEVICE_KEYS.unresolvedPayments, older)
    const { device } = await page(new Map([[DEVICE_KEYS.unresolvedPayments, saved]]))
    expect(paymentHeld(device.get(), "mainnet", A)).toBe(true)
    expect(paymentHeld(device.get(), "mainnet", B)).toBe(true)
    expect(localStorage.getItem(DEVICE_KEYS.unresolvedPayments)).toBeNull()
  })

  it("refuses the approval when the saved holds cannot be read", async () => {
    const { db } = await page(new Map([[DEVICE_KEYS.unresolvedPayments, "{"]]))
    await expect(holdPayment(db, "mainnet", A, "s1")).rejects.toMatchObject({
      code: "deposit.holdUnsaved",
    })
  })
})
