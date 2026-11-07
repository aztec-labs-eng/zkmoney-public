import type { ReadonlyStore } from "@obsidion/front-core"
import type { DeviceState } from "../platform/storage/deviceKeys"
import { bindAnalyticsConsent } from "./analytics"

/** Binds the consent saved now: a boot failure is reported after the wallet database may close. */
export function bindSavedConsent(device: ReadonlyStore<DeviceState>): void {
  const { analyticsConsent } = device.get()
  bindAnalyticsConsent(() => analyticsConsent)
}
