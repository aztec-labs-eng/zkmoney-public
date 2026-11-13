import { featuresUrlOf } from "@obsidion/config-client/features-url"
import { tabStash, type TabKey } from "../platform/storage/tabStash"

/** The documents the preview editor drafts: the config profile and its features document. */
export type ConfigDocument = "profile" | "features"

const KEYS: Record<ConfigDocument, TabKey> = {
  profile: "webwallet.preview-config-draft",
  features: "webwallet.preview-features-draft",
}

/** Both drafts are keyed by the profile URL the build boots from. */
type SavedDraft = { profileUrl: string; payload: string }

function read(key: TabKey): SavedDraft | undefined {
  try {
    const value: unknown = JSON.parse(tabStash.get(key) ?? "null")
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    if (typeof record.profileUrl !== "string" || typeof record.payload !== "string")
      return undefined
    return { profileUrl: record.profileUrl, payload: record.payload }
  } catch {
    return undefined
  }
}

const stored = (kind: ConfigDocument) => read(KEYS[kind])
const write = (key: TabKey, draft: SavedDraft) => tabStash.set(key, JSON.stringify(draft))
const remove = (key: TabKey) => tabStash.remove(key)

export function configDraft(kind: ConfigDocument, profileUrl: string): string | undefined {
  const draft = stored(kind)
  return draft?.profileUrl === profileUrl ? draft.payload : undefined
}

export function saveConfigDraft(kind: ConfigDocument, profileUrl: string, payload: string): void {
  write(KEYS[kind], { profileUrl, payload })
}

export function clearConfigDraft(kind: ConfigDocument): void {
  remove(KEYS[kind])
}

export function hasConfigDraft(kind: ConfigDocument): boolean {
  return stored(kind) !== undefined
}

/** The draft served at `url`: the profile's at its URL, the features document's beside it. */
function draftAt(url: string): string | undefined {
  const profile = stored("profile")
  if (profile?.profileUrl === url) return profile.payload
  const features = stored("features")
  return features && featuresUrlOf(features.profileUrl) === url ? features.payload : undefined
}

export function configDraftFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const payload = draftAt(url)
    if (payload !== undefined) {
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return fetchImpl(input, init)
  }) as typeof fetch
}
