import { createLogger } from "@aztec/foundation/log"
import { createNode, ObsidionWallet, type ObsidionAccount } from "@obsidion/sdk"
import { getConfig } from "../config/env"
import { getAuthService } from "./auth/useAuthenticator"
import { createPxeStore } from "./storage/createPxeStore"

export interface SourceRollupWallet {
  wallet: ObsidionWallet
  account: ObsidionAccount
}

const opened = new Map<string, Promise<SourceRollupWallet>>()

/**
 * The account on a rollup a cutover left: that rollup's node, and a PXE over the store this browser kept for it, so
 * the notes the account held there stay readable. One per node for the page's lifetime, beside the active PXE.
 */
export function openSourceRollupWallet(
  nodeUrl: string,
  account: ObsidionAccount,
): Promise<SourceRollupWallet> {
  let source = opened.get(nodeUrl)
  if (!source) {
    source = open(nodeUrl, account)
    opened.set(nodeUrl, source)
    source.catch(() => opened.delete(nodeUrl))
  }
  return source
}

async function open(nodeUrl: string, account: ObsidionAccount): Promise<SourceRollupWallet> {
  const secretKey = await getAuthService().getSecretKey()
  if (!secretKey) throw new Error("Unlock the wallet to read the old network")
  const node = createNode(nodeUrl)
  const { rollupAddress } = await node.getL1ContractAddresses()
  const store = await createPxeStore(rollupAddress.toString(), undefined)
  try {
    const wallet = await ObsidionWallet.create(
      node,
      { proverEnabled: getConfig().proverEnabled },
      { loggers: { pxe: createLogger("pxe:source") }, store },
    )
    return {
      wallet,
      account: await wallet.createObsidionAccount(secretKey, account.getAuthProvider()),
    }
  } catch (error) {
    await store.close()
    throw error
  }
}
