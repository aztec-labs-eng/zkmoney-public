import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { keyedService, type KeyedService, type Service } from "@obsidion/front-core"
import { TokenService, type ObsidionAccount, type ObsidionWallet } from "@obsidion/sdk"

/** The page's token services, by account and token, over the page's wallet. */
export type TokenServices = KeyedService<[ObsidionAccount, string], TokenService>

/**
 * One service per L2 token and account: every reader of a token shares it, so the PXE registers
 * the token once. A new wallet builds each again. A failed create is tried again on the next call.
 */
export const pageTokenServices = (wallet: Service<ObsidionWallet>): TokenServices =>
  keyedService(
    "tokenService",
    {
      from: [wallet],
      retry: "manual",
      key: (account: ObsidionAccount, l2Token: string) => [account.getAddress().toString(), l2Token],
    },
    ([account, l2Token], [wallet]) =>
      TokenService.create(wallet, account, AztecAddress.fromStringUnsafe(l2Token)),
  )
