/**
 * The copied report carries the error and where it happened, one fact per line. A sent report
 * carries scrubbed text and the wallet's own frames, never the raw message or stack.
 */
import { WalletError } from "@obsidion/core/errors"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ErrorModalPayload } from "../../src/errors/errorModal"
import { copyErrorReport, sendErrorReport } from "../../src/errors/shareErrorReport"
import { defaultConfig } from "../support/page"

vi.hoisted(() => vi.stubEnv("VITE_ZKMONEY_API_URL", "/svc/usage"))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function copied(payload: Parameters<typeof copyErrorReport>[0]): Promise<string[]> {
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  await copyErrorReport(payload, defaultConfig.network)
  expect(writeText).toHaveBeenCalledOnce()
  return writeText.mock.calls[0]![0].split("\n")
}

describe("copyErrorReport", () => {
  it("writes the title, message, detail, context and network", async () => {
    const lines = await copied({ title: "T1", message: "M1", detail: "D1", context: "C1" })
    for (const value of ["T1", "M1", "D1", "C1", defaultConfig.network])
      expect(lines.filter((line) => line.endsWith(value))).toHaveLength(1)
    expect(lines).toHaveLength(7)
  })

  it("leaves out the lines it has no value for", async () => {
    const lines = await copied({ title: "T1", message: "M1" })
    expect(lines).toHaveLength(5)
    expect(lines.some((line) => line.endsWith("undefined"))).toBe(false)
  })
})

const ADDRESS = "0x" + "ab".repeat(20)

function fetchFailure(): Error {
  const error = new TypeError(
    "Failed to fetch alice@private.example from https://rpc.example/v2/KEY",
  )
  error.stack = [
    `TypeError: ${error.message}`,
    `    at sendTx (${window.location.origin}/assets/index-BX12.js?v=1:10:2345)`,
    `    at Object.alice@private.example (${window.location.origin}/assets/index-BX12.js:7:1)`,
    `    at ${window.location.origin}/pay/alice:3:1`,
    "    at hook (chrome-extension://abcdefgh/inject.js:1:9)",
  ].join("\n")
  return error
}

/** The report `sendErrorReport` posts for `payload`. */
async function sent(payload: ErrorModalPayload): Promise<string> {
  const posted = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response)
  await expect(sendErrorReport(payload)).resolves.toBe(true)
  expect(posted).toHaveBeenCalledOnce()
  return String(posted.mock.calls[0]![1]!.body)
}

describe("sendErrorReport", () => {
  it.each<[string, () => ErrorModalPayload, object]>([
    [
      "an error's scrubbed message, with only the wallet's own scripts in its frames",
      () => {
        const error = fetchFailure()
        return { title: "Sweep failed for @alice", message: "m", detail: error.stack, error }
      },
      {
        title: "Sweep failed for [tag]",
        message: "Failed to fetch [email] from [url]",
        type: "TypeError",
        frames: [
          { filename: "[external]" },
          { filename: "[external]" },
          { filename: "/assets/index-BX12.js", function: "[email]", lineno: 7, colno: 1 },
          { filename: "/assets/index-BX12.js", function: "sendTx", lineno: 10, colno: 2345 },
        ],
      },
    ],
    [
      "a scrubbed class name and a function name, each cut to what the route takes",
      () => {
        const error = Object.assign(new Error(""), {
          name: `alice@private.example ${"N".repeat(70)}`,
        })
        error.stack = `    at ${"f".repeat(300)} (${
          window.location.origin
        }/assets/index-BX12.js:7:1)`
        return { title: "t", message: "m", error }
      },
      {
        message: `[email] ${"N".repeat(70)}`,
        type: `[email] ${"N".repeat(56)}`,
        frames: [
          { filename: "/assets/index-BX12.js", function: "f".repeat(256), lineno: 7, colno: 1 },
        ],
      },
    ],
    [
      "a WalletError's code and scrubbed detail",
      () => ({
        title: "t",
        message: `@alice cannot pay ${ADDRESS}`,
        error: new WalletError("operation.running", `operation for ${ADDRESS}`),
      }),
      { message: "operation.running: operation for [hex]", type: "WalletError" },
    ],
    [
      "the scrubbed message of a report with no error",
      () => ({ title: "t", message: `seal/failed/TypeError for ${ADDRESS}` }),
      { message: "seal/failed/TypeError for [hex]" },
    ],
  ])("sends %s", async (_case, payload, expected) => {
    const body = await sent(payload())
    expect(JSON.parse(body)).toMatchObject(expected)
    expect(body).not.toMatch(/alice|rpc\.example|chrome-extension|abab/)
  })

  it("sends the report without frames when the stack cannot be parsed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    // A thrown value can carry anything as its stack, and the parser takes only text.
    const error = Object.assign(fetchFailure(), { stack: 42 as unknown as string })
    const report = JSON.parse(await sent({ title: "t", message: "m", error }))
    expect(report.type).toBe("TypeError")
    expect(report).not.toHaveProperty("frames")
  })
})
