import { afterEach, describe, expect, it, vi } from "vitest"
import { isLoggingEnabled, logger, setLoggingEnabled } from "../../src/utils/logger"

describe("logger", () => {
  afterEach(() => {
    setLoggingEnabled(true)
    vi.restoreAllMocks()
  })

  it("defaults to enabled", () => {
    expect(isLoggingEnabled()).toBe(true)
  })

  it("forwards log/info/debug/warn to console when enabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    logger.log("a", 1)
    logger.info("b")
    logger.debug("c")
    logger.warn("d")

    expect(log).toHaveBeenCalledWith("a", 1)
    expect(info).toHaveBeenCalledWith("b")
    expect(debug).toHaveBeenCalledWith("c")
    expect(warn).toHaveBeenCalledWith("d")
  })

  it("silences log/info/debug/warn when disabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    setLoggingEnabled(false)
    logger.log("a")
    logger.info("b")
    logger.debug("c")
    logger.warn("d")

    expect(log).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it("always emits error, even when disabled", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})

    setLoggingEnabled(false)
    logger.error("boom")

    expect(error).toHaveBeenCalledWith("boom")
  })
})
