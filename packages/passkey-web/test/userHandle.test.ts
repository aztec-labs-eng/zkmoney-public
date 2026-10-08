import { describe, expect, it } from "vitest"
import {
  MAX_USER_HANDLE_NAME_BYTES,
  decodeUserHandle,
  encodeUserHandle,
} from "../src/ceremony/userHandle.js"

describe("the passkey user handle", () => {
  it("carries the name back out, under a tail that makes each creation its own user", () => {
    const first = encodeUserHandle("alice")
    const second = encodeUserHandle("alice")
    expect(decodeUserHandle(first)).toBe("alice")
    expect(decodeUserHandle(second)).toBe("alice")
    expect(first.length).toBeLessThanOrEqual(64)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
  })

  it("keeps a name with a separator of its own intact up to the first one", () => {
    expect(decodeUserHandle(encodeUserHandle("@alice.zk.money"))).toBe("@alice.zk.money")
  })

  it("refuses a name that would not fit beside the tail", () => {
    expect(() => encodeUserHandle("")).toThrow()
    expect(() => encodeUserHandle("a".repeat(MAX_USER_HANDLE_NAME_BYTES + 1))).toThrow()
    expect(decodeUserHandle(encodeUserHandle("a".repeat(MAX_USER_HANDLE_NAME_BYTES)))).toBe(
      "a".repeat(MAX_USER_HANDLE_NAME_BYTES),
    )
  })

  it("reads nothing from a handle that carries no name", () => {
    expect(decodeUserHandle(undefined)).toBeUndefined()
    expect(decodeUserHandle(new Uint8Array(0))).toBeUndefined()
    expect(decodeUserHandle(new Uint8Array([0x00, 0x01, 0x02]))).toBeUndefined()
    // No separator at all: an older passkey's random handle.
    expect(decodeUserHandle(new Uint8Array([0x61, 0x62, 0x63]))).toBeUndefined()
    // Not UTF-8 before the separator.
    expect(decodeUserHandle(new Uint8Array([0xff, 0xfe, 0x00, 0x01]))).toBeUndefined()
  })
})
