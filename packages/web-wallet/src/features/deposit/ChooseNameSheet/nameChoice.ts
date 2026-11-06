/** Home keeps a paid tag at the pick, open to the past-user claim, until it is registered. */
export function confirmsAtPick(route: "invite" | "past-user" | "pay", pathname: string): boolean {
  return route === "pay" && pathname === "/deposit"
}
