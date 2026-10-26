import { describe, expect, it, vi } from "vitest"
import { discoverFeePayer, feePayerEntry, withFeePayer } from "../../../src/core/rotation/feePayer"

const FPC = "0x00000000000000000000000000000000000000000000000000000000000000Ab"
const OTHER_FPC = "0x00000000000000000000000000000000000000000000000000000000000000cd"
const A = { address: "0xaaa", passkey: "aa".repeat(64) }
const B = { address: "0xbbb", passkey: "bb".repeat(64) }
const record = { l2Address: "0xab", pubkey: A.passkey, feePayer: { [FPC.toLowerCase()]: A } }

describe("feePayerEntry", () => {
  it("names the entry written for the instance, whatever the address's case, else none", () => {
    expect(feePayerEntry(record, FPC.toUpperCase())).toEqual(A)
    expect(feePayerEntry(record, OTHER_FPC)).toBeUndefined()
    expect(feePayerEntry({ ...record, feePayer: undefined }, FPC)).toBeUndefined()
  })
})

describe("withFeePayer", () => {
  it("writes one instance's entry and keeps the others", () => {
    expect(withFeePayer(record, OTHER_FPC, B)).toEqual({
      [FPC.toLowerCase()]: A,
      [OTHER_FPC]: B,
    })
    expect(withFeePayer({ ...record, feePayer: undefined }, FPC, B)).toEqual({
      [FPC.toLowerCase()]: B,
    })
  })
})

describe("discoverFeePayer", () => {
  const subscribed = (addresses: Record<string, boolean>) =>
    vi.fn(async (passkey: string) => {
      const address = passkey === A.passkey ? A.address : B.address
      return { address, subscribed: addresses[address] ?? false }
    })

  it("takes the first subscribed single-key account in set order", async () => {
    const probe = subscribed({ [A.address]: true, [B.address]: true })
    expect(await discoverFeePayer([B.passkey, A.passkey], probe)).toEqual(B)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("skips an unsubscribed account", async () => {
    expect(
      await discoverFeePayer([A.passkey, B.passkey], subscribed({ [B.address]: true })),
    ).toEqual(B)
  })

  it("finds none when no key's account subscribed", async () => {
    expect(await discoverFeePayer([A.passkey, B.passkey], subscribed({}))).toBeUndefined()
  })
})
