/**
 * Reaches the migration dialog from outside `MigrationDetectionMount`: a request to open it, and
 * whether this account still has to update its registration for this version through it.
 */
import { useSyncExternalStore } from "react"
import { createExternalState } from "../../lib/externalState"

const requests = createExternalState(0)
const registrationNeeded = createExternalState(false)

/** Opens the dialog, even after the session's "Later". */
export function openMigrationDialog(): void {
  requests.set(requests.get() + 1)
}

/** Changes on every open request. */
export function useMigrationDialogRequest(): number {
  return useSyncExternalStore(requests.subscribe, requests.get)
}

export function setRegistrationMigrationNeeded(needed: boolean): void {
  registrationNeeded.set(needed)
}

export function useRegistrationMigrationNeeded(): boolean {
  return useSyncExternalStore(registrationNeeded.subscribe, registrationNeeded.get)
}
