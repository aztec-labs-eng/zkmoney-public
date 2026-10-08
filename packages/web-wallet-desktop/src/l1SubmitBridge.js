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
const MAX_MESSAGE_LENGTH = 500
const ATTEMPT = /^[0-9a-f]{32}$/

// A recheck submission waits for the wallet page to approve each send attempt:
// pending → checking → authorized → sending → submitted, or refused (terminal).
// A plain submission goes straight from pending to submitted.
const LIVE_STATES = new Set(["pending", "checking", "authorized", "sending"])

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
 *
 * A submission created with `recheck: true` can outlive the facts the wallet
 * checked before creating it, so the helper asks the wallet page to approve each
 * send right before it. `check` numbers the requests so an answer to an earlier
 * one is refused. Each helper click is an `attempt`: only the attempt that asked
 * for the approved check can claim it, and a claimed send holds the submission
 * until its hash arrives or its wallet prompt is declined, so a second tab cannot
 * open a second prompt. Its prompt has no expiry, so a claimed send also outlives
 * the TTL and later creates, and no other checked submission starts beside it.
 */
function createL1SubmitBridge({ now = () => Date.now() } = {}) {
  const submissions = new Map()

  const prune = () => {
    for (const [id, record] of submissions) {
      if (record.state !== "sending" && now() - record.createdAt > SUBMISSION_TTL_MS) {
        submissions.delete(id)
      }
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
      if (body?.recheck !== undefined && typeof body.recheck !== "boolean") {
        throw new Error("recheck must be a boolean when present")
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

      const recheck = body?.recheck === true
      const claimed = [...submissions.values()].some((record) => record.state === "sending")
      if (recheck && claimed) {
        throw Object.assign(new Error("A send is already open in a wallet"), { code: "send-open" })
      }
      // One live submission at a time: a fresh create supersedes any live one that holds
      // no send, so an abandoned helper tab can't submit a stale transaction later.
      for (const record of submissions.values()) {
        if (LIVE_STATES.has(record.state) && record.state !== "sending") record.state = "superseded"
      }

      const id = crypto.randomBytes(16).toString("hex")
      submissions.set(id, {
        state: "pending",
        createdAt: now(),
        tx: { to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId },
        display: { title: display.title, lines },
        recheck,
        check: 0,
        checkOwner: undefined,
        sendingAttempt: undefined,
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
      return {
        state: record.state,
        txHash: record.txHash,
        message: record.message,
        ...(record.recheck ? { check: record.check } : {}),
      }
    },

    /** Helper-facing state view while it waits for approval. */
    getState(id) {
      prune()
      const record = submissions.get(id)
      if (!record) return null
      return { state: record.state, check: record.check, message: record.message }
    },

    /** Helper asks the wallet page to approve a send attempt. Each call starts a new check. */
    requestCheck(id, body) {
      prune()
      const record = submissions.get(id)
      if (!record) throw new Error("Unknown or expired submission")
      if (!record.recheck) throw new Error("This submission does not take a check")
      if (!ATTEMPT.test(body?.attempt ?? "")) throw new Error("attempt must be 32 hex characters")
      if (record.state === "sending") throw new Error("A send is already open in a wallet")
      if (!LIVE_STATES.has(record.state)) throw new Error(`Submission is already ${record.state}`)
      record.state = "checking"
      record.check += 1
      record.checkOwner = body.attempt
      return { state: record.state, check: record.check }
    },

    /**
     * Helper consumes its approval right before opening the wallet. Only the attempt that asked for
     * the current, approved check can claim it; from then on no other check can start.
     */
    claimSend(id, body) {
      prune()
      const record = submissions.get(id)
      if (!record) throw new Error("Unknown or expired submission")
      if (!record.recheck) throw new Error("This submission does not take a check")
      if (record.state !== "authorized")
        throw new Error(`Submission is ${record.state}, not authorized`)
      if (body?.check !== record.check || body?.attempt !== record.checkOwner) {
        throw new Error("This approval belongs to another check")
      }
      record.state = "sending"
      record.sendingAttempt = body.attempt
      return { state: record.state }
    },

    /** The claimed send's wallet prompt was declined: nothing was sent, a new check may start. */
    releaseSend(id, body) {
      prune()
      const record = submissions.get(id)
      if (!record) throw new Error("Unknown or expired submission")
      if (record.state !== "sending" || body?.attempt !== record.sendingAttempt) {
        throw new Error("This attempt holds no send")
      }
      record.state = "pending"
      record.sendingAttempt = undefined
      return { state: record.state }
    },

    /** Wallet page answers the current check. */
    resolveCheck(id, body) {
      prune()
      const record = submissions.get(id)
      if (!record) throw new Error("Unknown or expired submission")
      if (record.state !== "checking") {
        throw new Error(`Submission is ${record.state}, not checking`)
      }
      if (body?.check !== record.check) throw new Error("This answer is for an earlier check")
      if (body?.ok === true) {
        record.state = "authorized"
      } else if (body?.ok === false) {
        record.message = requireString(body.message, "message", MAX_MESSAGE_LENGTH)
        record.state = "refused"
      } else {
        throw new Error("ok must be a boolean")
      }
      return { state: record.state, check: record.check }
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
      if (record.recheck && (!record.sendingAttempt || body?.attempt !== record.sendingAttempt)) {
        throw new Error("Only the claimed send can report")
      }
      const open = record.recheck ? record.state === "sending" : record.state === "pending"
      if (!open) throw new Error(`Submission is already ${record.state}`)
      if (body?.state === "submitted") {
        if (!HEX_TX_HASH.test(body.txHash ?? "")) throw new Error("submitted requires a tx hash")
        record.state = "submitted"
        record.txHash = body.txHash
      } else if (body?.state === "error") {
        // An error proves nothing about a claimed send's prompt: only its hash or a decline ends it.
        if (record.recheck) throw new Error("A claimed send reports only its hash")
        record.message = requireString(
          body.message ?? "unknown error",
          "message",
          MAX_MESSAGE_LENGTH,
        )
        record.state = "error"
      } else {
        throw new Error('state must be "submitted" or "error"')
      }
      return { state: record.state }
    },
  }
}

/** Whether the helper page may still act on a submission in this state. */
function isLiveSubmission(record) {
  return !!record && LIVE_STATES.has(record.state)
}

module.exports = { createL1SubmitBridge, isLiveSubmission, SUBMISSION_TTL_MS }
