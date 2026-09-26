import type { IStorageAdapter } from "@obsidion/front-core"

// The one fake authenticator both web fronts' suites drive lives with the package it fakes.
export {
  FakePasskeyCeremony,
  type FakeCeremonyOptions,
  type FakeManager,
  type FakeRoute,
  contextualiseLocal,
  fakePrf,
  sha256,
} from "../../../passkey-web/test/support/fakePasskeyCeremony"

export class MemoryStorage implements IStorageAdapter {
  private map = new Map<string, string>()
  async getItem(key: string) {
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  async removeItem(key: string) {
    this.map.delete(key)
  }
  async clear() {
    this.map.clear()
  }
}
