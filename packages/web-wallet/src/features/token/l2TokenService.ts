import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { TokenService, type ObsidionAccount, type ObsidionWallet } from "@obsidion/sdk"

const services = new WeakMap<ObsidionWallet, Map<string, Promise<TokenService>>>()

/**
 * The service of one L2 token for one account, one per wallet: every reader of a token shares it,
 * so the PXE registers the token once. A failed create is tried again.
 */
export function l2TokenService(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
  l2Token: string,
): Promise<TokenService> {
  const byKey = services.get(wallet) ?? new Map<string, Promise<TokenService>>()
  services.set(wallet, byKey)
  const key = `${account.getAddress().toString()}:${l2Token.toLowerCase()}`
  const cached = byKey.get(key)
  if (cached) return cached
  const created = TokenService.create(wallet, account, AztecAddress.fromStringUnsafe(l2Token))
  byKey.set(key, created)
  created.catch(() => byKey.get(key) === created && byKey.delete(key))
  return created
}
