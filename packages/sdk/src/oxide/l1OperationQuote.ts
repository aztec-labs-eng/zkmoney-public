import { quoteL1Operation } from "@oxide/oxide-client/l1_operation_quote.js"

type QuoteArgs = Parameters<typeof quoteL1Operation>[1]

/**
 * `quoteL1Operation` through an executor of either shape. Executors deployed before the six-argument `execute` take
 * four, and only the executor's own call succeeds.
 */
export async function quoteEitherExecutor(
  client: Parameters<typeof quoteL1Operation>[0],
  args: Omit<QuoteArgs, "legacyExecutor">,
): ReturnType<typeof quoteL1Operation> {
  try {
    return await Promise.any([
      quoteL1Operation(client, { ...args, legacyExecutor: false }),
      quoteL1Operation(client, { ...args, legacyExecutor: true }),
    ])
  } catch (err) {
    const { errors } = err as AggregateError
    const [current, legacy] = errors.map((e) => (e instanceof Error ? e.message : String(e)))
    throw new AggregateError(
      errors,
      `six-argument execute: ${current}; four-argument execute: ${legacy}`,
    )
  }
}
