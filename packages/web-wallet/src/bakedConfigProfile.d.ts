declare module "virtual:baked-config-profile" {
  /**
   * The config profile baked at build time (see `bakedConfigProfile.ts`), or undefined when the
   * build set no profile URL and under `vite dev`.
   */
  const bakedProfile: unknown
  export default bakedProfile
}

declare module "virtual:baked-features" {
  /** The features document baked at build time, or undefined when there was none to bake. */
  const bakedFeatures: unknown
  export default bakedFeatures
}
