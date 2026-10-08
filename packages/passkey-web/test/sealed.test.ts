import { describe, expect, it } from "vitest"
import {
  handoffCookie,
  openHandoff,
  readHandoffCookie,
  sealHandoff,
  sharedCookieDomain,
} from "../src/bridge/sealed.js"

describe("sealed hand-off", () => {
  it("opens only with its own key and untampered ciphertext", async () => {
    const message = { v: 1, candidates: { first: `0x${"11".repeat(32)}` } }
    const { key, sealed } = await sealHandoff(message)
    expect(await openHandoff(key, sealed)).toEqual(message)
    expect(await openHandoff((await sealHandoff(message)).key, sealed)).toBeNull()
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA")
    expect(await openHandoff(key, flipped)).toBeNull()
    expect(await openHandoff("short", sealed)).toBeNull()
  })

  it("names the domain both hosts share", () => {
    expect(sharedCookieDomain("launch.zk.money", "wallet.zk.money")).toBe("zk.money")
    expect(sharedCookieDomain("pr-7.launch.staging.zk.money", "wallet-pr-7.staging.zk.money")).toBe(
      "staging.zk.money",
    )
    expect(sharedCookieDomain("localhost", "localhost")).toBe("")
    expect(sharedCookieDomain("a.example.com", "b.other.com")).toBeNull()
  })

  it("writes and reads each hand-off's own key cookie", () => {
    const id = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
    const other = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
    expect(handoffCookie("k", "zk.money", true, id)).toBe(
      `__Secure-zkm_handoff_${id}=k; Path=/; Max-Age=600; SameSite=Strict; Domain=zk.money; Secure`,
    )
    expect(handoffCookie("", "", false, id, 0)).toBe(
      `zkm_handoff_${id}=; Path=/; Max-Age=0; SameSite=Strict`,
    )
    const jar = `a=1; __Secure-zkm_handoff_${other}=theirs; __Secure-zkm_handoff_${id}=abc_-; b=2`
    expect(readHandoffCookie(jar, true, id)).toBe("abc_-")
    expect(readHandoffCookie(jar, true, other)).toBe("theirs")
    expect(readHandoffCookie(`zkm_handoff_${id}=abc`, true, id)).toBeNull()
    expect(readHandoffCookie(`__Secure-zkm_handoff_${id}=`, true, id)).toBeNull()
  })

  it("refuses an id that could smuggle cookie syntax", () => {
    for (const id of [
      "",
      "x",
      "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b; Domain=evil",
      "../0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    ]) {
      expect(() => handoffCookie("k", "", true, id), id).toThrow("Invalid handoff id")
    }
  })
})
