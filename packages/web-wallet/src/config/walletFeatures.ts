import {
  FeaturesDocumentError,
  featuresUrlOf,
  fetchFeaturesDocument,
  parseServedFeatures,
  type Features,
  type FeaturesDocumentErrorCode,
  type ProfileNetwork,
  type RejectedFeature,
} from "@obsidion/config-client"

/** The features the wallet boots with. A failure turns features off; it never stops the boot. */
export interface WalletFeaturesBoot {
  features: Features
  /** Why the document was not read: every feature is off, or the baked copy stood in. */
  issue?: { code: FeaturesDocumentErrorCode | "NO_URL"; message: string }
  /** Features this build knows whose entries it could not read; each is off. */
  rejected: RejectedFeature[]
  bootedFromBaked: boolean
}

export interface LoadWalletFeaturesInput {
  profileUrl: string
  expected: { profileId: string; network: ProfileNetwork }
  /** The document baked into this build; the app tree passes the virtual module's export. */
  baked?: unknown
  /** The host asked for the shipped configuration: nothing is fetched. */
  forceBaked?: boolean
  fetchImpl?: typeof fetch
  now?: () => Date
}

const none = (issue?: WalletFeaturesBoot["issue"]): WalletFeaturesBoot => ({
  features: {},
  rejected: [],
  bootedFromBaked: false,
  ...(issue && { issue }),
})

const issueOf = (e: unknown): NonNullable<WalletFeaturesBoot["issue"]> => {
  if (e instanceof FeaturesDocumentError) return { code: e.code, message: e.message }
  throw e
}

function fromBaked(
  input: LoadWalletFeaturesInput,
  issue?: WalletFeaturesBoot["issue"],
): WalletFeaturesBoot {
  if (input.baked === undefined) return none(issue)
  try {
    const served = parseServedFeatures(input.baked, input)
    return { features: served.features, rejected: served.rejected, bootedFromBaked: true, issue }
  } catch (e) {
    return none(issueOf(e))
  }
}

/**
 * The served document, else the baked copy when the store is unreachable, else no features. Only
 * `UNREACHABLE` falls back: any answer from the store is the store's word.
 */
export async function loadWalletFeatures(
  input: LoadWalletFeaturesInput,
): Promise<WalletFeaturesBoot> {
  if (input.forceBaked) return fromBaked(input)
  const url = featuresUrlOf(input.profileUrl)
  if (!url)
    return none({ code: "NO_URL", message: `no features document beside ${input.profileUrl}` })
  try {
    const served = await fetchFeaturesDocument(url, input)
    return { features: served.features, rejected: served.rejected, bootedFromBaked: false }
  } catch (e) {
    const issue = issueOf(e)
    return issue.code === "UNREACHABLE" ? fromBaked(input, issue) : none(issue)
  }
}
