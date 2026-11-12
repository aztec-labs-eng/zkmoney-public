/**
 * The page's one owner of a rotated wallet's previous one-key account: it finds the account from
 * the session's record, registers it, runs the check and the move Settings → Account history asks
 * for, and publishes one state for that sheet.
 */
import { WalletError } from "@obsidion/core/errors"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import {
  bestEffort,
  deriveBootstrapKey,
  isDust,
  memoryStore,
  movePreviousBalance,
  planMove,
  previousRootKey,
  resolveOxideIdentity,
  txOutcome,
  unreadDeposits,
  valueOf,
  type PreviousMoveDeps,
  type PreviousMoveResult,
  type TxOutcome,
} from "@obsidion/front-core"
import {
  normalizePubkeyHex,
  readSpendShape,
  type AlphaAuthProvider,
  type ObsidionAccount,
  type ObsidionWallet,
  type RecoveryMetadata,
} from "@obsidion/sdk"
import { getWebOxideToken } from "../../config/classArtifacts"
import type { PreviousAccountParts } from "../../session/session"
import { usdAtomicFloor } from "../../ui/format"
import { claimSponsorContext } from "../registration/claimSponsorship"
import { loadOxideGenerations } from "../registration/oxideGenerations"
import { RAIL_REGISTERED } from "../registration/rails"
import { unlockedSessionKeys } from "../registration/registrationResume"
import { singleKeyAccount } from "../registration/sponsorAccounts"
import { l2TokenService } from "../token/l2TokenService"
import { backupMoveTokens, moveCap } from "./backupMoveTokens"
import { sponsoredTokenService, walletOutcomeNode } from "./backupPasskeyRuntime"

/** How a move ended, or the error that ended it. */
export type PreviousMoveOutcome = PreviousMoveResult | { kind: "failed"; error: unknown }

/** A token the previous account held at the last check. */
export interface PreviousHolding {
  kind: "main" | "savings"
  /** Atomic units of Main's token, or Savings' shares. */
  amount: bigint
  /** The smallest amount worth a move. */
  dust: bigint
  /** Savings' shares priced in Main's unit; absent when no price could be read. */
  value?: bigint
}

/** One balance of a move run. */
export interface MoveRunRow {
  kind: PreviousHolding["kind"]
  /** Transfers of this run that moved funds. */
  moved: number
  /** `preparing` from a transfer's start, `confirming` once it is out; absent between transfers. */
  phase?: "preparing" | "confirming"
  /** Its pass ended with nothing left to move. */
  done?: boolean
}

export interface MoveRun {
  /** The balances the run moves, in order. */
  rows: readonly MoveRunRow[]
  /** Transfers the run started, each asking for one approval. */
  approvals: number
  /** A transfer an earlier run left in flight is being resolved; it belongs to no row. */
  earlier?: boolean
}

export interface MoveForecast {
  approvals: number
  /** `approvals` is an upper bound. */
  upper: boolean
}

/** What a move's send sequence reports as it goes. */
interface MoveWatch {
  sending(): void
  sent(txHash: string): void
  asked(txHash: string): void
  settled(txHash: string, outcome: TxOutcome): void
}

/** Checkpointed or final, moved or not: the wait for this transfer is over. */
const resolved = (outcome: TxOutcome) =>
  outcome.kind === "included"
    ? outcome.checkpointed
    : outcome.kind === "mined" || outcome.kind === "reverted" || outcome.kind === "dead"

const movedFunds = (outcome: TxOutcome) =>
  outcome.kind === "mined" || (outcome.kind === "included" && outcome.effect === "success")

/**
 * A run at rest: no transfer in flight. A balance it moved from is done once `holdings`, read
 * after the run, show only dust left of it, though its pass stopped before saying so.
 */
const atRest = (
  { rows, approvals }: MoveRun,
  holdings?: readonly PreviousHolding[],
): MoveRun => ({
  rows: rows.map(({ kind, moved, done }) => {
    const left = holdings?.find((holding) => holding.kind === kind)
    const emptied = moved > 0 && left !== undefined && isDust(left.amount, left.dust)
    return { kind, moved, ...((done || emptied) && { done: true }) }
  }),
  approvals,
})

