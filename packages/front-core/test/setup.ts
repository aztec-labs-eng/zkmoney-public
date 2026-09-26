import { vi } from "vitest"

// Ensure proper DOM polyfills for jsdom
// jsdom should provide these, but we ensure they exist and are proper constructors
if (typeof global.window !== "undefined") {
  // Ensure document has proper methods that React DOM expects
  if (global.window.document) {
    if (!global.window.document.activeElement) {
      Object.defineProperty(global.window.document, "activeElement", {
        get: () => null,
        configurable: true,
      })
    }
    // Ensure getSelection exists
    if (!global.window.document.getSelection) {
      global.window.document.getSelection = vi.fn(() => null)
    }
  }

  // Add missing window methods without overwriting existing ones
  if (!global.window.dispatchEvent) {
    global.window.dispatchEvent = vi.fn()
  }
  if (!global.window.addEventListener) {
    global.window.addEventListener = vi.fn()
  }
  if (!global.window.removeEventListener) {
    global.window.removeEventListener = vi.fn()
  }
  if (!global.window.location) {
    global.window.location = {
      href: "http://localhost:3000",
      origin: "http://localhost:3000",
    } as any
  }
}

// Mock localStorage
global.localStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
} as any

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}

