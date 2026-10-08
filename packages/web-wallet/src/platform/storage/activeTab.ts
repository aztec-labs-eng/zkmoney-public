/**
 * Whether this page is the active tab: the one tab of the origin that runs the wallet. `pending`
 * until the tab has opened its databases. `revoked` once another tab takes over or the boot fails:
 * only a reload, which drops all its state, starts the page over. A revoked page never becomes
 * active again.
 */
type TabState = "pending" | "active" | "revoked"

let state: TabState = "pending"

export class InactiveTabError extends Error {
  constructor(state: TabState) {
    super(`This tab is not the active zk.money tab: it is ${state}`)
    this.name = "InactiveTabError"
  }
}

export function isActiveTab(): boolean {
  return state === "active"
}

export function activateTab(): void {
  if (state === "revoked") throw new Error("activateTab called on a revoked tab")
  state = "active"
}

export function revokeTab(): void {
  state = "revoked"
}

/**
 * The node, refusing `sendTx` unless this tab is the active tab: a tab another tab took over can no
 * longer record what it sends, so the new active tab would end a transaction it sent as
 * interrupted.
 */
export function sendOnlyWhileActive<T extends object>(node: T): T {
  return new Proxy(node, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property)
      if (typeof value !== "function") return value
      // Bound to the target: the client underneath synthesizes its methods per read.
      const method = value.bind(target) as (...args: unknown[]) => unknown
      if (property !== "sendTx") return method
      return async (...args: unknown[]) => {
        if (state !== "active") throw new InactiveTabError(state)
        return method(...args)
      }
    },
  })
}
