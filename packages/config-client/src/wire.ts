import type { z } from "zod"

/** Drop only the keys a `strictObject` rejected (paths from zod); every other issue still fails. */
type UnrecognizedKeys = Extract<z.ZodError["issues"][number], { code: "unrecognized_keys" }>

const isUnrecognizedKeys = (issue: z.ZodError["issues"][number]): issue is UnrecognizedKeys =>
  issue.code === "unrecognized_keys"

export function withoutUnknownKeys(data: unknown, error: z.ZodError): unknown | undefined {
  if (!error.issues.every(isUnrecognizedKeys)) return undefined
  const pruned = structuredClone(data)
  for (const issue of error.issues.filter(isUnrecognizedKeys)) {
    let target = pruned as Record<string, unknown> | undefined
    for (const step of issue.path) {
      target = target?.[step as string] as Record<string, unknown> | undefined
    }
    if (!target) continue
    for (const key of issue.keys) delete target[key]
  }
  return pruned
}

export type DocumentFetchErrorCode = "UNREACHABLE" | "HTTP_ERROR" | "NOT_FOUND" | "NOT_JSON"

export class DocumentFetchError extends Error {
  constructor(readonly code: DocumentFetchErrorCode, message: string) {
    super(message)
    this.name = "DocumentFetchError"
  }
}

/** A 4xx is the server answering; every other non-OK status (5xx, 0, out of range) is silence. */
const isClientError = (status: number) => status >= 400 && status <= 499

/**
 * One store document as JSON. `UNREACHABLE` means the server never answered: the request failed,
 * the deadline passed, the body stream ended, or the status was not a 4xx.
 */
export async function fetchJsonDocument(
  url: string,
  label: string,
  options: { fetchImpl: typeof fetch; timeoutMs: number },
): Promise<unknown> {
  const { fetchImpl, timeoutMs } = options
  // The deadline covers the BODY too: headers-then-stall is the same hang, and aborting rejects
  // a pending `json()` like a pending fetch.
  const controller = new AbortController()
  const expiry = setTimeout(() => controller.abort(), timeoutMs)
  const timedOut = (e: unknown) =>
    controller.signal.aborted ? `no complete response within ${timeoutMs}ms` : (e as Error).message
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    })
    if (response.status === 404) {
      throw new DocumentFetchError("NOT_FOUND", `${label} not found at ${url}`)
    }
    if (!response.ok) {
      throw new DocumentFetchError(
        isClientError(response.status) ? "HTTP_ERROR" : "UNREACHABLE",
        `${label} fetch returned ${response.status} for ${url}`,
      )
    }
    try {
      return await response.json()
    } catch (e) {
      // Abort is checked first: a body cut off by the deadline can surface as a SyntaxError.
      // Only a fully received body that is not JSON is invalid; a terminated stream is unreachable.
      if (controller.signal.aborted || !(e instanceof SyntaxError)) throw e
      throw new DocumentFetchError("NOT_JSON", `${label} is not JSON: ${e.message}`)
    }
  } catch (e) {
    if (e instanceof DocumentFetchError) throw e
    throw new DocumentFetchError("UNREACHABLE", `${label} fetch failed: ${timedOut(e)}`)
  } finally {
    clearTimeout(expiry)
  }
}
