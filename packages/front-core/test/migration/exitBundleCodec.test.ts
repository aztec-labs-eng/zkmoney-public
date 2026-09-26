import { describe, expect, it } from "vitest"
import {
  ExitBundleCodecError,
  parseExitBundleHostMessage,
  parseExitBundleMessage,
} from "../../src/index.js"
import golden from "./fixtures/exit-bundle-golden.json"

/**
 * Golden-vector drift guard for the exit-bundle wire format. The SAME fixture
 * is copied into the version-pinned worktree and asserted against the bundle's
 * mirrored codec, so a wire change fails BOTH suites — host and bundle must
 * agree exactly. Regenerate only when deliberately bumping the protocol.
 */
describe("exitBundleCodec golden vector", () => {
  it("parses every golden host message and returns it unchanged", () => {
    for (const msg of Object.values(golden.hostMessages)) {
      expect(parseExitBundleHostMessage(msg)).toEqual(msg)
    }
  })

  it("parses every golden bundle message and returns it unchanged", () => {
    for (const msg of Object.values(golden.bundleMessages)) {
      expect(parseExitBundleMessage(msg)).toEqual(msg)
    }
  })

  it("parses golden messages from their JSON string form (postMessage delivery)", () => {
    expect(parseExitBundleHostMessage(JSON.stringify(golden.hostMessages.exitRequest))).toEqual(
      golden.hostMessages.exitRequest,
    )
    expect(parseExitBundleMessage(JSON.stringify(golden.bundleMessages.exitResult))).toEqual(
      golden.bundleMessages.exitResult,
    )
  })

  it("rejects every invalid fixture with the opaque codec error, on both parsers", () => {
    for (const { name, message } of golden.invalid) {
      expect(() => parseExitBundleMessage(message), name).toThrow(ExitBundleCodecError)
      expect(() => parseExitBundleHostMessage(message), name).toThrow(ExitBundleCodecError)
    }
  })
})

describe("exitBundleCodec fail-closed behavior", () => {
  it("rejects non-JSON strings, arrays, null, and primitives", () => {
    for (const bad of ["not json", "[1,2]", [1, 2], null, undefined, 42, true]) {
      expect(() => parseExitBundleMessage(bad)).toThrow(ExitBundleCodecError)
    }
  })

  it("rejects a valid message routed to the wrong parser", () => {
    expect(() => parseExitBundleMessage(golden.hostMessages.exitRequest)).toThrow(
      ExitBundleCodecError,
    )
    expect(() => parseExitBundleHostMessage(golden.bundleMessages.exitResult)).toThrow(
      ExitBundleCodecError,
    )
  })

  it("rejects an exit-request with a non-http node URL", () => {
    const req = { ...golden.hostMessages.exitRequest, nodeUrl: "file:///etc/passwd" }
    expect(() => parseExitBundleHostMessage(req)).toThrow(ExitBundleCodecError)
  })

  it("rejects odd-length hex in proof bytes", () => {
    const res = { ...golden.bundleMessages.exitResult, proof: "0xabc" }
    expect(() => parseExitBundleMessage(res)).toThrow(ExitBundleCodecError)
  })

  it("accepts status without optional detail and error without optional stage", () => {
    expect(
      parseExitBundleMessage({ protocolVersion: 4, type: "status", stage: "booting" }),
    ).toEqual({ protocolVersion: 4, type: "status", stage: "booting" })
    expect(
      parseExitBundleMessage({ protocolVersion: 4, type: "error", message: "boom" }),
    ).toEqual({ protocolVersion: 4, type: "error", message: "boom" })
  })
})
