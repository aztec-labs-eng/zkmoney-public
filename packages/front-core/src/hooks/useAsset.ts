import { useEffect, useMemo, useRef, useState } from "react"
import {
  AccountStorage,
  BalanceStorage,
  TokenStorage,
  WalletSyncCoordinator,
  bootPriority,
  getTokenServiceFactory,
} from "src/core"
import { createBalances } from "src/engine/balances"
import { memoryStore, derived } from "src/engine/store"
import { useStore } from "./useStore"
import {
  TokenService,
  ContractService,
  ContractName,
  Network,
  type RegisteredTeeSigner,
} from "@obsidion/sdk"
import { type TeeSignerSource } from "src/tee/teeSignerSource"
import { useAccountContext, useAztecContext } from "src/contexts"
import { resolveAssetConstants, type AssetConstants } from "src/utils"
import { isWalletTokenSymbol } from "src/utils/tokenIdentity"
import { logger } from "src/utils/logger"

// Bounds one TEE connect attempt (enclave attestation fetch + L1 binding
// reads, possibly through proxies) so a hung fetch becomes a retryable
// failure instead of a permanently disconnected signer.
const TEE_CONNECT_TIMEOUT_MS = 60_000

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

// Corrects the active token row's stale decimals from its immutables: an upgraded install can hold
// a 6-dp row for the current 18-dp address, which mis-scales amounts by 10^12. Keyed on the active
// address only, so an old address keeps its real scale. Throws when the metadata or storage cannot
// be read.
async function refreshStalePersistedTokenDecimals(service: TokenService): Promise<void> {
  const activeAddress = await ContractService.getInstance().getContractAddress("oxideToken")
  if (!activeAddress) return
  const addressStr = activeAddress.toString()
  const liveDecimals = (await service.fetchTokenInformation()).decimals
  const persisted = (await TokenStorage.get().getTokens()).find((t) => t.address === addressStr)
  if (!persisted || persisted.decimals === liveDecimals) return
  await TokenStorage.get().addToken({ ...persisted, decimals: liveDecimals })
}

export type UseAssetOptions = {
  initialTokensToLoad?: string[]
  /** Bridge-relayer URL for fetching the relayer's L2 sender address */
  relayerUrl?: string
  /** Extra headers sent on every relayer request (e.g. dev tier's edge shared-secret). */
  relayerHeaders?: Record<string, string>
  /** Injectable source for the background TEE signer connect (attested oxide
   *  enclave on testnet/mainnet, local relayer proxy on sandbox). The hook is
   *  environment-agnostic — the app picks the source. **Must be a stable
   *  reference** (module-level or memoised); the connect effect re-runs when
   *  this changes, so a per-render new object would reconnect every render.
   *  Omit to skip the TEE connect entirely. */
  teeSignerSource?: TeeSignerSource
}

