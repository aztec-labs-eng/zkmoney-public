/**
 * Storage migration: the independent random analytics ids older builds kept before the base id,
 * removed when the base id is minted. Remove when no supported build keeps `zkm_sid` or `zkm_rid`.
 */
export function removeOlderAnalyticsIds(): void {
  for (const key of ["zkm_sid", "zkm_rid"]) localStorage.removeItem(key)
}
