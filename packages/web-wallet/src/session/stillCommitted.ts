import type { SessionDeps } from "./session"

/** Whether the device's committed account is still `own`'s, so work begun under it may write. */
export const stillCommitted = (own: Pick<SessionDeps, "device" | "namespace">): boolean =>
  own.device.get().storageId === own.namespace.id
