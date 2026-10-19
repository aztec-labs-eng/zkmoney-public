import { ApprovalNeededError } from "@obsidion/sdk"
import { bytesToHex, hexToBytes, keccak256, stringToHex, type Hex } from "viem"
import type { IStorageAdapter } from "../storages/adapter"

export interface ApprovalCodec<T> {
  encode(value: T): string
  decode(raw: string): T
}

const jsonCodec: ApprovalCodec<never> = {
  encode: (value) => JSON.stringify(value),
  decode: (raw) => JSON.parse(raw) as never,
}

/** A WebAuthn assertion's bytes, kept as hex. */
export const webAuthnAssertionCodec: ApprovalCodec<{
  signature: Uint8Array
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
}> = {
  encode: (value) =>
    JSON.stringify({
      signature: bytesToHex(value.signature),
      authenticatorData: bytesToHex(value.authenticatorData),
      // Some authenticator bridges hand the client data back as text.
      clientDataJSON:
        typeof value.clientDataJSON === "string"
          ? stringToHex(value.clientDataJSON)
          : bytesToHex(value.clientDataJSON),
    }),
  decode: (raw) => {
    const value = JSON.parse(raw) as Record<
      "signature" | "authenticatorData" | "clientDataJSON",
      Hex
    >
    return {
      signature: hexToBytes(value.signature),
      authenticatorData: hexToBytes(value.authenticatorData),
      clientDataJSON: hexToBytes(value.clientDataJSON),
    }
  },
}

/**
 * Who may be asked for an approval now. The controller sets both for each advance: its signal, and
 * whether the user started it. Anything else may use saved approvals but never opens a prompt.
 */
export class ApprovalGate {
  signal?: AbortSignal
  prompts = true

  /** Checked immediately before a prompt opens. */
  check() {
    this.signal?.throwIfAborted()
    if (!this.prompts) throw new ApprovalNeededError()
  }
}

/**
 * A signer that asks once per challenge. An assertion authorizes only the challenge it signed, so
 * returning a saved one never signs anything the user has not approved; it is stored before it is
 * returned, so a reload or retry after that never asks again.
 */
export function savedChallengeSigner<C extends Hex | Uint8Array, T>(
  sign: (challenge: C, opts?: { signal?: AbortSignal }) => Promise<T>,
  storage: Pick<IStorageAdapter, "getItem" | "setItem">,
  prefix: string,
  codec: ApprovalCodec<T> = jsonCodec,
  gate?: ApprovalGate,
): (challenge: C) => Promise<T> {
  return async (challenge) => {
    const key = `${prefix}/${keccak256(
      typeof challenge === "string" ? challenge : new Uint8Array(challenge),
    )}`
    const saved = await storage.getItem(key)
    if (saved) return codec.decode(saved)
    gate?.check()
    const signed = await sign(challenge, { signal: gate?.signal })
    await storage.setItem(key, codec.encode(signed))
    return signed
  }
}