export interface PreviousAccountState {
  /** The previous account; absent while none is found. */
  address?: string
  /** What the last complete read found, Main first; absent before one. */
  holdings?: readonly PreviousHolding[]
  /** The last check's claims pass fell short, so deposits may still wait there unclaimed. */
  claimsIncomplete?: boolean
  checking: boolean
  /** The last check threw before it finished. */
  checkFailed?: boolean
  /** The session signs for it: the session's key is its root key. */
  signs: boolean
  moving: boolean
  /** The move running, or the last one that ended early; a check or a finished move clears it. */
  run?: MoveRun
  /** The approvals moving the holdings takes, where it could be planned. */
  forecast?: MoveForecast
  /** The last move ended with everything moved; the next check clears it. */
  moved?: boolean
  lastResult?: PreviousMoveOutcome
  /** Spend refusals in a row, and the chunk cap the next move takes after one. */
  refusals: number
  cap?: bigint
}

const NONE: PreviousAccountState = { signs: false, moving: false, checking: false, refusals: 0 }

/** How long a move that ended waits for its holdings read before it shows as over. */
const REFRESH_WAIT_MS = 15_000

/** The smallest amount `usdAtomicFloor`, Home's balance figure, shows as more than nothing. */
export function dustFloor(decimals: number): bigint {
  const zero = usdAtomicFloor(0n, decimals)
  let unit = 1n
  while (usdAtomicFloor(unit, decimals) === zero) unit *= 10n
  return unit
}

/** The previous account as a session found it. */
interface Previous {
  wallet: ObsidionWallet
  session: PreviousAccountParts["session"]
  /** The session signer it was found under. */
  signer: AlphaAuthProvider
  record: RecoveryMetadata
  root: string
  address: AztecAddress
  signs: boolean
  registered?: Promise<ObsidionAccount>
  tokens?: Promise<HeldToken[]>
  dust: Map<string, Promise<bigint>>
}

/**
 * A token a rotated wallet's previous account can hold: Main's, and Savings' shares, which a
 * payment to one of its old Savings deposit addresses lands as.
 */
interface HeldToken {
  kind: PreviousHolding["kind"]
  l2Token: string
}

/** One session signer on a wallet, and the previous account it found. */
interface Life {
  wallet: ObsidionWallet
  signer?: AlphaAuthProvider
  parts: PreviousAccountParts
  found: Promise<Previous | undefined>
}

type Streak = Pick<PreviousAccountState, "refusals" | "cap">

export class PreviousAccountWatcher {
  private readonly store = memoryStore(NONE)
  /** What Settings → Account history shows. */
  readonly state = this.store.readonly
  private life?: Life
  /** The streak at the last stop, so a lock doesn't undo the stop after three refusals. */
  private kept?: Streak & { address: string }
  private parts?: PreviousAccountParts
  /** The check running, joined by a second call; dropped when the session ends. */
  private checkRun?: Promise<void>
  /** The move run, held until all its work settled, across a stop and the next session. */
  private running?: Promise<PreviousMoveOutcome>
  /** The running move once its session ended: waited out, never joined or shown. */
  private stale?: Promise<PreviousMoveOutcome>
  private abortRun?: AbortController

  /** Serves the session whose parts these are. The answer lets go of it. */
  serve(parts: PreviousAccountParts): () => void {
    this.parts = parts
    return () => {
      if (this.parts === parts) this.parts = undefined
      this.stop()
    }
  }

  /** Lets go of the session: a running move stops before its next prompt. */
  stop(): void {
    this.life = undefined
    this.checkRun = undefined
    this.endRun()
    const { address, refusals, cap } = this.store.get()
    if (address) this.kept = { address, refusals, cap }
    this.store.set(NONE)
  }

