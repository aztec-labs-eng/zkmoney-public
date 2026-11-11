/** The unlocked session's keys, and what tells whether a registration's broadcast mined. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { BlockNumber } from "@aztec-labs/foundation/branded-types"
import { fetchSipaEvents, type ObsidionWallet } from "@obsidion/sdk"
import { WalletError } from "@obsidion/core/errors"
import type { PendingRegistrationRecord, SipaDeposits } from "@obsidion/front-core"

import type { PageFacts } from "../../session/pageChain"
import { requireTupleField } from "../../config/oxideTuple"
import type { Session } from "../../session/session"
import type { OnboardingKeys } from "../../session/account"

/** The unlocked session's keys without a ceremony; undefined while locked. */
export async function unlockedSessionKeys(
  session: Pick<Session, "auth">,
  wallet: ObsidionWallet,
): Promise<OnboardingKeys | undefined> {
  const keys = await session.auth.sessionKeys()
  if (!keys) return undefined
  const { secretKey, authProvider } = keys
  const [x, y] = await authProvider.getPubkeys()
  return {
    account: await wallet.createObsidionAccount(secretKey, authProvider),
    secretKey,
    authProvider,
    pubkeyHex: `0x${Buffer.concat([x, y]).toString("hex")}`,
  }
}

/**
 * Whether the record's broadcast mined, from `sinceBlock` on when given (a republish): the `SIPA`
 * event it sends this wallet is in the PXE, matched by the salt the deposit rail seeded. Throws when
 * it cannot tell (an unseeded record, a failed event read) so the tick spends nothing.
 */
export async function registrationBroadcastSeen(
  deposits: Pick<SipaDeposits, "get">,
  record: PendingRegistrationRecord,
  { chain }: PageFacts,
  wallet: ObsidionWallet,
  sinceBlock?: number,
): Promise<boolean> {
  const salt = (await deposits.get(record.sipaAddress))?.messageSecret
  if (!salt)
    throw new WalletError("unknown", `registration deposit ${record.sipaAddress} is not seeded`)
  const tuple = await chain.oxideTuple.read()
  const events = await fetchSipaEvents(
    wallet,
    AztecAddress.fromStringUnsafe(requireTupleField(tuple, "l2Token")),
    AztecAddress.fromStringUnsafe(record.l2Address),
    sinceBlock === undefined ? undefined : { fromBlock: BlockNumber(sinceBlock) },
  )
  const wanted = salt.toLowerCase()
  return events.some((event) => event.sharedSecretSalt.toString().toLowerCase() === wanted)
}
