import type { MetadataMigrationController } from "./MetadataMigrationController"

/** Continue an explicitly authorized migration; release storage locks between observations. */
export async function runMetadataMigration(
  controller: MetadataMigrationController,
  options: { signal: AbortSignal; pollMs?: number; onProgress?: () => Promise<void> },
) {
  let start = true
  while (!options.signal.aborted) {
    const record = await controller.advance(start)
    start = false
    await options.onProgress?.()
    if (!record || record.phase === "done" || record.phase === "needsAttention") return record
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        options.signal.removeEventListener("abort", finish)
        resolve()
      }
      const timer = setTimeout(finish, options.pollMs ?? 5_000)
      options.signal.addEventListener("abort", finish, { once: true })
      if (options.signal.aborted) finish()
    })
  }
  return controller.getSnapshot()
}