  /** The previous account of the session signed in on `wallet`, saved for the feed and the bell. */
  async locate(wallet: ObsidionWallet): Promise<string | undefined> {
    return (await (await this.current(wallet)).found)?.address.toString()
  }

  /**
   * The previous account once registered under the session's key, so the PXE reads its events.
   * Throws when a new session takes over meanwhile: its answer comes soon, not at the next cadence.
   */
  async registeredAddress(wallet: ObsidionWallet): Promise<string | undefined> {
    const life = await this.current(wallet)
    const previous = await life.found
    if (!previous) return undefined
    await this.registered(previous)
    if (life !== this.life) throw new WalletError("aborted", "a new session took over")
    return previous.address.toString()
  }

  /**
   * The deposits the account was paid, recorded for Activity with nothing claimed or published;
   * answers whether the scan read all. A wallet with no previous account has nothing to read.
   */
  async readHistory(wallet: ObsidionWallet): Promise<boolean> {
    const life = await this.current(wallet)
    const previous = await life.found
    if (!previous) return true
    await this.registered(previous)
    const history = await life.parts.pipeline?.historyFor(previous.address)
    return !!history?.completed
  }

  /**
   * The claims pass for the account's deposit addresses, then what it holds, published with how the
   * check went. A check already running is joined.
   */
  check(wallet: ObsidionWallet): Promise<void> {
    if (this.checkRun) return this.checkRun
    const run: Promise<void> = bestEffort("balance.unread", this.claimAndRead(wallet)).then(
      (read) => {
        if (this.checkRun !== run) return
        this.checkRun = undefined
        this.patch({ checking: false, checkFailed: !read })
        if (read) this.startForecast()
      },
    )
    this.checkRun = run
    this.forecasts++
    this.patch({ checking: true, moved: false, run: undefined, forecast: undefined })
    return run
  }

  /**
   * Moves what the previous account holds to the session's account, Main's token first. A move
   * already running is joined, so a second call never starts another; one an earlier session
   * started is waited out, then this one starts. `signal` stops it before its next prompt. After a
   * spend refusal each chunk stays under the state's `cap`.
   */
  move(opts: { signal?: AbortSignal } = {}): Promise<PreviousMoveOutcome> {
    if (this.running) {
      if (this.running !== this.stale) return this.running
      const again = () => this.move(opts)
      return this.running.then(again, again)
    }
    const controller = new AbortController()
    if (opts.signal?.aborted) controller.abort()
    opts.signal?.addEventListener("abort", () => controller.abort(), { once: true })
    const { cap } = this.state.get()
    const run: Promise<PreviousMoveOutcome> = this.runMove(this.life, cap, controller.signal)
      .catch((error: unknown) => ({ kind: "failed" as const, error }))
      .then(async (outcome) => {
        // The holdings are read before the move shows as over, so the sheet never offers the
        // moved funds again. A finished move whose read fell short drops the amounts it moved.
        const read = await this.refreshed()
        const done = outcome.kind === "done"
        const stale = this.stale === run
        if (stale) this.stale = undefined
        if (this.running === run) {
          this.running = undefined
          this.abortRun = undefined
        }
        const moving = !!this.running
        if (stale) {
          this.patch({ moving })
          return outcome
        }
        const state = this.state.get()
        this.patch({
          lastResult: outcome,
          moving,
          moved: done,
          run: done || !state.run ? undefined : atRest(state.run, read ? state.holdings : undefined),
          forecast: undefined,
          ...(done && !read ? { holdings: undefined } : {}),
          ...streak(state, outcome),
        })
        // After the cap is stored: the next move's count is planned under it.
        if (!done) this.startForecast()
        return outcome
      })
    this.running = run
    this.abortRun = controller
    this.forecasts++
    this.patch({ moving: true, moved: false, run: undefined })
    return run
  }

  /** The check's claims pass, then its read. A wallet with no previous account has nothing to read. */
  private async claimAndRead(wallet: ObsidionWallet): Promise<true> {
    const life = await this.current(wallet)
    const previous = await life.found
    if (!previous) return true
    const account = await this.registered(previous)
    const claims = await life.parts.pipeline?.passFor(previous.address, (l2Token) =>
      l2TokenService(life.parts.session.page, account, l2Token),
    )
    await this.read(life, previous, account)
    if (life === this.life) this.patch({ claimsIncomplete: !claims?.completed })
    return true
  }

