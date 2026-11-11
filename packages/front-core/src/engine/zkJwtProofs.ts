import { ZKJWT_PUBLIC_INPUT_COUNT } from "@obsidion/core/constants"
import type { Database } from "./database"
import { WalletError } from "./errors"
import { loadRecords, persistentStore } from "./persistentStore"
import { removeDeadKeys } from "../storageMigrations/deadKeys"

/** The email/JWT commitment hash version a proof is built for. */
export const ZKJWT_EMAIL_HASH_VERSION = 2

export interface ZkJwtProofMetadata {
  hashVersion: number
  /** The JWT's issue time, in unix seconds. */
  iat: number
  jwkId: string
  issHash: string
  /** The registry-allowlisted aud hash the proof is bound to. */
  audHash: string
  /** The email commitment the proof opens. */
  commitment: string
  callerAddress: string
  cachedAt: number
  provider: "google" | "apple"
  email: string
}

/** A claimer-bound zkJWT proof for an email-locked link. */
export interface ZkJwtProof {
  proof: string[]
  vkey: string[]
  publicInputs: string[]
  metadata: ZkJwtProofMetadata
}

/** Seals a proof at rest, since it carries the user's email and address. */
export interface ProofSealer {
  encrypt(plaintext: string): Promise<string>
  decrypt(ciphertext: string): Promise<string>
}

/** The account's proofs, reused for a week so a second claim to the same email skips OAuth. */
export interface ZkJwtProofs {
  readonly ready: Promise<void>
  /** A usable proof for this caller and commitment. Expired proofs are removed. */
  find(
    sealer: ProofSealer,
    caller: string,
    commitment: string,
    at?: number,
  ): Promise<ZkJwtProof | undefined>
  /** Saves a proof, dropping the oldest beyond the cap. */
  save(sealer: ProofSealer, proof: ZkJwtProof): Promise<void>
}

interface SealedProof {
  id: string
  cachedAt: number
  sealed: string
}

const PREFIX = "acct/zkJwtProofs"
const MAX_PROOFS = 10
const TTL_MS = 7 * 24 * 60 * 60 * 1000

const usable = ({ publicInputs, metadata }: ZkJwtProof, now: number) =>
  metadata.hashVersion === ZKJWT_EMAIL_HASH_VERSION &&
  publicInputs.length === ZKJWT_PUBLIC_INPUT_COUNT &&
  now - metadata.iat * 1000 <= TTL_MS &&
  now - metadata.cachedAt <= TTL_MS

/**
 * Version 1 opens empty: a lost proof costs one more OAuth sign-in. Version 2 removes the keys of
 * the namespace's deleted stores. Record ids are random, so no key names an email commitment.
 */
export function createZkJwtProofs({ db, now }: { db: Database; now: () => number }): ZkJwtProofs {
  const store = persistentStore<SealedProof>(db, {
    prefix: PREFIX,
    version: 2,
    id: (record) => record.id,
    load: "all",
    async migrate(from, w) {
      if (from !== undefined && from !== 1)
        throw new WalletError("invariant", `zkJwtProofs: unknown version ${from}`)
      removeDeadKeys(w)
    },
  })

  const open = async (sealer: ProofSealer, record: SealedProof) =>
    JSON.parse(await sealer.decrypt(record.sealed)) as ZkJwtProof

  return {
    ready: store.ready,
    async find(sealer, caller, commitment, at = now()) {
      await store.ready
      for (const record of await loadRecords(store.view)) {
        const proof = await open(sealer, record)
        if (!usable(proof, at)) {
          await store.remove(record.id)
          continue
        }
        const { callerAddress, commitment: opens } = proof.metadata
        if (callerAddress === caller && opens === commitment) return proof
      }
      return undefined
    },
    async save(sealer, proof) {
      await store.ready
      const sealed = await sealer.encrypt(JSON.stringify(proof))
      const record = { id: crypto.randomUUID(), cachedAt: proof.metadata.cachedAt, sealed }
      await db.write(async (w) => {
        const older = [...(await loadRecords(store.view))].sort((a, b) => b.cachedAt - a.cachedAt)
        await store.put(record, w)
        for (const stale of older.slice(MAX_PROOFS - 1)) await store.remove(stale.id, w)
      })
    },
  }
}
