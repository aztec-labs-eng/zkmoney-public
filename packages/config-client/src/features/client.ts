import { DEFAULT_PROFILE_FETCH_TIMEOUT_MS } from "../client.js"
import { DocumentFetchError, fetchJsonDocument } from "../wire.js"
import type { FeatureRegistry } from "./define.js"
import {
  FeaturesDocumentError,
  parseServedFeatures,
  type ServedFeatures,
  type ServedFeaturesOptions,
} from "./document.js"
import type { FEATURES } from "./registry.js"

export interface FetchFeaturesOptions<R extends FeatureRegistry> extends ServedFeaturesOptions<R> {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** `UNREACHABLE` is the one failure a baked snapshot may cover. */
export async function fetchFeaturesDocument<R extends FeatureRegistry = typeof FEATURES>(
  url: string,
  options: FetchFeaturesOptions<R>,
): Promise<ServedFeatures<R>> {
  let data: unknown
  try {
    data = await fetchJsonDocument(url, "features document", {
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: options.timeoutMs ?? DEFAULT_PROFILE_FETCH_TIMEOUT_MS,
    })
  } catch (e) {
    if (!(e instanceof DocumentFetchError)) throw e
    throw new FeaturesDocumentError(e.code === "NOT_JSON" ? "INVALID_DOCUMENT" : e.code, e.message)
  }
  return parseServedFeatures(data, options)
}