  /** The life of the session signed in on `wallet`; a new signer or session starts a new one. */
  private async current(wallet: ObsidionWallet): Promise<Life> {
    const parts = this.parts
    if (!parts) throw new WalletError("invariant", "the previous-account watcher serves no session")
    const signer = (await parts.session.auth.sessionKeys())?.authProvider
    const life = this.life
    if (life?.wallet === wallet && life.signer === signer && life.parts === parts) return life
    if (life) this.endRun()
    const next: Life = { wallet, signer, parts, found: Promise.resolve(undefined) }
    this.life = next
    // An earlier lifetime's run and count are not this one's, even at the same address.
    this.forecasts++
    if (this.state.get().run || this.state.get().forecast)
      this.patch({ run: undefined, forecast: undefined })
    next.found = this.find(next)
    // A failed search is the caller's error; the next call searches again.
    next.found.catch(() => {
      if (this.life === next) this.life = undefined
    })
    return next
  }

  private endRun(): void {
    this.stale = this.running
    this.abortRun?.abort()
  }

  /** Clears the state and the saved address: the session's record names no previous account. */
  private async forget(life: Life): Promise<void> {
    await life.parts.saved.save(undefined)
    if (life === this.life && this.state.get() !== NONE) this.store.set(NONE)
  }

  /** The previous account of the session's record. */
  private async find(life: Life): Promise<Previous | undefined> {
    const { session } = life.parts
    const keys = await unlockedSessionKeys(session, life.wallet)
    if (!keys) {
      if (life === this.life && this.state.get() !== NONE) this.store.set(NONE)
      return undefined
    }
    const sessionAddress = keys.account.getAddress()
    const record = await session.auth.accountRecord(sessionAddress.toString())
    const root = record && previousRootKey(record)
    if (!record || !root) {
      await this.forget(life)
      return undefined
    }
    const address = await life.wallet.deriveAccountAddress(keys.secretKey, [root])
    if (address.equals(sessionAddress)) {
      await this.forget(life)
      return undefined
    }
    const previous: Previous = {
      wallet: life.wallet,
      session,
      signer: keys.authProvider,
      record,
      root,
      address,
      signs: normalizePubkeyHex(keys.pubkeyHex) === root,
      dust: new Map(),
    }
    const key = address.toString()
    await life.parts.saved.save(key)
    if (life === this.life) {
      const state = this.state.get()
      const same = state.address === key
      const { refusals, cap }: Streak = same ? state : this.kept?.address === key ? this.kept : NONE
      const { holdings, claimsIncomplete } = same ? state : NONE
      this.patch({ holdings, claimsIncomplete, address: key, signs: previous.signs, refusals, cap })
    }
    return previous
  }

  /** The previous account registered under the session's key. */
  private registered(previous: Previous): Promise<ObsidionAccount> {
    previous.registered ??= this.register(previous).catch((err: unknown) => {
      previous.registered = undefined
      throw err
    })
    return previous.registered
  }

  private register(previous: Previous): Promise<ObsidionAccount> {
    const { auth, page } = previous.session
    return singleKeyAccount(
      { wallet: previous.wallet, session: auth, registering: page.sponsors.registering },
      previous.record,
      previous.root,
      previous.signs ? "sign" : "held",
    )
  }

  /** What the account holds of each token, which syncs its notes. */
  private async read(life: Life, previous: Previous, account: ObsidionAccount): Promise<void> {
    const holdings = await Promise.all(
      (
        await tokensOf(previous)
      ).map(async (token): Promise<PreviousHolding> => {
        const service = await l2TokenService(previous.session.page, account,
          token.l2Token,
        )
        const [amount, dust] = await Promise.all([
          service.getBalance(),
          dustOf(previous, account, token),
        ])
        const value =
          token.kind === "savings" ? await savingsValue(life.parts.savings, amount) : undefined
        return { kind: token.kind, amount, dust, ...(value === undefined ? {} : { value }) }
      }),
    )
    if (life === this.life) this.patch({ holdings })
  }