export const useAsset = (options?: UseAssetOptions) => {
  const { obsidionWallet, currentNetwork } = useAztecContext()
  const { obsidionAccount } = useAccountContext()

  // Per-network display/decimals table. `currentNetwork` is always set before
  // any asset work runs (wallet init gates on it), so the fallback is an inert
  // placeholder for the pre-network render.
  const assetConstants = resolveAssetConstants(currentNetwork?.type ?? Network.SANDBOX)

  // A store, so the balances read the token address the moment the service resolves.
  const [tokenServiceStore] = useState(() => memoryStore<TokenService | null>(null))
  const tokenService = useStore(tokenServiceStore)
  // The service whose token row's decimals were checked against its immutables.
  const [decimalsCheckedStore] = useState(() => memoryStore<TokenService | null>(null))
  const decimalsCheckedFor = useStore(decimalsCheckedStore)
  const [teeSigner, setTeeSignerState] = useState<RegisteredTeeSigner | undefined>(undefined)
  // Last connect failure; cleared by the next successful connect so the UI can say why payments
  // are unavailable while the retry loop runs.
  const [teeSignerError, setTeeSignerError] = useState<Error | null>(null)

  // Bumped when TokenService init fails so the effect below retries —
  // otherwise a rejected `TokenService.create` leaves `tokenService` null
  // forever (the effect deps never change again). Retries back off
  // exponentially (4s doubling to a 60s cap).
  const [tokenInitRetryTick, setTokenInitRetryTick] = useState(0)
  const retryAttemptRef = useRef(0)

  // A session's balances: the coordinator's writes to BalanceStorage, from cache on cold start,
  // named by the stored account and token rows. Every write to those lands in their stores.
  const network = currentNetwork?.type ?? null
  const balances = useMemo(
    () =>
      createBalances(
        BalanceStorage.get(),
        {
          network,
          account: AccountStorage.get().current,
          tokens: TokenStorage.get().rows,
          // Read through a nullable accessor: `tokenAddress` throws before the address resolves.
          active: derived(
            [tokenServiceStore],
            (service) => service?.tokenAddressOrNull?.toString() ?? null,
          ),
          // No balance counts as live until the service has checked the row's decimals.
          decimalsPending: derived(
            [tokenServiceStore, decimalsCheckedStore],
            (service, checked) => !!service && service !== checked,
          ),
        },
        bootPriority.balanceSync,
      ),
    [network, tokenServiceStore, decimalsCheckedStore],
  )

  // Initialize services and persist the wallet token's row
  useEffect(() => {
    if (!obsidionWallet || !obsidionAccount) return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const initializeTokenService = async () => {
      if (tokenService) {
        if (!tokenService.account.getAddress().equals(obsidionAccount.getAddress())) {
          await tokenService.setAccount(obsidionAccount)
        }
        return
      }
      // TokenService is single-asset (the consolidated oxideToken) —
      // no token name to pass. The relayer-sender registration side effect
      // is preserved via the `relayerUrl` positional arg.
      // Generation seam: a v4-canonical device constructs the v4-origin
      // TokenService (see setTokenServiceFactory).
      // TODO: pass real AttestedLedger once available in front-core
      const factory = getTokenServiceFactory()
      const newTokenService = factory
        ? await factory({
            wallet: obsidionWallet,
            account: obsidionAccount,
            relayerUrl: options?.relayerUrl,
            relayerHeaders: options?.relayerHeaders,
          })
        : await TokenService.create(
            obsidionWallet,
            obsidionAccount,
            undefined,
            undefined,
            options?.relayerUrl,
            options?.relayerHeaders,
          )
      const tokenStorage = TokenStorage.get()
      const stored = await tokenStorage.getTokens()
      for (const symbol of options?.initialTokensToLoad ?? []) {
        // initialTokensToLoad carries DISPLAY symbols; map to the contract
        // identity for address resolution. The ticker is the oxideToken's
        // display symbol, not a ContractName, and superseded tickers resolve
        // here too so a caller pinned to an older one still finds the token.
        const contractName: ContractName = isWalletTokenSymbol(symbol)
          ? "oxideToken"
          : (symbol as ContractName)
        const addr = await ContractService.getInstance().getContractAddress(contractName)
        const constEntry = assetConstants[symbol as keyof AssetConstants]
        if (!addr || !constEntry || stored.some((t) => t.address === addr.toString())) continue
        await tokenStorage.addToken({
          address: addr.toString(),
          name: constEntry.name,
          symbol: constEntry.symbol,
          decimals: constEntry.decimals,
        })
      }
      // Published once the rows exist: the decimals repair it starts checks the row this loop writes.
      tokenServiceStore.set(newTokenService)
    }

    initializeTokenService()
      .then(() => {
        retryAttemptRef.current = 0
      })
      .catch((err) => {
        if (cancelled) return
        const delay = Math.min(4000 * 2 ** retryAttemptRef.current, 60_000)
        retryAttemptRef.current += 1
        logger.warn(`[useAsset] token service init failed; retrying in ${delay / 1000}s:`, err)
        retryTimer = setTimeout(() => setTokenInitRetryTick((t) => t + 1), delay)
      })

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
    // Options and the network's constants are fixed for the provider's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obsidionWallet, tokenService, obsidionAccount, tokenInitRetryTick])

  // Connect the TEE signer in the background, with no account behind it: a visitor cashing a paylink
  // out has a signer source and no `TokenService`. The signer fans into the token service below.
  //
  // The hook is environment-agnostic: it drives whatever `teeSignerSource` is injected. `load()`
  // returns `undefined` for a benign skip and throws for a real failure. `subscribe` lets a source
  // (e.g. the oxide manifest) request a reconnect; a `generation` token discards a connect
  // superseded by a newer one.
  //
  // Failure recovery cannot lean on `subscribe` alone: the oxide client only ticks it when the
  // manifest tuple CHANGES, so on a static manifest (sandbox, e2e) a single transient connect
  // failure would otherwise leave the signer disconnected until app restart. A failed connect
  // therefore self-retries with backoff (4s doubling to a 60s cap), and each attempt is bounded by
  // a watchdog so a hung fetch also feeds the retry loop.
  //
  // Each connect clears the signer first, so a prior one cannot linger across a source or manifest
  // change. In-flight signing ops resolve lazily via `getTeeSigner()`, so an op mid-proving when a
  // roll lands fails at submit and the user retries — accepted (rolls are rare).
  const teeSignerSource = options?.teeSignerSource
  useEffect(() => {
    setTeeSignerState(undefined)
    setTeeSignerError(null)
    if (!teeSignerSource) return

    let active = true
    let generation = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryAttempt = 0
    const connect = async () => {
      const gen = ++generation
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      // A manifest roll fires `subscribe` → `connect` without re-running the effect, so the clear
      // happens here, per attempt.
      setTeeSignerState(undefined)
      try {
        const signer = await withTimeout(
          teeSignerSource.load(),
          TEE_CONNECT_TIMEOUT_MS,
          "TEE signer connect",
        )
        if (!active || gen !== generation || !signer) return
        retryAttempt = 0
        // Non-secret connect log for smoke debugging (the registry is public on L1).
        logger.log("[useAsset] TEE signer connected", {
          teeRegistry: signer.teeRegistry.toString(),
          source: teeSignerSource.label,
        })
        setTeeSignerState(signer)
        setTeeSignerError(null)
      } catch (err) {
        if (!active || gen !== generation) return
        const delay = Math.min(4000 * 2 ** retryAttempt, 60_000)
        retryAttempt += 1
        setTeeSignerError(err instanceof Error ? err : new Error(String(err)))
        logger.warn(`[useAsset] TEE signer connect failed; retrying in ${delay / 1000}s:`, err)
        // teeSigner stays undefined until a retry lands; signing ops throw
        // via getTeeSigner(). Also ask the source to re-fetch (single-flight)
        // so the retry connects against a fresh snapshot.
        teeSignerSource.refresh?.()
        retryTimer = setTimeout(() => void connect(), delay)
      }
    }

    void connect()
    const unsubscribe = teeSignerSource.subscribe?.(() => void connect())
    return () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribe?.()
    }
  }, [teeSignerSource])

  // Fan the connected signer into the token service; the cleanup drops it from the service that
  // held it, so a stale signer never survives a reconnect or a service reused after a config switch.
  useEffect(() => {
    if (!tokenService || !teeSigner) return
    tokenService.setTeeSigner(teeSigner)
    return () => tokenService.setTeeSigner(undefined)
  }, [tokenService, teeSigner])

  // The rows render without waiting on the token's metadata read; a repaired row lands in the token
  // rows' store. A failed read retries with the init effect's backoff.
  useEffect(() => {
    if (!tokenService) return
    let active = true
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const repair = (attempt: number) =>
      refreshStalePersistedTokenDecimals(tokenService).then(
        () => {
          if (active) decimalsCheckedStore.set(tokenService)
        },
        (error) => {
          if (!active) return
          const delay = Math.min(4000 * 2 ** attempt, 60_000)
          logger.warn(
            `[useAsset] token decimals check failed; retrying in ${delay / 1000}s:`,
            error,
          )
          retryTimer = setTimeout(() => void repair(attempt + 1), delay)
        },
      )
    void repair(0)
    return () => {
      active = false
      clearTimeout(retryTimer)
    }
  }, [tokenService, decimalsCheckedStore])

  return {
    // services
    tokenService,
    /**
     * Connected TEE signer or `undefined` while loading / on connect
     * failure. Consumers that need to drive TEE-signed flows from a
     * separately-constructed `PaylinkService` should subscribe to this
     * via `useAssetContext()` and
     * call `service.setTeeSigner(teeSigner)` reactively — passing
     * `undefined` clears any stale signer when the underlying config
     * changes (network / account / portal switch).
     */
    teeSigner,
    /**
     * Why the last TEE connect failed, or `null` after a successful one. A
     * `TeeSignerNotApprovedError` means the fleet handed out an enclave the token
     * has not approved; the connect keeps retrying until an approved one is pinned.
     */
    teeSignerError,

    balances,
    /** The active token row's decimals were checked against its immutables. */
    decimalsChecked: !!tokenService && decimalsCheckedFor === tokenService,
    /** Sync the chain view now; the balance lands through `balances`. */
    loadAssets: WalletSyncCoordinator.refresh,
  }
}
