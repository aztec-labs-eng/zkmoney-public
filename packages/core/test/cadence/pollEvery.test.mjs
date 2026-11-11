// A pace's `every` with timers fires every interval whether the last run settled or not, as
// setInterval does; a signalled poll waits for each run, so a test world that signals a change sees
// what the poll did with it.
import assert from "node:assert/strict"
import { test } from "node:test"
import { createPace } from "../../dist/cadence/index.js"

const tick = (ms) => new Promise((done) => setTimeout(done, ms))

test("on a live network a slow run does not hold back the next", async () => {
  let started = 0
  const stop = createPace().every(20, () => {
    started++
    return new Promise(() => {}) // never settles
  })
  await tick(110)
  stop()
  assert.ok(started >= 3, `started ${started} runs`)
})

test("a signalled poll runs again only once its run settles", async () => {
  const pace = createPace({ signalled: true })
  let started = 0
  let release
  const stop = pace.every(20, () => {
    started++
    return new Promise((done) => (release = done))
  })
  pace.wake()
  await tick(10)
  pace.wake()
  await tick(10)
  assert.equal(started, 1)
  release()
  await tick(10)
  assert.equal(started, 2)
  stop()
})

test("a signalled after runs at once on a wake that came after its mark, before it began to wait", async () => {
  const pace = createPace({ signalled: true })
  const mark = pace.mark()
  pace.wake()
  let ran = 0
  pace.after(20, () => ran++, mark)
  pace.after(20, () => ran++, pace.mark())
  await tick(10)
  assert.equal(ran, 1)
})

test("a loop no wake reaches keeps its interval live, and the world's cap signalled", () => {
  assert.equal(createPace().foreignMs(4_000), 4_000)
  assert.equal(createPace({ maxMs: 500 }).foreignMs(4_000), 500)
  assert.equal(createPace({ signalled: true }).foreignMs(4_000), 4_000)
  assert.equal(createPace({ signalled: true, maxMs: 0, foreignMaxMs: 100 }).foreignMs(4_000), 100)
  assert.equal(createPace({ signalled: true, foreignMaxMs: 0 }).foreignMs(4_000), 1)
})