  /** Reads the holdings again once a move ends. */
  private async refresh(): Promise<void> {
    const life = this.life
    const previous = await life?.found
    if (life && previous) await this.read(life, previous, await this.registered(previous))
  }

  /** Whether the holdings were read again within {@link REFRESH_WAIT_MS}. */
  private async refreshed(): Promise<boolean> {
    let timer: number | undefined
    const late = new Promise<undefined>((resolve) => {
      timer = window.setTimeout(resolve, REFRESH_WAIT_MS)
    })
    const read = bestEffort(
      "balance.unread",
      this.refresh().then(() => true),
    )
    try {
      return (await Promise.race([read, late])) === true
    } finally {
      clearTimeout(timer)
    }
  }

  private async runMove(
    life: Life | undefined,
    cap: bigint | undefined,
    signal: AbortSignal,
  ): Promise<PreviousMoveResult> {
    if (!life) throw new WalletError("account.locked", "no unlocked life to move from")
    const previous = await life.found
    // The sheet offers the move only once a check found funds there, on the first passkey.
    if (!previous) throw new WalletError("invariant", "no previous account to move from")
    if (!previous.signs) throw new WalletError("invariant", "a backup session cannot move it")
    const account = await this.registered(previous)
    const held = this.state.get().holdings
    // A token the last check found nothing worth moving in takes no pass.
    const tokens = (await tokensOf(previous)).filter((token) => {
      const holding = held?.find(({ kind }) => kind === token.kind)
      return !holding || !isDust(holding.amount, holding.dust)
    })
    let run: MoveRun = { rows: tokens.map(({ kind }) => ({ kind, moved: 0 })), approvals: 0 }
    const publish = (next: MoveRun) => {
      run = next
      if (life === this.life) this.patch({ run })
    }
    publish(run)
    /** The hashes this run sent, and the ones whose end it has counted. */
    const ours = new Set<string>()
    const counted = new Set<string>()
    for (const token of tokens) {
      const rows = (change: (row: MoveRunRow) => MoveRunRow) =>
        run.rows.map((row) => (row.kind === token.kind ? change(row) : row))
      const phase = () => run.rows.find((row) => row.kind === token.kind)?.phase
      const watch: MoveWatch = {
        sending: () =>
          publish({
            ...run,
            approvals: run.approvals + 1,
            rows: rows((row) => ({ ...row, phase: "preparing" })),
          }),
        sent: (txHash) => void ours.add(txHash),
        asked: (txHash) => {
          if (!ours.has(txHash)) {
            if (!run.earlier) publish({ ...run, earlier: true })
          } else if (phase() !== "confirming") {
            publish({ ...run, rows: rows((row) => ({ ...row, phase: "confirming" })) })
          }
        },
        // Counted once per hash, from what the chain says of it: a reverted or expired transfer
        // ends the wait and moves nothing.
        settled: (txHash, outcome) => {
          if (!resolved(outcome) || counted.has(txHash)) return
          counted.add(txHash)
          if (!ours.has(txHash)) return publish({ ...run, earlier: false })
          const more = movedFunds(outcome) ? 1 : 0
          publish({ ...run, rows: rows(({ kind, moved }) => ({ kind, moved: moved + more })) })
        },
      }
      const deps = await moveDeps(life.parts, previous, account, token, cap, signal, watch)
      const result = await movePreviousBalance(deps, signal)
      if (result.kind !== "done") return result
      publish({ ...run, rows: rows(({ kind, moved }) => ({ kind, moved, done: true })) })
    }
    return { kind: "done" }
  }

  /** Counts the forecasts started, so one a check or a move overtook is dropped. */
  private forecasts = 0

