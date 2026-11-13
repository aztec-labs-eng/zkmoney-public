/**
 * The features document beside a profile: `/features/<generation>/current.json` for the store's
 * `/profiles/<generation>/<current|x.y.z>.json`, or `/features/<id>.json` for the dev server's
 * `/profiles/<id>.json`. A pinned profile version still reads the current features. Undefined for
 * a URL of neither shape. Free of dependencies, so a page can derive it before the wallet loads.
 */
export function featuresUrlOf(profileUrl: string): string | undefined {
  const url = URL.canParse(profileUrl) ? new URL(profileUrl) : undefined
  if (!url) return undefined
  url.search = ""
  url.hash = ""
  const store = /^(.*)\/profiles\/(v(?:0|[1-9]\d*))\/[^/]+\.json$/.exec(url.pathname)
  const flat = /^(.*)\/profiles\/([a-z0-9][a-z0-9-]*)\.json$/.exec(url.pathname)
  if (store) url.pathname = `${store[1]}/features/${store[2]}/current.json`
  else if (flat) url.pathname = `${flat[1]}/features/${flat[2]}.json`
  else return undefined
  return url.toString()
}

export function featuresUrl(profileUrl: string): string {
  const url = featuresUrlOf(profileUrl)
  if (!url) throw new Error(`no features document derives from the profile URL ${profileUrl}`)
  return url
}
