import { zeroAddress, type Hex } from "viem"
import {
  AccountServiceClient,
  AccountServiceError,
  composeWireNameHash,
  deriveBootstrapKey,
} from "@obsidion/front-core"
import type { ObsidionAccount } from "@obsidion/sdk"
import { getConfig } from "../../config/env"
import { getOxideTuple, requireTupleField } from "../../config/oxideTuple"
import { accountServiceFor, collectOnboardingKeys } from "./oxideOnboarding"
import { provePastUser } from "./pastUserProver"

export class PastUserAlreadyUsedError extends Error {}
export class PastUserNameTakenError extends Error {}

export interface PastUserProof {
  proof: Hex
  publicInputs: [Hex, Hex, Hex, Hex]
}

/** Proves the old wallet's `signature` for this account's bootstrap key and spends it for the earned schedule. */
export async function claimPastUser(account: ObsidionAccount, signature: Hex): Promise<void> {
  const keys = await collectOnboardingKeys(account)
  const owner = deriveBootstrapKey(keys.secretKey).address.toLowerCase() as Hex
  const { proof, publicInputs } = await provePastUser({ signature, owner })
  try {
    await accountServiceFor(getConfig(), keys).claimPastUser({
      proof,
      publicInputs: publicInputs as [Hex, Hex, Hex, Hex],
    })
  } catch (err) {
    if (err instanceof AccountServiceError && err.status === 409) {
      throw new PastUserAlreadyUsedError("This address was already used")
    }
    throw err
  }
}

/** Proves `signature` before any passkey exists: the proof names no owner, so it can earn one name grant. */
export async function provePastUserForGrant(signature: Hex): Promise<PastUserProof> {
  const { proof, publicInputs } = await provePastUser({ signature, owner: zeroAddress })
  return { proof, publicInputs: publicInputs as PastUserProof["publicInputs"] }
}

/**
 * Spends an owner-less proof for a grant that holds `tag` at the free price until the claim spends it.
 * Returns the grant token. A taken name is refused before the proof burns, so the proof can try another.
 */
export async function grantPastUser(proven: PastUserProof, tag: string): Promise<string> {
  const config = getConfig()
  const tuple = await getOxideTuple(config)
  const nameHash = composeWireNameHash(tag, requireTupleField(tuple, "ensDomain"))
  try {
    const client = new AccountServiceClient(config.accountServiceUrl, { readOnly: true })
    const { grantToken } = await client.pastUserGrant({
      proof: proven.proof,
      publicInputs: proven.publicInputs,
      nameHash,
    })
    return grantToken
  } catch (err) {
    if (err instanceof AccountServiceError && err.status === 409) {
      const code = (err.body as { error?: string } | undefined)?.error
      if (code === "past_user_claimed") {
        throw new PastUserAlreadyUsedError("This address was already used")
      }
      throw new PastUserNameTakenError("That tag was just taken. Choose another.")
    }
    throw err
  }
}
