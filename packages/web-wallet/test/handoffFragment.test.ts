/**
 * The sealed hand-off's wallet half: the fragment leaves the URL, and only a tab the campaign opened
 * takes material that opens under its own hand-off's key and validates. Only that hand-off's cookie
 * is cleared; a refused fragment leaves every pending hand-off alone.
 */
import { describe, expect, it, vi } from "vitest"
import { sealHandoff } from "@obsidion/passkey-web"
import {
  isCampaignClaimArrival,
  receiveHandoffFragment,
  takeHandoffFragment,
} from "../src/bridge/fragment"

const CAMPAIGN = "https://launch.zk.money"
const ID = "0f8e1c2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b"
const OTHER = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
const env = { campaignUrl: CAMPAIGN, rpId: "localhost" }
const message = {
  v: 1,
  type: "handoff-material",
  nonce: "n-1",
  derivedAt: 1757000000000,
  rpId: "localhost",
  credentialId: "AbCdEfGhIjKlMnOpQrStUv",
  pubkeyHex: "ab".repeat(64),
  candidates: { first: `0x${"11".repeat(32)}` },
}

/** The wallet tab's document: the cookie jar it sees, who opened it, and every cookie it writes. */
function walletDoc(key: string | null, referrer = `${CAMPAIGN}/`, id = ID) {
  const written: string[] = []
  const doc = {
    get cookie() {
      return key ? `other=1; __Secure-zkm_handoff_${id}=${key}` : "other=1"
    },
    set cookie(value: string) {
      written.push(value)
    },
    referrer,
    location: { protocol: "https:", hostname: "wallet.zk.money" },
  } as unknown as Document
  return { doc, written }
}

describe("takeHandoffFragment", () => {
  it("strips the fragment and returns the ciphertext; leaves other URLs alone", () => {
    history.replaceState(null, "", "/claim/alice?entry=passkey#h=abc")
    expect(takeHandoffFragment()).toBe("abc")
    expect(location.pathname + location.search + location.hash).toBe("/claim/alice?entry=passkey")
    history.replaceState(null, "", "/link#secret")
    expect(takeHandoffFragment()).toBeNull()
    expect(location.hash).toBe("#secret")
  })
})

describe("receiveHandoffFragment", () => {
  it("takes the material its own key opens and clears only that cookie", async () => {
    const { key, sealed } = await sealHandoff(message)
    const { doc, written } = walletDoc(key)
    const hold = vi.fn()
    expect(await receiveHandoffFragment(`${ID}.${sealed}`, env, doc, hold)).toEqual({
      receipt: "accepted",
    })
    expect(written).toEqual([
      `__Secure-zkm_handoff_${ID}=; Path=/; Max-Age=0; SameSite=Strict; Domain=zk.money; Secure`,
    ])
    expect(hold).toHaveBeenCalledWith({
      v: 1,
      derivedAt: message.derivedAt,
      rpId: "localhost",
      credentialId: message.credentialId,
      pubkeyHex: `0x${message.pubkeyHex}`,
      candidates: message.candidates,
    })
  })

  it("refuses a tab another host opened, touching no cookie", async () => {
    const { key, sealed } = await sealHandoff(message)
    for (const referrer of ["https://evil.zk.money/", ""]) {
      const { doc, written } = walletDoc(key, referrer)
      const hold = vi.fn()
      expect(await receiveHandoffFragment(`${ID}.${sealed}`, env, doc, hold), referrer).toEqual({
        receipt: "rejected",
        rejection: "not_from_campaign",
      })
      expect(written).toEqual([])
      expect(hold).not.toHaveBeenCalled()
    }
  })

  it("takes nothing, touching no cookie, for another hand-off's key, a bad key or id, another RP, or no campaign", async () => {
    const { key, sealed } = await sealHandoff(message)
    const other = await sealHandoff({ ...message, rpId: "wallet.example" })
    const wrongKey = (await sealHandoff(message)).key
    const hold = vi.fn()
    // Each refusal names the check that stopped it, in closed words.
    const refused = [
      [`${ID}.${sealed}`, env, walletDoc(null), "no_key"],
      [`${ID}.${sealed}`, env, walletDoc(key, undefined, OTHER), "no_key"],
      [`${ID}.${sealed}`, env, walletDoc(wrongKey), "unreadable"],
      [sealed, env, walletDoc(key), "malformed"],
      [`not-an-id.${sealed}`, env, walletDoc(key), "malformed"],
      [`${ID}.${sealed}.extra`, env, walletDoc(key), "malformed"],
      [`${ID}.${other.sealed}`, env, walletDoc(other.key), "invalid"],
      [`${ID}.${sealed}`, { ...env, campaignUrl: "" }, walletDoc(key), "not_from_campaign"],
      [
        `${ID}.${sealed}`,
        { ...env, campaignUrl: "https://launch.example" },
        walletDoc(key, "https://launch.example/"),
        "no_shared_domain",
      ],
    ] as const
    for (const [fragment, e, { doc, written }, rejection] of refused) {
      expect(
        await receiveHandoffFragment(fragment, e, doc, hold),
        `${fragment.slice(0, 40)} ${rejection}`,
      ).toEqual({ receipt: "rejected", rejection })
      expect(written).toEqual([])
    }
    expect(hold).not.toHaveBeenCalled()
  })
})

describe("isCampaignClaimArrival", () => {
  it("is the campaign's claim link, sealed or plain, and nothing else", () => {
    const arrival = (url: string) => {
      const { pathname, search } = new URL(url, "https://wallet.zk.money")
      return isCampaignClaimArrival({ pathname, search })
    }
    expect(arrival("/claim/alice?entry=passkey&src=campaign&rp=zk.money")).toBe(true)
    expect(arrival("/claim/alice?entry=passkey")).toBe(false)
    expect(arrival("/claim/alice?src=campaign")).toBe(false)
    expect(arrival("/enter?handle=alice&src=campaign&entry=passkey")).toBe(false)
    expect(arrival("/")).toBe(false)
  })
})
