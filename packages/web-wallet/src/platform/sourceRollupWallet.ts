import { createLogger } from "@aztec-labs/foundation/log"
import { createNode, ObsidionWallet, type ObsidionAccount } from "@obsidion/sdk"
import { getConfig } from "../config/env"
import { SessionChangedError } from "./auth/sessionErrors"
import { getAuthService } from "./auth/useAuthenticator"
import { createPxeStore } from "./storage/createPxeStore"

export interface SourceRollupWallet {
  wallet: ObsidionWallet
  account: ObsidionAccount
}

const opened = new Map<string, Promise<SourceRollupWallet>>()

/**
 * The account on a rollup a cutover left: that rollup's node, and a PXE over the store this browser kept for it, so
 * the notes the account held there stay readable. One per node for the page's lifetime, beside the active PXE,
 * signing with the session's key: a session signing with another key re-signs it. A custom old-network node gets
 * its own store, as the active node's `nodeEndpointDigest` gives it one.
 */
export async function openSourceRollupWallet(
  nodeUrl: string,
  account: ObsidionAccount,
): Promise<SourceRollupWallet> {
  let source = opened.get(nodeUrl)
  if (!source) {
    source = open(nodeUrl, account)
    opened.set(nodeUrl, source)
    source.catch(() => opened.delete(nodeUrl))
  }
  const held = await source
  const signer = account.getAuthProvider()
  if (held.account.getAuthProvider() === signer) return held
  // The session signs with another key now: the source account takes it, or stays as it was.
  const first = source
  const resigned = signedAs(held, account)
  opened.set(nodeUrl, resigned)
  resigned.catch(() => opened.set(nodeUrl, first))
  return resigned
}

/** The session's key and signer, for an account that signs with that signer. */
async function sessionPair(account: ObsidionAccount) {
  const keys = await getAuthService().sessionKeys()
  if (!keys) throw new Error("Unlock the wallet to read the old network")
  if (keys.authProvider !== account.getAuthProvider()) throw new SessionChangedError()
  return keys
}

async function signedAs(
  source: SourceRollupWallet,
  account: ObsidionAccount,
): Promise<SourceRollupWallet> {
  const { secretKey, authProvider } = await sessionPair(account)
  return {
    wallet: source.wallet,
    account: await source.wallet.createObsidionAccount(secretKey, authProvider),
  }
}

async function open(nodeUrl: string, account: ObsidionAccount): Promise<SourceRollupWallet> {
  const { secretKey, authProvider } = await sessionPair(account)
  const { proverEnabled, sourceRollupApiKey, sourceNodeEndpointDigest } = getConfig()
  const node = createNode(nodeUrl, sourceRollupApiKey)
  const { rollupAddress } = await node.getL1ContractAddresses()
  const store = await createPxeStore(rollupAddress.toString(), sourceNodeEndpointDigest)
  try {
    const wallet = await ObsidionWallet.create(
      node,
      { proverEnabled },
      { loggers: { pxe: createLogger("pxe:source") }, store },
    )
    return {
      wallet,
      account: await wallet.createObsidionAccount(secretKey, authProvider),
    }
  } catch (error) {
    await store.close()
    throw error
  }
}
