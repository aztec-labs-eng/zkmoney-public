/** Values one tab keeps across its own navigations and reloads, gone once the tab closes. */
export const tabStash = {
  get: (key: string): string | null => sessionStorage.getItem(key),
  set: (key: string, value: string): void => sessionStorage.setItem(key, value),
  remove: (key: string): void => sessionStorage.removeItem(key),
}
