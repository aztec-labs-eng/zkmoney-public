import type { ObsidionAccount, TokenService } from "@obsidion/sdk"
import type { Session } from "../../session/session"

/** The service of one L2 token for one account, shared by every reader. */
export function l2TokenService(
  { tokenServices }: Pick<Session["page"], "tokenServices">,
  account: ObsidionAccount,
  l2Token: string,
): Promise<TokenService> {
  return tokenServices(account, l2Token).ready()
}
