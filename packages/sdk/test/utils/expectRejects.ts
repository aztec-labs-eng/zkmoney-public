import { expect } from "vitest"

/**
 * Awaits a paylink call and its tx promise together. A time-gate failure can surface at
 * simulation (anchor-block assert), at send (expired tx refused by the node), or on-chain, so the
 * expectation must cover all three.
 */
export async function expectRejects(
  fn: () => Promise<{ txPromise: Promise<unknown> }>,
): Promise<void> {
  await expect(
    (async () => {
      const result = await fn()
      await result.txPromise
    })(),
  ).rejects.toThrow()
}
