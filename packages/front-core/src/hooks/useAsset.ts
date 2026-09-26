import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AccountStorage,
  BalanceStorage,
  TokenStorage,
  WalletSyncCoordinator,
  balanceScope,
  getTokenServiceFactory,
} from "src/core"
import {
  TokenService,
  Token,
  ContractService,
  ContractName,
  Network,
  TeeSignerNotApprovedError,
  onTeeSignerRefused,
  tokenDecimalsForNetwork,
  type TeeSigner,
} from "@obsidion/sdk"
import { type TeeSignerSource } from "src/tee/teeSignerSource"
import { Asset } from "src/types"
import { useCachedRecords } from "./useCachedRecords"
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

  const [tokenService, setTokenService] = useState<TokenService | null>(null)
  const [teeSigner, setTeeSignerState] = useState<TeeSigner | undefined>(undefined)
  // Last connect failure; cleared by the next successful connect so the UI can say why payments
  // are unavailable while the retry loop runs.
  const [teeSignerError, setTeeSignerError] = useState<Error | null>(null)
  const [globalTokens, setGlobalTokens] = useState<Token[]>([])

  // Read through a nullable accessor: `tokenAddress` throws before the address
  // resolves, and optional chaining does not guard a throwing getter.
  const activeTokenAddress = useMemo(
    () => tokenService?.tokenAddressOrNull?.toString() ?? null,
    [tokenService],
  )

  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [assetsLoading, setAssetsLoading] = useState(false)

  // Bumped when TokenService init fails so the effect below retries —
  // otherwise a rejected `TokenService.create` leaves `tokenService` null
  // forever (the effect deps never change again). Retries back off
  // exponentially (4s doubling to a 60s cap).
  const [tokenInitRetryTick, setTokenInitRetryTick] = useState(0)
  const retryAttemptRef = useRef(0)

  // True once a balance read from THIS session has landed in the store. Cache-hydrated rows from
  // an earlier session deliberately do not set it: consumers gate balance-dependent UI (overspend
  // checks) on live-confirmed values only.
  const [liveAssetsLoaded, setLiveAssetsLoaded] = useState(false)
  const sessionStartRef = useRef(Date.now())

  // Bumped once the init effect has persisted the wallet token's row, so the derivation below
  // re-reads TokenStorage (web never populates it otherwise).
  const [tokenRowsVersion, setTokenRowsVersion] = useState(0)

  // Store-driven assets: BalanceStorage is written by WalletSyncCoordinator on every synced tick
  // and hydrates from cache on cold start, so a returning user sees their previous balance while
  // wallet/PXE init and the first tick are in flight. The hook only projects the store.
  const balanceStorage = useMemo(() => BalanceStorage.get(), [])
  const { records: cachedBalances, hydrated: balancesHydrated } = useCachedRecords(balanceStorage)

  useEffect(() => {
    if (!balancesHydrated || !currentNetwork) return
    let cancelled = false
    void (async () => {
      const account = await AccountStorage.get().getAccount()
      if (!account || cancelled) return
      const scope = balanceScope(currentNetwork.type, account.completeAddress)
      const balances: { [key: string]: bigint } = {}
      let live = false
      for (const record of cachedBalances) {
        if (record.scope !== scope) continue
        try {
          balances[record.tokenAddress] = BigInt(record.balance)
        } catch {
          continue // corrupt record — skip rather than poison the whole projection
        }
        if ((record.updatedAt ?? 0) >= sessionStartRef.current) live = true
      }
      // Nothing known for this scope shows loading, not a fabricated $0 — and never the previous
      // scope's balance after an account or network switch.
      const tokens = Object.keys(balances).length ? await TokenStorage.get().getTokens() : []
      if (cancelled) return
      if (tokens.length === 0) {
        setAssets(null)
        setLiveAssetsLoaded(false)
        return
      }
      setAssets(
        tokens
          .map((token) => createAssetWithBalance(token, balances))
          .filter((asset) => asset.balance > 0)
          .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      )
      setLiveAssetsLoaded(live)
    })()
    return () => {
      cancelled = true
    }
  }, [balancesHydrated, cachedBalances, currentNetwork, obsidionAccount, tokenRowsVersion])

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
      setTokenService(newTokenService)

      // Correct stale persisted decimals before the row is read by the projection above — see
      // refreshStalePersistedTokenDecimals.
      await refreshStalePersistedTokenDecimals()
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
      if (!cancelled) setTokenRowsVersion((v) => v + 1)
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
  // The connect effect's `connect`, for a reconnect requested outside it.
  const reconnectRef = useRef<(() => void) | null>(null)
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
        // Non-secret connect log for smoke debugging (the signer's eth
        // address is public via the on-chain portal binding).
        logger.log("[useAsset] TEE signer connected", {
          ethAddress: signer.ethAddress.toString(),
          source: teeSignerSource.label,
        })
        setTeeSignerState(signer)
        setTeeSignerError(null)
      } catch (err) {
        if (!active || gen !== generation) return
        const delay = Math.min(4000 * 2 ** retryAttempt, 60_000)
        retryAttempt += 1
        setTeeSignerError(err instanceof Error ? err : new Error(String(err)))
        if (err instanceof TeeSignerNotApprovedError) {
          logger.warn(
            `[useAsset] TEE signer refused: enclave not approved on the token; retrying in ${
              delay / 1000
            }s`,
            { enclave: err.enclaveAddress.toString(), token: err.tokenAddress.toString() },
          )
        } else {
          logger.warn(`[useAsset] TEE signer connect failed; retrying in ${delay / 1000}s:`, err)
        }
        // teeSigner stays undefined until a retry lands; signing ops throw
        // via getTeeSigner(). Also ask the source to re-fetch (single-flight)
        // so the retry connects against a fresh snapshot.
        teeSignerSource.refresh?.()
        retryTimer = setTimeout(() => void connect(), delay)
      }
    }

    void connect()
    reconnectRef.current = () => void connect()
    const unsubscribe = teeSignerSource.subscribe?.(() => void connect())
    return () => {
      active = false
      reconnectRef.current = null
      if (retryTimer) clearTimeout(retryTimer)
      unsubscribe?.()
    }
  }, [teeSignerSource])

  // `signTokenOperation` re-pins to another enclave when the pinned one goes away, and the finalizer
  // refuses the replacement when the token has not approved it. Nothing else refuses this signer
  // again (its signing calls succeed), so the refusal drops it here: submissions fail closed until
  // the connect loop, with its approval check and backoff, lands an approved enclave.
  useEffect(() => {
    if (!teeSigner) return
    return onTeeSignerRefused((signer, err) => {
      if (signer !== teeSigner) return
      logger.warn("[useAsset] TEE signer refused at sign time: enclave not approved on the token", {
        enclave: err.enclaveAddress.toString(),
        token: err.tokenAddress.toString(),
      })
      setTeeSignerError(err)
      reconnectRef.current?.()
    })
  }, [teeSigner])

  // Fan the connected signer into the token service; the cleanup drops it from the service that
  // held it, so a stale signer never survives a reconnect or a service reused after a config switch.
  useEffect(() => {
    if (!tokenService || !teeSigner) return
    tokenService.setTeeSigner(teeSigner)
    return () => tokenService.setTeeSigner(undefined)
  }, [tokenService, teeSigner])

  // Keep track of all tokens
  useEffect(() => {
    const loadGlobalTokens = async () => {
      if (!tokenService) return

      // Get all registered tokens
      const allTokens = new Set<string>()

      // Get all tokens from TokenStorage
      const tokens = await TokenStorage.get().getTokens()

      // Add all tokens to the set
      tokens.forEach((token) => {
        allTokens.add(JSON.stringify(token))
      })

      const processedTokens = Array.from(allTokens).map((tokenStr) => {
        const token = JSON.parse(tokenStr)
        const constAssetParams = assetConstants[token.symbol as keyof AssetConstants]
        return {
          // Token's own decimals win, matching createAssetWithBalance so effective
          // decimals don't depend on which path built the asset. The active token's
          // persisted decimals are refreshed to the live resolver value on init (see
          // refreshStalePersistedTokenDecimals); an old-address record keeps its real (possibly 6-dp) scale.
          ...constAssetParams,
          ...token,
        }
      })
      setGlobalTokens(processedTokens)
    }
    loadGlobalTokens()
  }, [tokenService])

  // Correct stale persisted DECIMALS for the ACTIVE token before it is read into
  // the asset set. An upgraded install can carry a pre-cutover row against the
  // current token address with 6-dp decimals (it touched staging on a 6-dp
  // build); left alone that wins in createAssetWithBalance and mis-scales
  // paylink escrow amounts by 10^12. Scoped to the active oxideToken address
  // ONLY — a symbol/name match would wrongly rewrite a legitimately different
  // old-address record. Best-effort: any failure (address unresolved, storage
  // error) is swallowed so a refresh can never block asset loading.
  //
  // Display identity is deliberately NOT repaired here. createAssetWithBalance
  // takes name/symbol/logo from the asset constant, so a row naming an older
  // token already renders correctly, and rewriting it would turn a display
  // change into a silent migration of stored records. Decimals are different:
  // they are arithmetic, not presentation, and the row's value legitimately
  // wins downstream, so a wrong one has to be corrected at the source.
  const refreshStalePersistedTokenDecimals = async () => {
    const network = currentNetwork?.type
    if (!network) return
    try {
      const activeAddress = await ContractService.getInstance().getContractAddress("oxideToken")
      if (!activeAddress) return
      const addressStr = activeAddress.toString()
      const liveDecimals = tokenDecimalsForNetwork(network)
      const persisted = (await TokenStorage.get().getTokens()).find((t) => t.address === addressStr)
      if (persisted && persisted.decimals !== liveDecimals) {
        await TokenStorage.get().addToken({ ...persisted, decimals: liveDecimals })
      }
    } catch (error) {
      logger.warn("[useAsset] persisted token-row refresh skipped:", error)
    }
  }

  /** Sync the chain view now; the balance lands through the store projection above. */
  const loadAssets = useCallback(async () => {
    setAssetsLoading(true)
    try {
      await WalletSyncCoordinator.refresh()
    } finally {
      setAssetsLoading(false)
    }
  }, [])

  const createAssetWithBalance = (token: Token, balances: { [key: string]: bigint }) => {
    const constAssetParams = matchTokenToAssetConstant(token)
    const balanceAtomic = balances[token.address] ?? 0n
    // A token's own decimals win over the network-derived constants, so each
    // token renders at its real scale. The active token's persisted decimals are
    // refreshed to the live resolver value on init (see
    // refreshStalePersistedTokenDecimals) before this runs, so an upgraded install's
    // stale 6-dp row can't shadow the 18-dp source here.
    const decimals = token.decimals ?? constAssetParams?.decimals ?? 0
    const balance = decimals > 0 ? Number(balanceAtomic) / 10 ** decimals : Number(balanceAtomic)

    return {
      ...constAssetParams,
      ...token,
      // Display identity comes from the constant, never from the row. A row
      // written under an older token name would otherwise keep that name — and
      // its logo — on screen. Address, decimals and balances stay the row's:
      // they identify and scale it, and the spread order above is what lets a
      // token's own decimals win.
      name: constAssetParams.name,
      symbol: constAssetParams.symbol,
      logo: constAssetParams.logo,
      balance,
      balanceAtomic,
      publicBalance: 0,
      privateBalance: balance,
    }
  }

  // Helper function to match tokens to asset constants by symbol and name
  const matchTokenToAssetConstant = (token: Token) => {
    // 1. First try direct symbol match (case-sensitive)
    let assetConstant = assetConstants[token.symbol as keyof AssetConstants]

    if (assetConstant) return assetConstant

    // 2. Try case-insensitive symbol match
    const symbolUpper = token.symbol.toUpperCase()
    for (const key in assetConstants) {
      if (key.toUpperCase() === symbolUpper) {
        return assetConstants[key as keyof AssetConstants]
      }
    }

    // 3. Default to unknown if no matches found
    return assetConstants.ANY
  }

  return {
    // services
    tokenService,
    /** The live token contract address, or null before it resolves. */
    activeTokenAddress,
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

    // assets
    assets,
    setAssets,
    loadAssets,
    assetsLoading,
    /** True once a balance read from this session landed in the store; false while assets
     *  hold only cache-hydrated values. Balance-gated UI keys off this. */
    liveAssetsLoaded,
    globalTokens,
  }
}
