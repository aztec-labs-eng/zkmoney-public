const KEY = "webwallet.preview-config-draft"

type SavedDraft = { profileUrl: string; payload: string }

function stored(): SavedDraft | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "null")
    if (!value || typeof value !== "object") return undefined
    const record = value as Record<string, unknown>
    if (typeof record.profileUrl !== "string" || typeof record.payload !== "string")
      return undefined
    return { profileUrl: record.profileUrl, payload: record.payload }
  } catch {
    return undefined
  }
}

export function profileDraft(profileUrl: string): string | undefined {
  const draft = stored()
  return draft?.profileUrl === profileUrl ? draft.payload : undefined
}

export function saveProfileDraft(profileUrl: string, payload: string): void {
  sessionStorage.setItem(KEY, JSON.stringify({ profileUrl, payload } satisfies SavedDraft))
}

export function clearProfileDraft(): void {
  sessionStorage.removeItem(KEY)
}

export function hasProfileDraft(): boolean {
  return stored() !== undefined
}

export function profileDraftFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const payload = profileDraft(url)
    if (payload !== undefined) {
      return new Response(payload, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return fetchImpl(input, init)
  }) as typeof fetch
}
