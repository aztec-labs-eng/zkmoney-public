// @vitest-environment node
import { describe, expect, it } from "vitest"
import { AUTH_TYPE } from "@obsidion/sdk"
import { accountTransition, type AccountEvent } from "../../src/engine/account"
import type { AccountState } from "../../src/types"

const NOW = 1_000
const SIGNER = { credentialId: "c1", pubkey: "p1" }
const OTHER = { credentialId: "c2", pubkey: "p2", authenticatorType: "security-key" as const }

const passkey = (over: Partial<AccountState> = {}): AccountState => ({
  completeAddress: "0xa",
  signKeyConfig: { type: AUTH_TYPE.WEB_AUTHN, webauthnData: SIGNER },
  ...over,
})
const ecdsa = passkey({ signKeyConfig: { type: AUTH_TYPE.ECDSA_K256, webauthnData: SIGNER } })
const entered = passkey({ enteredAt: 5 })

const saved: AccountEvent = { type: "saved", completeAddress: "0xb", signer: OTHER }
const moved: AccountEvent = { type: "moved", completeAddress: "0xb", signer: OTHER }
const signerReplaced: AccountEvent = { type: "signerReplaced", signer: OTHER }
const enter: AccountEvent = { type: "entered" }

const toB = (webauthnData: AccountState["signKeyConfig"]["webauthnData"], enteredAt?: number) => ({
  completeAddress: "0xb",
  signKeyConfig: { type: AUTH_TYPE.WEB_AUTHN, webauthnData },
  enteredAt,
})

/** Each event from each record: the record it leaves, or undefined when it leaves it as it is. */
const TABLE: [string, AccountState | undefined, AccountEvent, AccountState | undefined][] = [
  ["a save with no record", undefined, saved, toB(OTHER)],
  ["a save over another account, keeping its entry mark", entered, saved, toB(OTHER, 5)],
  ["a save over an ECDSA account names a passkey", ecdsa, saved, toB(OTHER)],
  ["a move with no record", undefined, moved, toB(OTHER)],
  ["a move keeps the stored signer and entry mark", entered, moved, toB(SIGNER, 5)],
  [
    "a signer replaced",
    entered,
    signerReplaced,
    { ...entered, signKeyConfig: { ...entered.signKeyConfig, webauthnData: OTHER } },
  ],
  ["a signer replaced with no record", undefined, signerReplaced, undefined],
  ["a signer replaced on an account no passkey signs for", ecdsa, signerReplaced, undefined],
  ["the first entry", passkey(), enter, passkey({ enteredAt: NOW })],
  ["an entry with no record", undefined, enter, undefined],
  ["a second entry", entered, enter, undefined],
  ["an older build's entry mark", passkey({ enteredAt: 0 }), enter, undefined],
]

describe("accountTransition", () => {
  it.each(TABLE)("%s", (_, record, event, after) => {
    expect(accountTransition(record, event, NOW)).toEqual(after)
  })

  it.each(TABLE.filter(([, , , after]) => after !== undefined))(
    "is idempotent: %s again leaves the record as it is",
    (_, record, event) => {
      const once = accountTransition(record, event, NOW)
      const twice = accountTransition(once, event, NOW + 1)
      expect(twice === undefined || JSON.stringify(twice) === JSON.stringify(once)).toBe(true)
    },
  )
})
