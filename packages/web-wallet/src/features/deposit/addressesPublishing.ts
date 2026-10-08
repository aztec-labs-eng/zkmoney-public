import type { BroadcastJob } from "@obsidion/front-core"

/**
 * Addresses the user was shown that nobody funded and whose broadcast has not landed. One that
 * failed more than once is left out, so a broadcast that keeps failing cannot hold the sheet.
 */
export function addressesPublishing(jobs: readonly BroadcastJob[], scope: string | null): number {
  return jobs.filter(
    (job) =>
      job.scope === scope &&
      job.kind === "deposit" &&
      job.state !== "landed" &&
      job.fundedAt === undefined &&
      job.failures < 2,
  ).length
}

/**
 * Refuses a fresh deposit address while too many shown, unfunded ones still wait on their
 * broadcast: each fresh one costs another proof.
 */
export class AddressesPublishingError extends Error {
  constructor() {
    // Proposed copy, pending review.
    super("Your last addresses are still being published. A new one is ready once one lands.")
    this.name = "AddressesPublishingError"
  }
}
