import { describe, it, expect, vi } from "vitest"

import {
  ARCHIVE_LIST_FAILURE_LIMIT,
  importHistory,
  startArchivePublisher,
  startHistoryImporter,
  type DeviceSyncPort,
  type HistorySyncPort,
} from "../../src/xmtp/deviceSync"

function fakePort(overrides: Partial<DeviceSyncPort> = {}) {
  const calls: string[] = []
  const port: DeviceSyncPort = {
    sendSyncRequest: async () => void calls.push("request"),
    sendSyncArchive: async () => void calls.push("archive"),
    processSyncArchive: async () => void calls.push("process"),
    syncAllDeviceSyncGroups: async () => void calls.push("syncGroups"),
    ...overrides,
  }
  return { port, calls }
}

const log = { warn: () => undefined }

describe("importHistory", () => {
  it("syncs the sync group, imports the newest archive, then requests a live sync", async () => {
    const { port, calls } = fakePort()
    await importHistory(port, log)
    expect(calls).toEqual(["syncGroups", "process", "request"])
  })

  it("still sends the sync request when no archive is available", async () => {
    const { port, calls } = fakePort({
      processSyncArchive: async () => {
        throw new Error("no archive")
      },
    })
    await importHistory(port, log)
    expect(calls).toEqual(["syncGroups", "request"])
  })

  it("never throws", async () => {
    const boom = async () => {
      throw new Error("offline")
    }
    const { port } = fakePort({
      syncAllDeviceSyncGroups: boom,
      processSyncArchive: boom,
      sendSyncRequest: boom,
    })
    await expect(importHistory(port, log)).resolves.toBeUndefined()
  })
})

describe("startArchivePublisher", () => {
  it("pushes at start and on each interval until stopped", async () => {
    vi.useFakeTimers()
    try {
      const { port, calls } = fakePort()
      const stop = startArchivePublisher(port, log, 1_000)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual(["archive"])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(calls).toEqual(["archive", "archive", "archive"])
      stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(calls).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("survives a failing push", async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.fn()
      const { port } = fakePort({
        sendSyncArchive: async () => {
          throw new Error("server down")
        },
      })
      const stop = startArchivePublisher(port, { warn }, 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(warn).toHaveBeenCalledTimes(2)
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("startHistoryImporter", () => {
  function failingListPort(listSyncArchivePins: () => Promise<string[]>) {
    const calls: string[] = []
    const port: HistorySyncPort = {
      installationId: "self",
      sendSyncRequest: async () => void calls.push("request"),
      sendSyncArchive: async () => void calls.push("archive"),
      processSyncArchive: async () => void calls.push("process"),
      syncAllDeviceSyncGroups: async () => void calls.push("syncGroups"),
      listSyncArchivePins: async () => {
        calls.push("list")
        return listSyncArchivePins()
      },
    }
    return { port, calls }
  }

  it("stops listing archives once the SDK keeps rejecting, and keeps syncing", async () => {
    vi.useFakeTimers()
    try {
      const warn = vi.fn()
      const { port, calls } = failingListPort(async () => {
        throw new Error("1789704007741000000 can't be represented as a JavaScript number")
      })
      const stop = startHistoryImporter(port, { warn }, () => undefined, 1_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls.filter((call) => call === "list")).toHaveLength(ARCHIVE_LIST_FAILURE_LIMIT)
      expect(warn).toHaveBeenCalledTimes(ARCHIVE_LIST_FAILURE_LIMIT)
      expect(calls.filter((call) => call === "syncGroups").length).toBeGreaterThan(
        ARCHIVE_LIST_FAILURE_LIMIT,
      )
      stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps listing when a failure is transient", async () => {
    vi.useFakeTimers()
    try {
      let attempt = 0
      const { port, calls } = failingListPort(async () => {
        attempt += 1
        if (attempt === 1) throw new Error("transient")
        return []
      })
      const stop = startHistoryImporter(port, { warn: () => undefined }, () => undefined, 1_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(calls.filter((call) => call === "list").length).toBeGreaterThan(
        ARCHIVE_LIST_FAILURE_LIMIT,
      )
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