  /**
   * Plans the approvals a move takes, apart from every check and move: neither waits for it, and
   * one that fails or stalls leaves no count.
   */
  private startForecast(): void {
    const started = ++this.forecasts
    const life = this.life
    void bestEffort("balance.unread", this.planned(life)).then((forecast) => {
      if (started === this.forecasts && life === this.life && forecast) this.patch({ forecast })
    })
  }

  /** The move's plan over the balances worth moving, under the cap the move takes. */
  private async planned(life: Life | undefined): Promise<MoveForecast | undefined> {
    const previous = await life?.found
    // The shape is read only while no spend of the account is in flight.
    if (!life || !previous || !previous.signs || this.running) return undefined
    if (await life.parts.saved.move(previous.address.toString())) return undefined
    const { holdings, cap } = this.state.get()
    const worth = (holdings ?? []).filter(({ amount, dust }) => !isDust(amount, dust))
    const tokens = (await tokensOf(previous)).filter(({ kind }) => worth.some((h) => h.kind === kind))
    if (tokens.length === 0) return undefined
    const account = await this.registered(previous)
    const contractService = await previous.session.contractService.ready()
    const plans = await Promise.all(
      tokens.map(async (token) => {
        const [shape, most, dust] = await Promise.all([
          getWebOxideToken(previous.wallet, contractService, token.l2Token).then((oxide) =>
            readSpendShape(previous.wallet, oxide, account.getAddress()),
          ),
          cap ?? moveCap(previous.session.page.chain, token.l2Token),
          dustOf(previous, account, token),
        ])
        const plan = planMove(shape, most, unreadDeposits(shape))
        // The move stops once what is left is dust, so a last chunk of dust asks for nothing.
        let left = shape.balance
        let sends = 0
        for (const chunk of plan.chunks) {
          if (isDust(left, dust)) break
          left -= chunk.amount
          sends++
        }
        return { sends, upper: plan.bound === "upper" }
      }),
    )
    return {
      approvals: plans.reduce((n, plan) => n + plan.sends, 0),
      upper: plans.some((plan) => plan.upper),
    }
  }

  private patch(fields: Partial<PreviousAccountState>): void {
    this.store.set({ ...this.store.get(), ...fields })
  }
}

/** The refusal streak after a move: a spend refusal halves the next cap, a finished move resets it. */
function streak(state: PreviousAccountState, outcome: PreviousMoveOutcome): Streak {
  if (outcome.kind === "done") return { refusals: 0, cap: undefined }
  if (outcome.kind === "refused" && outcome.reason === "spend") {
    return { refusals: state.refusals + 1, cap: outcome.amount / 2n }
  }
  return { refusals: state.refusals, cap: state.cap }
}

/** The tokens a backup add moves, Main's first: the ones the previous account can hold. */
function tokensOf(previous: Previous): Promise<HeldToken[]> {
  previous.tokens ??= backupMoveTokens(previous.session.page.chain).then(
    (tokens) => tokens.map((l2Token, i) => ({ kind: i === 0 ? "main" : "savings", l2Token })),
    (err: unknown) => {
      previous.tokens = undefined
      throw err
    },
  )
  return previous.tokens
}

/** `token`'s dust floor, read once per account. */
function dustOf(previous: Previous, account: ObsidionAccount, token: HeldToken): Promise<bigint> {
  const key = token.l2Token.toLowerCase()
  let dust = previous.dust.get(key)
  if (!dust) {
    dust = l2TokenService(previous.session.page, account, token.l2Token).then(
      async (service) => dustFloor((await service.fetchTokenInformation()).decimals),
    )
    dust.catch(() => previous.dust.delete(key))
    previous.dust.set(key, dust)
  }
  return dust
}

/** Savings' `shares` priced through the session's Savings; undefined where it has no price. */
async function savingsValue(
  source: PreviousAccountParts["savings"],
  shares: bigint,
): Promise<bigint | undefined> {
  if (shares === 0n) return 0n
  const savings = source && valueOf(source)
  if (!savings) return undefined
  return (await bestEffort("balance.unread", savings.quote("out", shares)))?.value
}

