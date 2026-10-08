import { normalizeTag } from "@obsidion/front-core"

const TOKEN_KEY = "obsidion.name-grant"
const HANDLE_KEY = "obsidion.name-grant-handle"

let inboundGrant: { token: string; handle?: string } | undefined

function storedGrant(): { token: string; handle?: string } | undefined {
  if (inboundGrant) return inboundGrant
  try {
    const token = window.sessionStorage.getItem(TOKEN_KEY)
    if (!token) return undefined
    return { token, handle: window.sessionStorage.getItem(HANDLE_KEY) ?? undefined }
  } catch {
    return undefined
  }
}

function writeGrant(grant: { token: string; handle?: string } | undefined): void {
  inboundGrant = grant
  try {
    if (grant) {
      window.sessionStorage.setItem(TOKEN_KEY, grant.token)
      if (grant.handle) window.sessionStorage.setItem(HANDLE_KEY, grant.handle)
      else window.sessionStorage.removeItem(HANDLE_KEY)
    } else {
      window.sessionStorage.removeItem(TOKEN_KEY)
      window.sessionStorage.removeItem(HANDLE_KEY)
    }
  } catch {
    // The in-memory grant still keeps this page's claim usable.
  }
}

/** The tag a claim route names, if the path is one. */
function claimRouteHandle(pathname: string): string | undefined {
  const route = /^\/claim\/([^/]+)\/?$/.exec(pathname)
  if (!route) return undefined
  try {
    return normalizeTag(decodeURIComponent(route[1])) ?? undefined
  } catch {
    return undefined
  }
}

export function stashInboundNameGrant(): void {
  const url = new URL(window.location.href)
  if (!url.searchParams.has("grant")) return

  const token = url.searchParams.get("grant") || undefined
  const handle = claimRouteHandle(url.pathname)
  if (token && handle) writeGrant({ token, handle })
  else if (!token) writeGrant(undefined)

  url.searchParams.delete("grant")
  window.history.replaceState(window.history.state, "", url)
}

export function nameGrantToken(handle?: string): string | undefined {
  const grant = storedGrant()
  if (grant && !grant.handle) {
    writeGrant(undefined)
    return undefined
  }
  return grant && (!handle || grant.handle === handle) ? grant.token : undefined
}

/**
 * The grant the page at `url` runs on: its claim route's, or a bound-grant sign-in's. A grant that
 * another link left in this tab belongs to another flow.
 */
export function pageNameGrantToken(url: URL): string | undefined {
  const bound = /^\/enter\/?$/.test(url.pathname) && url.searchParams.get("bound") === "1"
  const handle = bound
    ? normalizeTag(url.searchParams.get("handle") ?? "") ?? undefined
    : claimRouteHandle(url.pathname)
  return handle ? nameGrantToken(handle) : undefined
}

export function scopeNameGrant(handle: string, token: string): void {
  if (nameGrantToken(handle) === token) writeGrant({ token, handle })
}

export function clearNameGrant(handle?: string, token?: string): void {
  if (handle && !nameGrantToken(handle)) return
  if (token && nameGrantToken(handle) !== token) return
  writeGrant(undefined)
}
