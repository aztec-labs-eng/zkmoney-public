import { acrossFeature } from "./definitions/across.js"
import type { FeatureRegistry, FeaturesOf, ResolvedFeaturesOf } from "./define.js"

/** Every feature this build reads. An id is never reused: a breaking change takes a new one. */
export const FEATURES = [acrossFeature] as const satisfies FeatureRegistry

export type Features = FeaturesOf<typeof FEATURES>
export type ResolvedFeatures = ResolvedFeaturesOf<typeof FEATURES>
