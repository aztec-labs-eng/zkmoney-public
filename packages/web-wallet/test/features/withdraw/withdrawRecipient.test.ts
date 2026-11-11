/**
 * Which address the withdraw flow pays when a wallet connects or switches account, and which
 * recipient gets a wallet pill.
 */
import { describe, expect, it } from "vitest"
import { getAddress } from "viem"
import {
  addressName,
  asksName,
  connectedRecipient,
  walletPillName,
} from "../../../src/features/withdraw/WithdrawFlow/walletRecipient"

const [A, TYPED] = ["11", "33"].map((byte) => getAddress(`0x${byte.repeat(20)}`))

describe("connectedRecipient", () => {
  it("pays the connected account under the wallet's name", () => {
    expect(connectedRecipient(A.toLowerCase(), [], "Rainbow")).toEqual({
      recipient: A,
      name: "Rainbow",
    })
  })

  it("prefers the saved name over the wallet's", () => {
    const saved = [{ address: A.toLowerCase(), name: "Savings" }]
    expect(connectedRecipient(A, saved, "Rainbow").name).toBe("Savings")
  })
})

describe("walletPillName", () => {
  const wallet = {
    saved: false,
    savedName: undefined,
    connected: A,
    walletName: "Rainbow",
    etherfi: false,
    fallback: "Wallet",
  }

  it("never gives a typed address a pill", () => {
    expect(walletPillName(TYPED, wallet)).toBeUndefined()
  })

  it("names the connected account after its wallet, or the fallback", () => {
    expect(walletPillName(A, wallet)).toBe("Rainbow")
    expect(walletPillName(A, { ...wallet, walletName: null })).toBe("Wallet")
  })

  it("names a saved wallet by its saved name, over the connected wallet's", () => {
    expect(walletPillName(A, { ...wallet, saved: true, savedName: "Savings" })).toBe("Savings")
    expect(walletPillName(TYPED, { ...wallet, saved: true, savedName: "Ledger" })).toBe("Ledger")
  })

  it("names an unnamed saved wallet by the fallback, not the connected wallet's name", () => {
    expect(walletPillName(TYPED, { ...wallet, saved: true })).toBe("Wallet")
  })

  it("gives the ether.fi Cash contact no pill", () => {
    expect(
      walletPillName(A, { ...wallet, saved: true, savedName: "ether.fi Cash", etherfi: true }),
    ).toBe(undefined)
  })
})

describe("asksName", () => {
  it("asks only once a new address is in the field", () => {
    expect(asksName("", null, false)).toBe(false)
    expect(asksName("0x12", null, false)).toBe(false)
    expect(asksName(TYPED, TYPED, false)).toBe(true)
  })

  it("never asks to name a saved address", () => {
    expect(asksName(TYPED, TYPED, true)).toBe(false)
  })
})

describe("addressName", () => {
  it("names a new address by what was typed, trimmed", () => {
    expect(addressName(true, " Ledger ", undefined, undefined)).toBe("Ledger")
  })

  it("keeps a saved address's name over a name typed for another", () => {
    expect(addressName(false, "Ledger", "Rainbow", undefined)).toBe("Rainbow")
  })

  it("falls back to the ENS name, and to none", () => {
    expect(addressName(true, "", undefined, "vitalik.eth")).toBe("vitalik.eth")
    expect(addressName(false, "", undefined, undefined)).toBeUndefined()
  })
})
