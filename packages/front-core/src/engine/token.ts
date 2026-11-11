import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  RegisteredTeeSigner,
  TokenService,
} from "@obsidion/sdk"
import type { TeeSignerSource } from "../tee/teeSignerSource"
import { logger } from "../utils/logger"
import { within } from "./runtime"
import { service, valueOf, type Backoff, type Service, type ServiceState } from "./service"
import type { ReadonlyStore } from "./store"

const RETRY: Backoff = { baseMs: 4_000, maxMs: 60_000 }
/** Bounds one connect: an enclave attestation fetch and the L1 binding reads, maybe through proxies. */
const TEE_CONNECT_MS = 60_000

/** Settles only by rejecting once `signal` aborts: a build with nothing to build yet stays pending. */
const pendingUntilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))

/**
 * The TEE co-signer, connected with no account behind it: a visitor cashing a link out signs too.
 * It connects while `when` holds. A source change, such as a manifest roll, reconnects it; a failed
 * connect asks the source to refresh before the retry.
 */
export function openTeeSigner(
  source: TeeSignerSource,
  when: ReadonlyStore<boolean>,
): Service<RegisteredTeeSigner> {
  /** Heard from the first connect on, once: the source can follow its manifest only by then. */
  let heard: (() => void) | undefined
  const signer: Service<RegisteredTeeSigner> = service(
    "teeSigner",
    { from: [], when, retry: RETRY },
    async (_, signal) => {
      heard ??= source.subscribe?.(() => signer.retry())
      try {
        const connected = await within(source.load(), "TEE signer connect", {
          ms: TEE_CONNECT_MS,
          signal,
        })
        if (!connected) return pendingUntilAborted(signal)
        logger.log("[teeSigner] connected", {
          teeRegistry: connected.teeRegistry.toString(),
          source: source.label,
        })
        return connected
      } catch (error) {
        if (!signal.aborted) source.refresh?.()
        throw error
      }
    },
  )
  return { ...signer, close: () => (heard?.(), signer.close()) }
}

export interface TokenDeps {
  wallet: Service<ObsidionWallet>
  account: Service<ObsidionAccount>
  /** The token's contracts resolve through it. */
  contractService: Service<ContractService>
  teeSigner: ReadonlyStore<ServiceState<RegisteredTeeSigner>>
  /** Builds only while true. */
  when: ReadonlyStore<boolean>
  create(wallet: ObsidionWallet, account: ObsidionAccount): Promise<TokenService>
}

/** The wallet token's service, with its metadata read and the current TEE signer attached. */
export function openToken(deps: TokenDeps): Service<TokenService> {
  return service(
    "token",
    {
      from: [deps.wallet, deps.account, deps.contractService],
      when: deps.when,
      retry: RETRY,
    },
    async ([wallet, account], signal) => {
      const token = await within(deps.create(wallet, account), "token", { signal })
      await within(token.fetchTokenInformation(), "token metadata", { signal })
      let attached = valueOf(deps.teeSigner)
      token.setTeeSigner(attached)
      const off = deps.teeSigner.subscribe(() => {
        const next = valueOf(deps.teeSigner)
        if (next !== attached) token.setTeeSigner((attached = next))
      })
      signal.addEventListener("abort", () => (off(), token.setTeeSigner(undefined)))
      return token
    },
  )
}
