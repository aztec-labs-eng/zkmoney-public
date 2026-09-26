/**
 * Assertions around a `claim_to_l1` burn: that it published a withdrawal the enclave actually
 * signed, plus balance helpers for the escrow and the creator.
 */
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import type { AztecNode } from "@aztec/aztec.js/node"
import type { TxHash } from "@aztec/stdlib/tx"
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract"
import {
  extractRequiredNullifiers,
  extractTeeNotes,
  extractWithdrawalMessageHashes,
} from "@oxide/oxide-lib/da_extractors.js"
import {
  fetchPublishedWithdrawals,
  type PublishedWithdrawal,
} from "@oxide/oxide-client/published_withdrawal.js"
import { buildWithdrawalOperationDigest } from "@oxide/tee-enclave/digest.js"
import { k1NoteSignatureToRS, type LocalTeeSigner } from "@oxide/tee-enclave/signer.js"
import { verifyEcdsa } from "@oxide/tee-enclave/libsecp256k1_signer.js"

import type { PaylinkService, PaylinkParams } from "../../src/services/PaylinkService.js"
import type { TokenService } from "../../src/services/TokenService.js"

export type L1ClaimTips = { proverTip: bigint }
export const ZERO_TIPS: L1ClaimTips = { proverTip: 0n }

/** The escrow's instance as rebuilt in the claimer's PXE. */
export async function escrowInstance(
  paylinkService: PaylinkService,
  params: PaylinkParams,
): Promise<ContractInstanceWithAddress> {
  const { instance } = await paylinkService.reconstructPaylinkContract(params)
  return instance
}

export type PublishedL1Claim = PublishedWithdrawal & {
  /** True when the published signature verifies against the enclave key over the rebuilt operation digest. */
  signedByEnclave: boolean
}

/**
 * Read the withdrawal a burn tx published and check it is the one the enclave signed: rebuild the
 * operation digest from the DA logs (anchor block hash, required nullifiers, TEE notes, withdrawal
 * message hashes) and verify the log's r/s pair against the sandbox enclave public key. This is
 * the attestation the enclave re-checks at finalization, so a zeroed or wrong-digest signature
 * fails here instead of on production.
 */
export async function readPublishedL1Claim(
  node: AztecNode,
  txHash: TxHash,
  token: AztecAddress,
  teeSigner: LocalTeeSigner,
): Promise<PublishedL1Claim[]> {
  const indexed = await node.getTxEffect(txHash)
  if (!indexed) throw new Error(`tx effect not indexed for ${txHash}`)
  const effect = indexed.data
  const { withdrawals, anchorBlockHash } = await fetchPublishedWithdrawals(node, txHash, token)
  const [requiredNullifiers, siloedNoteHashes, withdrawalMessageHashes] = await Promise.all([
    extractRequiredNullifiers(effect, token),
    extractTeeNotes(effect, token),
    extractWithdrawalMessageHashes(effect, token),
  ])
  if (withdrawals.length !== withdrawalMessageHashes.length) {
    throw new Error(
      `published ${withdrawals.length} withdrawal(s) but ${withdrawalMessageHashes.length} message hash(es)`,
    )
  }
  const pub = Buffer.concat([
    Buffer.from([0x04]),
    teeSigner.publicKey.x.toBuffer(),
    teeSigner.publicKey.y.toBuffer(),
  ])
  return Promise.all(
    withdrawals.map(async (w, i) => {
      const digest = await buildWithdrawalOperationDigest({
        anchorBlockHash,
        tokenAddress: token,
        requiredNullifiers,
        siloedNoteHashes,
        withdrawalMessageHashes,
        messageHash: withdrawalMessageHashes[i]!,
      })
      const { r, s } = k1NoteSignatureToRS(w.signature)
      const nonZero = !(r.toBuffer().every((b) => b === 0) && s.toBuffer().every((b) => b === 0))
      const signedByEnclave =
        nonZero && verifyEcdsa(Buffer.concat([r.toBuffer(), s.toBuffer()]), digest.toBuffer(), pub)
      return { ...w, signedByEnclave }
    }),
  )
}

/**
 * Poll until `account`'s private balance equals `expected`. The sender's PXE discovers its change
 * note and marks the spent note lazily on the next simulation, so a deposit issued straight after
 * the previous one can otherwise see a stale note set ("Balance too low" / "Existing nullifier").
 */
export async function waitForBalance(
  tokenService: TokenService,
  account: Parameters<TokenService["getBalance"]>[0],
  expected: bigint,
  attempts = 30,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if ((await tokenService.getBalance(account)) === expected) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`balance did not reach ${expected} after ${attempts} attempts`)
}

/** Private balance of the escrow as seen from the claimer's PXE (escrow keys are in scope there). */
export async function escrowBalance(
  tokenService: TokenService,
  escrow: AztecAddress,
  from: AztecAddress,
): Promise<bigint> {
  const token = await tokenService.getTokenContract()
  const result = await token.methods.balance_of!(escrow).simulate({
    from,
    additionalScopes: [escrow],
  } as any)
  return BigInt((result as any).result?.toString?.() ?? (result as any).toString())
}
