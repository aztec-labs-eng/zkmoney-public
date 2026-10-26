import { SOURCE_GENERATION_PROTOCOL } from "@obsidion/core/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  versions: new Map<string, string>(),
  getNodeInfo: vi.fn(),
  getSecretKey: vi.fn(async () => "0x01"),
}))

vi.mock("@obsidion/sdk", () => ({
  createNode: (url: string, apiKey?: string) => ({
    getNodeInfo: () => h.getNodeInfo(url, apiKey),
  }),
  WebAuthnAlphaAuthProvider: class {},
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({
    nodeUrl: "https://v6.rpc.example",
    nodeApiKey: "key",
    sourceRollupApiKey: "build-key",
  }),
}))
vi.mock("../src/platform/auth/useAuthenticator", () => ({
  getAuthService: () => ({ getSecretKey: h.getSecretKey }),
}))

const { WebAuthnAlphaAuthProvider } = await import("@obsidion/sdk")
const {
  checkedModule,
  isOtherGeneration,
  loadSourceGeneration,
  nodeAztecMajor,
  sourceAccountKeys,
  withSourceSigner,
} = await import("../src/platform/sourceGeneration")

beforeEach(() => {
  h.getNodeInfo.mockReset()
  h.getNodeInfo.mockImplementation(async (url: string) => ({
    nodeVersion: h.versions.get(url),
  }))
  h.versions.set("https://v6.rpc.example", "6.0.0")
})

describe("nodeAztecMajor", () => {
  it("reads the major version, whatever the patch or prefix", async () => {
    h.versions.set("https://a.example", "v5.0.0")
    await expect(nodeAztecMajor("https://a.example")).resolves.toBe("5")
  })

  it("asks a node once, and again after a failed read", async () => {
    h.getNodeInfo.mockRejectedValueOnce(new Error("down"))
    await expect(nodeAztecMajor("https://b.example")).rejects.toThrow("down")
    h.versions.set("https://b.example", "5.2.0")
    await expect(nodeAztecMajor("https://b.example")).resolves.toBe("5")
    await nodeAztecMajor("https://b.example")
    expect(h.getNodeInfo).toHaveBeenCalledTimes(2)
  })
})

describe("isOtherGeneration", () => {
  it("compares the source node's major version with the active node's", async () => {
    h.versions.set("https://v5.rpc.example", "5.2.0")
    h.versions.set("https://v6b.rpc.example", "6.1.0")
    await expect(isOtherGeneration("https://v5.rpc.example")).resolves.toBe(true)
    await expect(isOtherGeneration("https://v6b.rpc.example")).resolves.toBe(false)
  })
})

describe("the probe's API key", () => {
  it("sends the active node its own key and a source node the build's", async () => {
    vi.resetModules()
    const fresh = await import("../src/platform/sourceGeneration")
    h.versions.set("https://v5.rpc.example", "5.2.0")
    await fresh.isOtherGeneration("https://v5.rpc.example")
    expect(h.getNodeInfo).toHaveBeenCalledWith("https://v6.rpc.example", "key")
    expect(h.getNodeInfo).toHaveBeenCalledWith("https://v5.rpc.example", "build-key")
  })
})

describe("loadSourceGeneration", () => {
  it("refuses a version this build ships no bundle for", async () => {
    await expect(loadSourceGeneration("4")).rejects.toThrow(/cannot read an Aztec 4 network/)
  })
})

describe("checkedModule", () => {
  const bundle = (protocol: number, aztecVersion: string) => ({ protocol, aztecVersion } as never)

  it("takes a bundle of this protocol and major version", () => {
    const module = bundle(SOURCE_GENERATION_PROTOCOL, "5.2.0")
    expect(checkedModule("5", module)).toBe(module)
  })

  it("refuses a bundle of another protocol", () => {
    expect(() => checkedModule("5", bundle(1, "5.2.0"))).toThrow(
      `speaks protocol 1, not ${SOURCE_GENERATION_PROTOCOL}`,
    )
  })

  it("refuses a protocol 5 bundle, which builds the executor call itself", () => {
    expect(() => checkedModule("5", bundle(5, "5.2.0"))).toThrow(
      `The Aztec 5 bundle speaks protocol 5, not ${SOURCE_GENERATION_PROTOCOL}`,
    )
  })

  it("refuses a bundle of another major version", () => {
    expect(() => checkedModule("5", bundle(SOURCE_GENERATION_PROTOCOL, "6.0.0"))).toThrow(
      /built for Aztec 6.0.0/,
    )
  })
})

describe("withSourceSigner", () => {
  it("gives each overlapping build its own signer, one build at a time", async () => {
    const auth = Object.assign(Object.create(WebAuthnAlphaAuthProvider.prototype), {
      getPubkeys: async () => [Buffer.from("01", "hex"), Buffer.from("02", "hex")],
      signChallenge: async (challenge: Buffer) => `raw ${challenge.toString("hex")}`,
    })
    const keys = await sourceAccountKeys({ getAuthProvider: () => auth } as never)
    const through = (run: string) =>
      ((sign: (c: Uint8Array) => Promise<unknown>) => async (c: Uint8Array) =>
        `${run}: ${await sign(c)}`) as never
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))

    const a = withSourceSigner(through("a"), async () => {
      await held
      return keys.passkey.sign(new Uint8Array([0xaa]))
    })
    const b = withSourceSigner(through("b"), () => keys.passkey.sign(new Uint8Array([0xbb])))
    release()

    expect(await a).toBe("a: raw aa")
    expect(await b).toBe("b: raw bb")
    expect(await keys.passkey.sign(new Uint8Array([0xcc]))).toBe("raw cc")
  })
})
