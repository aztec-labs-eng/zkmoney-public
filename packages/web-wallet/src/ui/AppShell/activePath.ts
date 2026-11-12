import { REQUESTS_PATH } from "../../features/requests/nonContactView"

/** The nav item a route belongs to, lit on the sidebar, the phone menu and the tab bar. */
export function activePath(pathname: string): string {
  // Receive and Contacts have no nav item: Requests and Send are the ways in.
  if (pathname.startsWith("/receive") || pathname.startsWith(REQUESTS_PATH)) return REQUESTS_PATH
  if (pathname.startsWith("/contacts") || pathname.startsWith("/connect")) return "/send"
  for (const p of [
    "/savings",
    "/activity",
    "/settings",
    "/deposit",
    "/withdraw",
    "/send",
    "/links",
  ]) {
    if (pathname.startsWith(p)) return p
  }
  return "/"
}
