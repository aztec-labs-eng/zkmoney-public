"use strict"

const crypto = require("node:crypto")

// One submission's lifetime; the helper page and the wallet's polling both stop
// making sense long before this.
const SUBMISSION_TTL_MS = 30 * 60_000

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/
const HEX_TX_HASH = /^0x[0-9a-fA-F]{64}$/
const MAX_DISPLAY_LINES = 10
const MAX_STRING_LENGTH = 200
const MAX_DATA_LENGTH = 200_000

function requireString(value, label, max = MAX_STRING_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string (max ${max} chars)`)
  }
  return value
}

/**
 * In-memory store of prepared L1 transactions on their way to the user's normal
 * browser. The wallet page creates a submission and polls it; the helper page
 * renders it and reports the outcome. Ids are 128-bit random — the plain-HTTP
 * helper listener relies on their unguessability.
 */
function createL1SubmitBridge({ now = () => Date.now() } = {}) {
  const submissions = new Map()

  const prune = () => {
    for (const [id, record] of submissions) {
      if (now() - record.createdAt > SUBMISSION_TTL_MS) submissions.delete(id)
    }
  }

  return {
    create(body) {
      prune()
      const tx = body?.tx ?? {}
      const display = body?.display ?? {}
      if (!HEX_ADDRESS.test(tx.to)) throw new Error("tx.to must be a 20-byte hex address")
      if (
        typeof tx.data !== "string" ||
        !HEX_DATA.test(tx.data) ||
        tx.data.length > MAX_DATA_LENGTH
      ) {
        throw new Error("tx.data must be a hex string")
      }
      if (tx.value !== undefined && !/^0x[0-9a-fA-F]{1,64}$/.test(tx.value)) {
        throw new Error("tx.value must be a hex quantity when present")
      }
      if (!Number.isInteger(tx.chainId) || tx.chainId <= 0) {
        throw new Error("tx.chainId must be a positive integer")
      }
      requireString(display.title, "display.title")
      if (!Array.isArray(display.lines) || display.lines.length > MAX_DISPLAY_LINES) {
        throw new Error(`display.lines must be an array of at most ${MAX_DISPLAY_LINES} entries`)
      }
      const lines = display.lines.map((line) => {
        if (!Array.isArray(line) || line.length !== 2) {
          throw new Error("each display line must be a [label, value] pair")
        }
        return [requireString(line[0], "line label"), requireString(line[1], "line value")]
      })

      // One live submission at a time: a fresh create supersedes any pending one,
      // so an abandoned helper tab can't submit a stale transaction later.
      for (const record of submissions.values()) {
        if (record.state === "pending") record.state = "superseded"
      }

      const id = crypto.randomBytes(16).toString("hex")
      submissions.set(id, {
        state: "pending",
        createdAt: now(),
        tx: { to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId },
        display: { title: display.title, lines },
        txHash: undefined,
        message: undefined,
      })
      return { id }
    },

    /** Wallet-facing status view. */
    get(id) {
      prune()
      const record = submissions.get(id)
      if (!record) return null
      return { state: record.state, txHash: record.txHash, message: record.message }
    },

    /** Helper-page-facing full view (tx + display) for rendering. */
    getPayload(id) {
      prune()
      return submissions.get(id) ?? null
    },

    /** Outcome reported by the helper page. */
    report(id, body) {
      prune()
      const record = submissions.get(id)
      if (!record) throw new Error("Unknown or expired submission")
      if (record.state !== "pending") throw new Error(`Submission is already ${record.state}`)
      if (body?.state === "submitted") {
        if (!HEX_TX_HASH.test(body.txHash ?? "")) throw new Error("submitted requires a tx hash")
        record.state = "submitted"
        record.txHash = body.txHash
      } else if (body?.state === "error") {
        record.state = "error"
        record.message = requireString(body.message ?? "unknown error", "message", 500)
      } else {
        throw new Error('state must be "submitted" or "error"')
      }
      return { state: record.state }
    },
  }
}

module.exports = { createL1SubmitBridge, SUBMISSION_TTL_MS }
