declare module "virtual:baked-config-profile" {
  /**
   * The config profile baked at build time (see `bakedConfigProfile.ts`), or undefined when the
   * build set no profile URL and under `vite dev`.
   */
  const bakedProfile: unknown
  export default bakedProfile
}
