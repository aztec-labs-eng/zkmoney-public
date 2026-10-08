/**
 * The campaign's reminder stop. The launch campaign emails a reserved tag's expiry until the wallet
 * reports the claim (`POST /api/registration/claimed`), signed by the account's bootstrap key. Only
 * an unlocked session holds that key, while confirmation is often observed without one (the
 * credential-free boot tick), so a confirmed name owes its notice here, durably, and a session that
 * owns the account delivers it, retrying with backoff until the campaign answers.
 */

import { campaignTagClaimedPreimage } from "@obsidion/core/constants"
import type { PrivateKeyAccount } from "viem/accounts"

import type { IStorageAdapter, StorageLock } from "../../storages/adapter"

export const CAMPAIGN_CLAIM_NOTICE_STORAGE_KEY = "obsidion_campaign_claim_notices"

/** Past this age a notice is dropped undelivered: every reservation it could stop has ended. */
export const CAMPAIGN_CLAIM_NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 60 * 60_000
const SEND_TIMEOUT_MS = 15_000

/** A confirmed name the campaign has not been told about. */
export interface CampaignClaimNotice {
  /** The L2 account that holds the name (lowercased); the key. */
  l2Address: string
  /** Bare tag. */
  tag: string
  /** ms epoch the confirmation was observed. */
  owedAt: number
  /** Deliveries that failed so far. */
  attempts: number
  /** ms epoch before which no delivery is tried. */
  nextAttemptAt?: number
}

type NoticeSubject = Pick<CampaignClaimNotice, "l2Address" | "tag">

/**
 * Read and written straight through to storage on every call, with no in-memory copy, so every tab
 * sees the same notices. Every change is a read-modify-write of the one map, run under `lock`.
 */
export class CampaignClaimNoticeStore {
  constructor(
    private readonly storage: IStorageAdapter,
    /** Shared by every store over this storage, in every tab (web: a Web Lock). */
    private readonly lock: StorageLock,
  ) {}

  async list(): Promise<CampaignClaimNotice[]> {
    return Object.values(await this.read())
  }

  /** Owes the notice for a confirmed name. One already owed for it keeps its backoff. */
  owe(subject: NoticeSubject, now = Date.now()): Promise<void> {
    const key = subject.l2Address.toLowerCase()
    return this.update((notices) => {
      if (notices[key]?.tag === subject.tag) return false
      notices[key] = { l2Address: key, tag: subject.tag, owedAt: now, attempts: 0 }
      return true
    })
  }

  /** Forgets `notice`; a notice owed for another tag since is kept. */
  remove(notice: NoticeSubject): Promise<void> {
    const key = notice.l2Address.toLowerCase()
    return this.update((notices) => {
      if (notices[key]?.tag !== notice.tag) return false
      delete notices[key]
      return true
    })
  }

  /** Records a failed delivery of `notice` and when the next may be tried. */
  defer(notice: NoticeSubject, now = Date.now()): Promise<void> {
    return this.update((notices) => {
      const stored = notices[notice.l2Address.toLowerCase()]
      if (stored?.tag !== notice.tag) return false
      stored.nextAttemptAt = now + Math.min(RETRY_BASE_MS * 2 ** stored.attempts, RETRY_MAX_MS)
      stored.attempts += 1
      return true
    })
  }

  private update(change: (notices: Record<string, CampaignClaimNotice>) => boolean): Promise<void> {
    return this.lock(async () => {
      const notices = await this.read()
      if (change(notices)) await this.write(notices)
    })
  }

  private async read(): Promise<Record<string, CampaignClaimNotice>> {
    try {
      const raw = await this.storage.getItem(CAMPAIGN_CLAIM_NOTICE_STORAGE_KEY)
      return raw ? (JSON.parse(raw) as Record<string, CampaignClaimNotice>) : {}
    } catch {
      return {}
    }
  }

  private async write(notices: Record<string, CampaignClaimNotice>): Promise<void> {
    await this.storage.setItem(CAMPAIGN_CLAIM_NOTICE_STORAGE_KEY, JSON.stringify(notices))
  }
}

export type CampaignClaimSigner = Pick<PrivateKeyAccount, "address" | "signMessage">

/** `refused` is final: a malformed notice, a key the campaign never saw, or a tag it did not
 *  reserve for that key. Anything else short of success is retried. */
export type CampaignClaimSend = "delivered" | "refused" | "retry"

const REFUSED_STATUSES = new Set([400, 404, 409])

/** One signed `POST /api/registration/claimed`. Never throws. */
export async function sendCampaignClaimNotice(
  campaignUrl: string,
  signer: CampaignClaimSigner,
  tag: string,
  now: () => number = Date.now,
): Promise<CampaignClaimSend> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS)
  try {
    const timestamp = Math.floor(now() / 1000)
    const signature = await signer.signMessage({
      message: campaignTagClaimedPreimage(signer.address, tag, timestamp),
    })
    const res = await fetch(`${campaignUrl.replace(/\/$/, "")}/api/registration/claimed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: signer.address, handle: tag, timestamp, signature }),
      signal: abort.signal,
    })
    if (res.ok) return "delivered"
    return REFUSED_STATUSES.has(res.status) ? "refused" : "retry"
  } catch {
    return "retry"
  } finally {
    clearTimeout(timer)
  }
}

export interface CampaignClaimDeliveryDeps {
  store: CampaignClaimNoticeStore
  campaignUrl: string
  /** The bootstrap key of an unlocked session that owns `l2Address`; null while there is none. */
  signerFor(l2Address: string): Promise<CampaignClaimSigner | null>
  now?: () => number
}

/** One pass over the owed notices: sends each one that is due and signable. Resolves to how many
 *  are still owed. */
export async function deliverCampaignClaimNotices(
  deps: CampaignClaimDeliveryDeps,
): Promise<number> {
  const now = deps.now ?? Date.now
  let owed = 0
  for (const notice of await deps.store.list()) {
    if (now() - notice.owedAt > CAMPAIGN_CLAIM_NOTICE_TTL_MS) {
      await deps.store.remove(notice)
      continue
    }
    owed += 1
    if ((notice.nextAttemptAt ?? 0) > now()) continue
    const signer = await deps.signerFor(notice.l2Address).catch(() => null)
    if (!signer) continue
    const sent = await sendCampaignClaimNotice(deps.campaignUrl, signer, notice.tag, now)
    if (sent === "retry") {
      await deps.store.defer(notice, now())
    } else {
      await deps.store.remove(notice)
      owed -= 1
    }
  }
  return owed
}
