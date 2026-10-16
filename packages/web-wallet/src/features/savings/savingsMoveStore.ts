import { SavingsMoveStorage } from "@obsidion/front-core"
import { webStorage } from "../../platform/storage/WebStorageAdapter"

let store: SavingsMoveStorage | undefined

/** The moves this browser made, one store per page load. */
export function getSavingsMoveStore(): SavingsMoveStorage {
  return (store ??= new SavingsMoveStorage(webStorage))
}