/**
 * The forward's dependencies for one token: the rotation's send sequence with the previous account
 * acting, to the live session account, which must derive from its record's set, differ from the
 * source, and be the account the L1 user record names.
 */
async function moveDeps(
  { saved, session: { page } }: Pick<PreviousAccountParts, "saved" | "session">,
  previous: Previous,
  account: ObsidionAccount,
  token: HeldToken,
  cap: bigint | undefined,
  signal: AbortSignal,
  watch: MoveWatch,
): Promise<PreviousMoveDeps> {
  const { wallet, session } = previous
  const keys = await unlockedSessionKeys(session, wallet)
  if (!keys) throw new WalletError("account.locked", "no unlocked session to move into")
  if (keys.authProvider !== previous.signer)
    throw new WalletError("aborted", "a new session took over")
  const destination = keys.account.getAddress()
  const contractService = await session.contractService.ready()
  const node = walletOutcomeNode(wallet)
  let named: Promise<boolean> | undefined
  return {
    saved,
    address: previous.address.toString(),
    destination: destination.toString(),
    shape: async () =>
      readSpendShape(
        wallet,
        await getWebOxideToken(wallet, contractService, token.l2Token),
        account.getAddress(),
      ),
    cap: cap ?? (await moveCap(session.page.chain, token.l2Token)),
    dust: await dustOf(previous, account, token),
    send: async (amount, onTxHash, signal) => {
      const [tokenService, sponsor] = await Promise.all([
        sponsoredTokenService(session.page, account, token.l2Token),
        claimSponsorContext({ session, wallet, account, contractService }, RAIL_REGISTERED),
      ])
      if (signal.aborted) throw new WalletError("aborted", "the move was stopped")
      watch.sending()
      await tokenService.sendTokenSponsored(destination, amount.toString(), sponsor, {
        userAccount: account,
        useRawAmount: true,
        onTxHash: async (txHash, meta) => {
          watch.sent(txHash)
          await onTxHash(txHash, meta)
        },
        signal,
      })
      session.oweFpcRefuel({ address: sponsor.fpcAddress, artifact: sponsor.fpcArtifact })
    },
    // Asked only of a transfer already out, this run's or one an earlier run left in flight.
    outcome: async (txHash, expiresAtMs) => {
      watch.asked(txHash)
      const outcome = await txOutcome(node, txHash, expiresAtMs)
      watch.settled(txHash, outcome)
      return outcome
    },
    destinationOk: async () => {
      const record = await session.auth.accountRecord(destination.toString())
      if (!record?.passkeySet) return false
      const derived = await wallet.deriveAccountAddress(keys.secretKey, record.passkeySet)
      if (!derived.equals(destination) || destination.equals(previous.address)) return false
      named ??= namedOnL1(previous, keys.secretKey, destination.toString())
      return named
    },
    sleep: (ms) => page.pace.wait(ms, signal),
    now: Date.now,
  }
}

/** Whether the L1 user record of the MSK's bootstrap owner names `l2Address` on this rollup. */
async function namedOnL1(
  { wallet, session }: Previous,
  secretKey: Fr,
  l2Address: string,
): Promise<boolean> {
  const contractService = await session.contractService.ready()
  const generations = await loadOxideGenerations(wallet, contractService, session.page)
  const outcome = await resolveOxideIdentity(
    { ...generations, admissibleRollupVersions: new Set([generations.rollupVersion]) },
    deriveBootstrapKey(secretKey).address,
    l2Address,
  )
  return outcome.kind === "verified"
}

// eslint-disable-next-line no-restricted-syntax -- debt
let watcher: PreviousAccountWatcher | undefined

/** The page's watcher. */
export function getPreviousAccountWatcher(): PreviousAccountWatcher {
  watcher ??= new PreviousAccountWatcher()
  return watcher
}

/** Test seam: the next `getPreviousAccountWatcher` builds a fresh watcher. */
export function resetPreviousAccountWatcherForTests(): void {
  watcher?.stop()
  watcher = undefined
}
