import { vi } from "vitest"

/**
 * `vi.resetModules()`, then sets the tab active. The reset reloads `activeTab.ts`, which starts
 * `pending`.
 */
export async function resetModulesAsActiveTab(): Promise<void> {
  vi.resetModules()
  const { activateTab } = await import("../../src/platform/storage/activeTab")
  activateTab()
}
