import { describe, expect, it } from "vitest"
import { readWalletPresence, walletPresenceCookie } from "../src/bridge/walletPresence.js"

const jar = (assignment: string) => assignment.split(";")[0]!

describe("wallet presence cookie", () => {
  it("carries a bare flag to a host on the shared domain", () => {
    const cookie = walletPresenceCookie(true, "zk.money", true)
    expect(cookie).toContain("Domain=zk.money")
    expect(cookie).toContain("Secure")
    expect(jar(cookie)).toBe("__Secure-zkm_wallet=1")
    expect(readWalletPresence(`other=1; ${jar(cookie)}`, true)).toBe(true)
    expect(readWalletPresence(jar(walletPresenceCookie(true, "", false)), false)).toBe(true)
  })

  it("deletes, and reads nothing it did not write", () => {
    expect(walletPresenceCookie(false, "", true)).toContain("Max-Age=0")
    expect(readWalletPresence("__Secure-zkm_wallet=", true)).toBe(false)
    expect(readWalletPresence("__Secure-zkm_wallet=alice", true)).toBe(false)
    // A plain-http page's cookie never stands in for the https one.
    expect(readWalletPresence("zkm_wallet=1", true)).toBe(false)
  })
})
