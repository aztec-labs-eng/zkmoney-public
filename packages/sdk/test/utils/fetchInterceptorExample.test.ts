import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { setupFetchInterceptor, restoreFetch } from "./customizableFetchInterceptor"

describe("Fetch Interceptor Example", () => {
  // Set up the fetch interceptor before all tests
  beforeAll(() => {
    setupFetchInterceptor()
  })

  // Restore the original fetch after all tests
  afterAll(() => {
    restoreFetch()
  })

  it("should intercept fetch calls and return mock data", async () => {
    // Make a fetch request that will be intercepted
    const response = await fetch("https://example.com/api/data")

    // Check that we got a response
    expect(response.status).toBe(200)

    // Parse the JSON response
    const data = await response.json()

    // Verify the mock data structure
    expect(data).toHaveProperty("success", true)
    expect(data).toHaveProperty("message", "This is a mock response")
    expect(data).toHaveProperty("data")
    expect(data.data).toHaveProperty("id", 1)
    expect(data.data).toHaveProperty("name", "Mock Data")
    expect(data.data).toHaveProperty("timestamp")
  })

  it("should intercept fetch calls with different URLs", async () => {
    // Make fetch requests to different URLs
    const response1 = await fetch("https://api.example.com/users")
    const response2 = await fetch("https://api.example.com/products")

    // Both should return the same mock data
    const data1 = await response1.json()
    const data2 = await response2.json()

    expect(data1).toEqual(data2)
  })

  it("should intercept fetch calls with different options", async () => {
    // Make a fetch request with POST method and body
    const response = await fetch("https://api.example.com/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ foo: "bar" }),
    })

    // Should still return our mock data
    const data = await response.json()
    expect(data).toHaveProperty("success", true)
  })
})
