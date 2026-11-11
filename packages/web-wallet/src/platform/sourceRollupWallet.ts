import { createLogger } from "@aztec-labs/foundation/log"
import { createNode, ObsidionWallet, type ObsidionAccount } from "@obsidion/sdk"
import type { WebWalletConfig } from "../config/env"
import { barretenbergWasm } from "./barretenberg"
import { SessionChangedError } from "./auth/sessionErrors"
import type { WebAlphaAuthService } from "./auth/WebAlphaAuthService"
import { createPxeStore } from "./storage/createPxeStore"

export interface SourceRollupWallet {
  wallet: ObsidionWallet
  account: ObsidionAccount
}

// eslint-disable-next-line no-restricted-syntax -- ZKM-1625
const opened = new Map<string, Promise<SourceRollupWallet>>()

/**
 * The account on a rollup a cutover left: that rollup's node, and a PXE over the store this browser kept for it, so
 * the notes the account held there stay readable. One per node for the page's lifetime, beside the active PXE,
 * signing with the session's key: a session signing with another key re-signs it. A custom old-network node gets
 * its own store, as the active node's `nodeEndpointDigest` gives it one.
 */
export async function openSourceRollupWallet(
  config: WebWalletConfig,
  nodeUrl: string,
  active: SourceRollupWallet,
  auth: SessionKeys,
): Promise<SourceRollupWallet> {
  const { account } = active
  let source = opened.get(nodeUrl)
  if (!source) {
    source = open(config, nodeUrl, active, auth)
    opened.set(nodeUrl, source)
    source.catch(() => opened.delete(nodeUrl))
  }
  const held = await source
  const signer = account.getAuthProvider()
  if (held.account.getAuthProvider() === signer) return held
  // The session signs with another key now: the source account takes it, or stays as it was.
  const first = source
  const resigned = signedAs(held, account, auth)
  opened.set(nodeUrl, resigned)
  resigned.catch(() => opened.set(nodeUrl, first))
  return resigned
}

type SessionKeys = Pick<WebAlphaAuthService, "sessionKeys">

/** The session's key and signer, for an account that signs with that signer. */
async function sessionPair(account: ObsidionAccount, auth: SessionKeys) {
  const keys = await auth.sessionKeys()
  if (!keys) throw new Error("Unlock the wallet to read the old network")
  if (keys.authProvider !== account.getAuthProvider()) throw new SessionChangedError()
  return keys
}

async function signedAs(
  source: SourceRollupWallet,
  account: ObsidionAccount,
  auth: SessionKeys,
): Promise<SourceRollupWallet> {
  const { secretKey, authProvider } = await sessionPair(account, auth)
  return {
    wallet: source.wallet,
    account: await source.wallet.createObsidionAccount(secretKey, authProvider),
  }
}

async function open(
  { proverEnabled, sourceRollupApiKey, sourceNodeEndpointDigest }: WebWalletConfig,
  nodeUrl: string,
  { account, wallet: active }: SourceRollupWallet,
  auth: SessionKeys,
): Promise<SourceRollupWallet> {
  const { secretKey, authProvider } = await sessionPair(account, auth)
  const node = createNode(nodeUrl, sourceRollupApiKey)
  const { rollupAddress } = await node.getL1ContractAddresses()
  const store = await createPxeStore(rollupAddress.toString(), sourceNodeEndpointDigest)
  try {
    const wallet = await ObsidionWallet.create(
      node,
      { proverEnabled },
      { loggers: { pxe: createLogger("pxe:source") }, proverOrOptions: barretenbergWasm(), store },
      { contractService: () => active.contractService },
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
