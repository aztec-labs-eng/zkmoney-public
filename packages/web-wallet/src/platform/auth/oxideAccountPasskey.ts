import { WebAuthnAlphaAuthProvider, type AlphaAuthProvider } from "@obsidion/sdk"
import { toWebAuthnAuthArg, type AccountPasskey } from "@obsidion/front-core"
import { bytesToHex } from "viem"

export async function oxideAccountPasskey(
  provider: AlphaAuthProvider,
): Promise<AccountPasskey | undefined> {
  if (!(provider instanceof WebAuthnAlphaAuthProvider)) return undefined
  const [x, y] = await provider.getPubkeys()
  return {
    key: { qx: bytesToHex(x), qy: bytesToHex(y) },
    sign: async (challenge) => {
      const result = await provider.signChallenge(Buffer.from(challenge.slice(2), "hex"))
      const clientDataJSON = Buffer.from(result.clientDataJSON).toString("utf8")
      const challengeIndex = clientDataJSON.indexOf('"challenge":')
      const typeIndex = clientDataJSON.indexOf('"type":')
      if (challengeIndex < 0 || typeIndex < 0)
        throw new Error("Passkey response is missing its challenge or type")
      return toWebAuthnAuthArg({
        signature: bytesToHex(result.signature),
        webauthn: {
          authenticatorData: bytesToHex(result.authenticatorData),
          clientDataJSON,
          challengeIndex,
          typeIndex,
        },
      })
    },
  }
}
