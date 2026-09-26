/**
 * exitBundleCodec — fail-closed parse for the host↔exit-runner IPC envelope
 * (types: @obsidion/core/types exitBundle.ts).
 *
 * The host treats every runner→host message as untrusted input from a frozen,
 * years-old dependency tree, so ANY problem — non-JSON, unknown type, unknown
 * key, wrong protocolVersion, missing/malformed field — collapses to the single
 * opaque `ExitBundleCodecError`. No partial message ever escapes.
 *
 * The runner is a version-pinned out-of-process step (two dependency trees
 * cannot share imports), so this codec validates the JSON crossing that
 * boundary. Keep it dependency-free — the only imports are type-only (erased at
 * build). The golden vector (test/fixtures/exit-bundle-golden.json) pins the
 * wire shape; changes must update the fixture too.
 */
import type {
  ExitBundleHostMessage,
  ExitBundleMessage,
  ExitBundleStage,
} from "@obsidion/core/types"

// Wire version of the host↔exit-bundle postMessage envelope (types in
// @obsidion/core/types exitBundle.ts). Canonical declaration: it is a literal
// rather than an import because this codec is copied verbatim into vendored
// generation trees that cannot resolve @obsidion. Bump only on a non-additive
// wire change, and move the golden vector in the same change.
const PROTOCOL_VERSION = 4

/** The single opaque reject. No field detail escapes (fail-closed). */
export class ExitBundleCodecError extends Error {
  constructor() {
    super("Invalid exit-bundle message")
    this.name = "ExitBundleCodecError"
  }
}

const STAGES: ReadonlySet<string> = new Set([
  "booting",
  "syncing",
  "enumerating",
  "proving",
  "done",
])

const HEX = /^0x[0-9a-fA-F]+$/
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const HEX20 = /^0x[0-9a-fA-F]{40}$/
const BARE_HEX = /^[0-9a-fA-F]+$/
const DECIMAL = /^(0|[1-9][0-9]*)$/

/** Parse a bundle→host message (status / notes-enumerated / exit-result / error). */
export function parseExitBundleMessage(raw: unknown): ExitBundleMessage {
  const msg = toRecord(raw)
  checkVersion(msg)
  switch (msg.type) {
    case "status":
      allowKeys(msg, ["protocolVersion", "type", "stage", "detail"])
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: "status",
        stage: asStage(msg.stage),
        ...(msg.detail === undefined ? {} : { detail: asString(msg.detail) }),
      }
    case "notes-enumerated":
      allowKeys(msg, ["protocolVersion", "type", "noteCount", "totalAmount"])
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: "notes-enumerated",
        noteCount: asCount(msg.noteCount),
        totalAmount: asDecimal(msg.totalAmount),
      }
    case "exit-result":
      allowKeys(msg, [
        "protocolVersion",
        "type",
        "amount",
        "proof",
        "nullifiers",
        "teeSignature",
        "provingMs",
      ])
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: "exit-result",
        amount: asDecimal(msg.amount),
        proof: asHex(msg.proof),
        nullifiers: asNullifiers(msg.nullifiers),
        teeSignature: asHex(msg.teeSignature),
        provingMs: asCount(msg.provingMs),
      }
    case "error":
      allowKeys(msg, ["protocolVersion", "type", "stage", "message"])
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: "error",
        ...(msg.stage === undefined ? {} : { stage: asStage(msg.stage) }),
        message: asString(msg.message),
      }
    default:
      throw new ExitBundleCodecError()
  }
}

/** Parse a host→bundle message (exit-request / proceed). Used by the bundle mirror. */
export function parseExitBundleHostMessage(raw: unknown): ExitBundleHostMessage {
  const msg = toRecord(raw)
  checkVersion(msg)
  switch (msg.type) {
    case "exit-request":
      allowKeys(msg, [
        "protocolVersion",
        "type",
        "secretKey",
        "signingKey",
        "accountAddress",
        "teeSecretKey",
        "nodeUrl",
        "l1RpcUrl",
        "l1ChainId",
        "rollupVersion",
        "portalAddress",
        "l2TokenAddress",
        "l1Recipient",
        "processorTip",
      ])
      return {
        protocolVersion: PROTOCOL_VERSION,
        type: "exit-request",
        secretKey: asHex(msg.secretKey),
        signingKey: asBareHex(msg.signingKey),
        accountAddress: asHex32(msg.accountAddress),
        teeSecretKey: asHex32(msg.teeSecretKey),
        nodeUrl: asUrl(msg.nodeUrl),
        l1RpcUrl: asUrl(msg.l1RpcUrl),
        l1ChainId: asCount(msg.l1ChainId),
        rollupVersion: asDecimal(msg.rollupVersion),
        portalAddress: asHex20(msg.portalAddress),
        l2TokenAddress: asHex32(msg.l2TokenAddress),
        l1Recipient: asHex20(msg.l1Recipient),
        processorTip: asDecimal(msg.processorTip),
      }
    case "proceed":
      allowKeys(msg, ["protocolVersion", "type"])
      return { protocolVersion: PROTOCOL_VERSION, type: "proceed" }
    default:
      throw new ExitBundleCodecError()
  }
}

// ── validation primitives ────────────────────────────────────────────

function toRecord(raw: unknown): Record<string, unknown> {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      throw new ExitBundleCodecError()
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExitBundleCodecError()
  }
  return value as Record<string, unknown>
}

function checkVersion(msg: Record<string, unknown>): void {
  if (msg.protocolVersion !== PROTOCOL_VERSION) throw new ExitBundleCodecError()
}

function allowKeys(msg: Record<string, unknown>, known: string[]): void {
  const knownSet = new Set(known)
  for (const key of Object.keys(msg)) {
    if (!knownSet.has(key)) throw new ExitBundleCodecError()
  }
}

function asString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new ExitBundleCodecError()
  return value
}

function asStage(value: unknown): ExitBundleStage {
  if (typeof value !== "string" || !STAGES.has(value)) throw new ExitBundleCodecError()
  return value as ExitBundleStage
}

function asCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ExitBundleCodecError()
  }
  return value
}

function asDecimal(value: unknown): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new ExitBundleCodecError()
  return value
}

function asHex(value: unknown): string {
  if (typeof value !== "string" || !HEX.test(value) || value.length % 2 !== 0) {
    throw new ExitBundleCodecError()
  }
  return value
}

function asBareHex(value: unknown): string {
  if (typeof value !== "string" || !BARE_HEX.test(value) || value.length % 2 !== 0) {
    throw new ExitBundleCodecError()
  }
  return value
}

function asHex20(value: unknown): string {
  if (typeof value !== "string" || !HEX20.test(value)) throw new ExitBundleCodecError()
  return value
}

function asHex32(value: unknown): string {
  if (typeof value !== "string" || !HEX32.test(value)) throw new ExitBundleCodecError()
  return value
}

function asNullifiers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ExitBundleCodecError()
  return value.map((n) => {
    if (typeof n !== "string" || !HEX32.test(n)) throw new ExitBundleCodecError()
    return n
  })
}

function asUrl(value: unknown): string {
  if (typeof value !== "string") throw new ExitBundleCodecError()
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ExitBundleCodecError()
    }
  } catch {
    throw new ExitBundleCodecError()
  }
  return value
}
