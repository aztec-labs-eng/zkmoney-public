import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  setupFetchInterceptor,
  updateInterceptorConfig,
  restoreFetch,
} from "./customizableFetchInterceptor"

describe("Customizable Fetch Interceptor Example", () => {
  // Set up the fetch interceptor before all tests with default configuration
  beforeAll(() => {
    setupFetchInterceptor()
  })

  // Restore the original fetch after all tests
  afterAll(() => {
    restoreFetch()
  })

  it("should intercept fetch calls with default configuration", async () => {
    // Make a fetch request that will be intercepted
    const response = await fetch("https://example.com/api/data")

    // Check that we got a response
    expect(response.status).toBe(200)

    // Parse the JSON response
    const data = await response.json()

    // Verify the default mock data structure
    expect(data).toHaveProperty("success", true)
    expect(data).toHaveProperty("message", "This is a mock response")
    expect(data).toHaveProperty("data")
  })

  it("should allow custom response data", async () => {
    // Update the interceptor to return custom data
    updateInterceptorConfig({
      mockResponse: {
        customField: "custom value",
        items: [1, 2, 3],
      },
    })

    // Make a fetch request
    const response = await fetch("https://example.com/api/custom")
    const data = await response.json()

    // Verify the custom data
    expect(data).toHaveProperty("customField", "custom value")
    expect(data).toHaveProperty("items")
    expect(data.items).toEqual([1, 2, 3])
  })

  it("should allow dynamic responses based on URL", async () => {
    // Update the interceptor to return different responses based on the URL
    updateInterceptorConfig({
      mockResponse: (url) => {
        if (url.includes("/users")) {
          return { type: "users", count: 5 }
        } else if (url.includes("/products")) {
          return { type: "products", count: 10 }
        } else {
          return { type: "unknown" }
        }
      },
    })

    // Make fetch requests to different URLs
    const usersResponse = await fetch("https://example.com/api/users")
    const productsResponse = await fetch("https://example.com/api/products")
    const otherResponse = await fetch("https://example.com/api/other")

    // Parse the responses
    const usersData = await usersResponse.json()
    const productsData = await productsResponse.json()
    const otherData = await otherResponse.json()

    // Verify the dynamic responses
    expect(usersData).toHaveProperty("type", "users")
    expect(usersData).toHaveProperty("count", 5)

    expect(productsData).toHaveProperty("type", "products")
    expect(productsData).toHaveProperty("count", 10)

    expect(otherData).toHaveProperty("type", "unknown")
  })

  it("should allow custom status codes", async () => {
    // Update the interceptor to return a 404 status
    updateInterceptorConfig({
      statusCode: 404,
      mockResponse: { error: "Not found" },
    })

    // Make a fetch request
    const response = await fetch("https://example.com/api/missing")

    // Verify the status code
    expect(response.status).toBe(404)

    // Parse the response
    const data = await response.json()
    expect(data).toHaveProperty("error", "Not found")
  })

  it("should allow selective interception", async () => {
    // Update the interceptor to only intercept certain URLs
    updateInterceptorConfig({
      shouldIntercept: (url) => url.includes("intercept-me"),
      mockResponse: { intercepted: true },
    })

    // This would normally make a real request, but we're in a test environment
    // so we'll just verify that the interceptor doesn't try to handle it
    try {
      await fetch("https://example.com/api/not-intercepted")
      // In a real environment, this would make a real request
      // In our test environment, it will likely fail, which is fine
    } catch (error) {
      // Expected in test environment
    }

    // This should be intercepted
    const response = await fetch("https://example.com/api/intercept-me")
    const data = await response.json()
    expect(data).toHaveProperty("intercepted", true)
  })

  it("should allow custom log messages", async () => {
    // Spy on console.log
    const originalConsoleLog = console.log
    const logMessages: string[] = []
    console.log = (message: string) => {
      logMessages.push(message)
    }

    // Update the interceptor with a custom log message
    updateInterceptorConfig({
      logMessage: "Custom log message!",
    })

    // Make a fetch request
    await fetch("https://example.com/api/data")

    // Restore console.log
    console.log = originalConsoleLog

    // Verify the log message
    expect(logMessages).toContain("Custom log message!")
  })
})
