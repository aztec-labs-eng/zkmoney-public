import type { Hex } from "viem"
import type { Config } from "wagmi"
import { signMessage } from "wagmi/actions"
import { ELIGIBILITY_SIGN_MESSAGE } from "@obsidion/core/constants"
import { WalletError } from "@obsidion/core/errors"
import type { WebWalletConfig } from "../../config/env"
import { iosSettings } from "../../platform/barretenberg"
import { NotPastUserError } from "./pastUserProof"
import type { PastUserProofReply, PastUserProofRequest } from "./pastUserProof.worker"

export { NotPastUserError }

/** The old wallet signs the fixed message; the proof is made from that signature alone. */
export function signPastUserMessage(wagmi: Config, account: Hex): Promise<Hex> {
  return signMessage(wagmi, { account, message: ELIGIBILITY_SIGN_MESSAGE })
}

export function pastUserLeavesUrl(config: WebWalletConfig): string {
  return new URL(`${config.accountServiceUrl}/domain/eligibility/leaves`, location.href).href
}

/** Runs one request in a one-shot worker. */
function inWorker(req: PastUserProofRequest): Promise<PastUserProofReply & { ok: true }> {
  const worker = new Worker(new URL("./pastUserProof.worker.ts", import.meta.url), {
    type: "module",
  })
  return new Promise<PastUserProofReply & { ok: true }>((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<PastUserProofReply>) => {
      if (data.ok) resolve(data)
      else {
        console.error("[past-user] worker failed:", data.error)
        reject(data.notPastUser ? new NotPastUserError() : new WalletError("unknown", data.error))
      }
    }
    worker.onerror = (event) => {
      console.error("[past-user] worker error", event.message, event.filename, event.lineno, event)
      reject(new WalletError("unknown", event.message || "The proving worker did not load."))
    }
    worker.postMessage(req)
  }).finally(() => worker.terminate())
}

/** Proves that `signature` comes from a past user, for the subject `owner`. */
export async function provePastUser(
  config: WebWalletConfig,
  req: { signature: Hex; owner: Hex },
): Promise<{ proof: Hex; publicInputs: string[] }> {
  const reply = await inWorker({
    kind: "prove",
    ...req,
    leavesUrl: pastUserLeavesUrl(config),
    ios: iosSettings(),
  })
  if (!("proof" in reply)) throw new WalletError("unknown", "The proving worker gave no proof.")
  return reply
}

/** Whether `address` is on the past-user list. The address stays in this browser. */
export async function lookupPastUser(config: WebWalletConfig, address: Hex): Promise<boolean> {
  const reply = await inWorker({
    kind: "lookup",
    address,
    leavesUrl: pastUserLeavesUrl(config),
    ios: iosSettings(),
  })
  return "eligible" in reply && reply.eligible
}
