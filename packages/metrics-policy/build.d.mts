export type MetricsEnvironment = "dev" | "staging" | "production"

export interface MetricsTarget {
  version: number
  app: "wallet" | "campaign"
  environment: MetricsEnvironment
  analyticsUrl: string
}
export function metricsBuildTarget(
  env: Record<string, unknown>,
  app: "wallet" | "campaign",
  command?: string,
): MetricsTarget
export function metricsBuildPlugin(app: "wallet" | "campaign"): {
  name: string
  configResolved(config: { env: Record<string, unknown>; command: string }): void
  generateBundle(this: {
    emitFile(asset: { type: "asset"; fileName: string; source: string }): unknown
  }): void
}
export function checkMetricsArtifact(file: string, slot: string): MetricsEnvironment
