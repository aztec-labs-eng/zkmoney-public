"use strict"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { EventEmitter, once } = require("node:events")
const {
  buildChromeArguments,
  closeChrome,
  launchChrome,
  waitForDevtools,
} = require("../src/chrome")
const { createWalletSession } = require("../src/walletSession")

const GET_VERSION = '{"id":0,"method":"Browser.getVersion"}\0'
const BROWSER_CLOSE = '{"id":1,"method":"Browser.close"}\0'

// Holds each write's callback so a test decides when, and how, the write finishes.
class FakePipe extends EventEmitter {
  writes = []
  callbacks = []
  closes = []
  write(chunk, callback) {
    this.writes.push(String(chunk))
    this.callbacks.push(callback)
    return true
  }
  end() {
    this.closes.push("end")
  }
  destroy() {
    this.closes.push("destroy")
  }
}

function fakeChrome(startPath) {
  const child = new EventEmitter()
  child.startPath = startPath
  child.stdio = [null, null, null, new FakePipe(), new FakePipe()]
  child.killed = false
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    return true
  }
  child.pipe = child.stdio[3]
  return child
}

// A settings-window launch, handing its window to the running Chrome until the test lets it exit.
function fakeHelper() {
  const helper = new EventEmitter()
  helper.killed = false
  helper.kills = []
  helper.kill = (signal) => {
    helper.kills.push(signal)
    return true
  }
  return helper
}

function harness() {
  const h = {
    chromes: [],
    helpers: [],
    menu: false,
    probes: [],
    closed: 0,
    quitting: false,
    warnings: [],
    spawnErrors: [],
  }
  h.session = createWalletSession({
    spawnWallet: (startPath) => {
      const child = fakeChrome(startPath)
      h.chromes.push(child)
      return child
    },
    spawnSettingsWindow: () => {
      const helper = fakeHelper()
      h.helpers.push(helper)
      return helper
    },
    chooseStartPath: () => new Promise((resolve) => h.probes.push(resolve)),
    onMenuChange: (enabled) => {
      h.menu = enabled
    },
    onSpawnError: (error) => h.spawnErrors.push(error),
    onClosed: () => h.closed++,
    isQuitting: () => h.quitting,
    log: { warn: (...args) => h.warnings.push(args) },
  })
  h.quit = () => {
    h.quitting = true
    h.session.stop()
  }
  return h
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

// Chrome takes the Browser.getVersion probe and answers it, as the browser owning the profile does.
async function answer(chrome) {
  assert.equal(chrome.pipe.writes[0], GET_VERSION)
  chrome.pipe.callbacks[0]()
  chrome.stdio[4].emit("data", Buffer.from('{"id":0,"result":{"product":"Chrome"}}\0'))
  await settle()
}

// Launches and waits for the answer.
async function started(h, startPath = "/") {
  h.session.launch(startPath)
  await answer(h.chromes.at(-1))
  return h.chromes.at(-1)
}

// Starts a relaunch and lets Chrome take the command.
async function acceptedRelaunch(h, chrome) {
  const reply = h.session.relaunch()
  chrome.pipe.callbacks.at(-1)()
  assert.equal(await reply, "accepted")
}

test("a relaunch sends Browser.close once and starts Chrome again after its exit", async () => {
  const h = harness()
  const first = await started(h)
  assert.equal(h.menu, true)

  const reply = h.session.relaunch()
  assert.equal(h.menu, false)
  assert.deepEqual(first.pipe.writes, [GET_VERSION, BROWSER_CLOSE])
  first.pipe.callbacks[1]()
  assert.equal(await reply, "accepted")

  assert.equal(await h.session.relaunch(), "already-relaunching")
  assert.equal(first.pipe.writes.length, 2)

  first.emit("exit", 0, null)
  await settle()
  assert.equal(h.probes.length, 1)
  assert.equal(h.chromes.length, 1)
  assert.equal(h.menu, false)

  h.probes[0]("/desktop-settings")
  await settle()
  assert.equal(h.chromes.length, 2)
  assert.equal(h.chromes[1].startPath, "/desktop-settings")
  // The replacement has not answered yet.
  assert.equal(h.menu, false)
  await answer(h.chromes[1])
  assert.equal(h.menu, true)
  assert.equal(h.closed, 0)
  assert.deepEqual(first.kills, [])
  assert.deepEqual(first.pipe.closes, [])
  assert.deepEqual(first.stdio[4].closes, [])

  h.session.openSettings()
  assert.equal(h.helpers.length, 1)
})

test("the settings entry stays off until the wallet's Chrome answers on its pipe", async () => {
  const h = harness()
  h.session.launch("/")
  const [chrome] = h.chromes
  assert.equal(h.menu, false)
  h.session.openSettings()
  assert.equal(h.helpers.length, 0)

  // Replies arrive in pieces and alongside other messages.
  chrome.pipe.callbacks[0]()
  chrome.stdio[4].emit("data", Buffer.from('{"method":"Target.targetCreated"}\0{"id":0,'))
  await settle()
  assert.equal(h.menu, false)
  chrome.stdio[4].emit("data", Buffer.from('"result":{}}\0'))
  await settle()
  assert.equal(h.menu, true)
  h.session.openSettings()
  assert.equal(h.helpers.length, 1)
})

test("a Chrome that hands its launch to another and exits never turns the entry on", async () => {
  const h = harness()
  h.session.launch("/")
  const [chrome] = h.chromes
  chrome.pipe.callbacks[0]()
  chrome.emit("exit", 0, null)
  await settle()
  assert.equal(h.menu, false)
  assert.equal(h.closed, 1)
})

test("a probe the pipe refuses leaves the entry off; a relaunch is still possible", async () => {
  const h = harness()
  h.session.launch("/")
  const [chrome] = h.chromes
  chrome.pipe.callbacks[0](new Error("write EPIPE"))
  await settle()
  assert.equal(h.menu, false)
  await acceptedRelaunch(h, chrome)
})

test("a failed write with Chrome still running answers the error and clears the pending relaunch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness()
  const chrome = await started(h)

  const reply = h.session.relaunch()
  chrome.pipe.callbacks.at(-1)(new Error("write EPIPE"))
  await settle()
  // Chrome may be on its way out; the relaunch stays pending while it has time to exit.
  assert.equal(h.menu, false)
  assert.equal(await h.session.relaunch(), "already-relaunching")
  t.mock.timers.tick(2_000)
  await assert.rejects(reply, /EPIPE/)
  assert.equal(h.menu, true)

  await acceptedRelaunch(h, chrome)
  assert.equal(chrome.pipe.writes.length, 3)
})

test("a failed write while Chrome exits still relaunches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness()
  const chrome = await started(h)

  const reply = h.session.relaunch()
  chrome.pipe.callbacks.at(-1)(new Error("write EPIPE"))
  await settle()
  chrome.emit("exit", 0, null)
  assert.equal(await reply, "accepted")
  await settle()
  assert.equal(h.closed, 0)

  h.probes[0]("/")
  await settle()
  assert.equal(h.chromes.length, 2)
})

test("a pipe error after the command was accepted is only logged: the exit still relaunches", async () => {
  const h = harness()
  const chrome = await started(h)

  chrome.pipe.emit("error", new Error("read ECONNRESET"))
  assert.equal(h.menu, true)

  await acceptedRelaunch(h, chrome)
  // Chrome's own shutdown may break the pipe before it exits.
  chrome.stdio[4].emit("error", new Error("read ECONNRESET"))
  assert.equal(h.menu, false)
  assert.equal(h.warnings.length, 2)
  assert.equal(await h.session.relaunch(), "already-relaunching")
  assert.equal(chrome.pipe.writes.length, 2)

  chrome.emit("exit", 0, null)
  await settle()
  assert.equal(h.closed, 0)
  h.probes[0]("/")
  await settle()
  assert.equal(h.chromes.length, 2)
})

for (const [label, code, signal] of [
  ["normally", 0, null],
  ["by a signal", null, "SIGKILL"],
]) {
  test(`Chrome exits ${label}, then its old pipe fails while the probe runs: the restart still happens`, async () => {
    const h = harness()
    const old = await started(h)
    await acceptedRelaunch(h, old)

    old.emit("exit", code, signal)
    await settle()
    old.pipe.emit("error", new Error("read ECONNRESET"))
    old.stdio[4].emit("error", new Error("read ECONNRESET"))
    assert.equal(h.menu, false)
    assert.equal(await h.session.relaunch(), "already-relaunching")
    h.session.openSettings()
    assert.equal(h.helpers.length, 0)

    h.probes[0]("/")
    await settle()
    assert.equal(h.chromes.length, 2)
    await answer(h.chromes[1])
    assert.equal(h.menu, true)
    assert.equal(h.closed, 0)
  })
}

test("a write that fails after its Chrome exited is accepted and leaves the restart alone", async () => {
  const h = harness()
  const old = await started(h)

  const reply = h.session.relaunch()
  old.emit("exit", 0, null)
  await settle()
  old.pipe.callbacks.at(-1)(new Error("write EPIPE"))
  assert.equal(await reply, "accepted")
  assert.equal(await h.session.relaunch(), "already-relaunching")

  h.probes[0]("/")
  await settle()
  assert.equal(h.chromes.length, 2)
  await answer(h.chromes[1])
  assert.equal(h.menu, true)
})

test("an old Chrome's late answer or pipe error leaves the replacement alone", async () => {
  const h = harness()
  const old = await started(h)
  await acceptedRelaunch(h, old)
  old.emit("exit", 0, null)
  await settle()
  h.probes[0]("/")
  await settle()
  const replacement = h.chromes[1]

  // A late reply from the old pipe does not stand in for the replacement's.
  old.stdio[4].emit("data", Buffer.from('{"id":0,"result":{}}\0'))
  await settle()
  assert.equal(h.menu, false)
  await answer(replacement)

  old.pipe.emit("error", new Error("read ECONNRESET"))
  assert.equal(h.menu, true)

  await acceptedRelaunch(h, replacement)
  old.pipe.emit("error", new Error("read ECONNRESET"))
  assert.equal(h.menu, false)
  assert.equal(await h.session.relaunch(), "already-relaunching")
  assert.equal(replacement.pipe.writes.length, 2)
})

test("the settings entry is off during the cold-start probe and while quitting", async () => {
  const h = harness()
  h.session.openSettings()
  assert.equal(h.helpers.length, 0)
  assert.equal(h.menu, false)
  await assert.rejects(h.session.relaunch(), /not running/)

  await started(h)
  h.session.openSettings()
  h.session.openSettings()
  assert.equal(h.helpers.length, 2)
  h.helpers[1].emit("exit", 0, null)

  h.quit()
  assert.equal(h.menu, false)
  h.session.openSettings()
  assert.equal(h.helpers.length, 2)
  await assert.rejects(h.session.relaunch(), /not running/)
  // The app-quit path keeps its signal.
  assert.deepEqual(h.chromes[0].kills, ["SIGTERM"])
  assert.deepEqual(h.helpers[0].kills, ["SIGKILL"])
  assert.deepEqual(h.helpers[1].kills, [])
})

for (const order of ["before", "after"]) {
  test(`a relaunch ends settings windows still opening, and starts Chrome once they exit (probe ${order})`, async () => {
    const h = harness()
    const chrome = await started(h)
    h.session.openSettings()
    h.session.openSettings()
    h.session.openSettings()
    const [opening, done, failed] = h.helpers
    done.emit("exit", 0, null)
    failed.emit("error", new Error("spawn EAGAIN"))
    await acceptedRelaunch(h, chrome)

    chrome.emit("exit", 0, null)
    await settle()
    assert.deepEqual(opening.kills, ["SIGTERM"])
    assert.deepEqual(done.kills, [])
    assert.deepEqual(failed.kills, [])

    if (order === "before") {
      h.probes[0]("/")
      await settle()
      assert.equal(h.chromes.length, 1)
      opening.emit("exit", null, "SIGTERM")
    } else {
      opening.emit("exit", null, "SIGTERM")
      await settle()
      assert.equal(h.chromes.length, 1)
      h.probes[0]("/")
    }
    await settle()
    assert.equal(h.chromes.length, 2)
    assert.equal(h.closed, 0)
  })
}

// Relaunches with one settings window that has started and is still opening.
async function relaunchPastWindow(h) {
  const chrome = await started(h)
  h.session.openSettings()
  const [helper] = h.helpers
  helper.emit("spawn")
  await acceptedRelaunch(h, chrome)
  chrome.emit("exit", 0, null)
  h.probes[0]("/")
  await settle()
  return helper
}

test("a settings window that ignores SIGTERM gets SIGKILL, and one that outlives both no longer holds the relaunch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness()
  const helper = await relaunchPastWindow(h)
  assert.deepEqual(helper.kills, ["SIGTERM"])
  assert.equal(h.chromes.length, 1)
  t.mock.timers.tick(5_000)
  assert.deepEqual(helper.kills, ["SIGTERM", "SIGKILL"])
  await settle()
  assert.equal(h.chromes.length, 1)
  t.mock.timers.tick(5_000)
  await settle()
  assert.equal(h.chromes.length, 2)
  assert.equal(h.warnings.length, 1)
})

test("a kill that fails keeps the settings window in the way until it exits", async () => {
  const h = harness()
  const chrome = await started(h)
  h.session.openSettings()
  const [helper] = h.helpers
  helper.emit("spawn")
  helper.kill = (signal) => {
    helper.kills.push(signal)
    helper.emit("error", new Error("kill EPERM"))
    return false
  }
  await acceptedRelaunch(h, chrome)
  chrome.emit("exit", 0, null)
  h.probes[0]("/")
  await settle()
  assert.equal(h.chromes.length, 1)
  assert.match(h.warnings[0][1], /EPERM/)
  helper.emit("exit", null, "SIGKILL")
  await settle()
  assert.equal(h.chromes.length, 2)
})

test("a Chrome that fails to start reports the error and leaves nothing to relaunch", async () => {
  const h = harness()
  h.session.launch("/")
  h.chromes[0].emit("error", new Error("spawn ENOENT"))
  assert.equal(h.spawnErrors.length, 1)
  assert.match(h.spawnErrors[0].message, /ENOENT/)
  assert.equal(h.menu, false)
  h.session.openSettings()
  assert.equal(h.helpers.length, 0)
  await assert.rejects(h.session.relaunch(), /not running/)
})

test("a quit while a relaunch is pending starts nothing", async () => {
  const h = harness()
  await started(h)
  await acceptedRelaunch(h, h.chromes[0])
  h.quit()
  h.chromes[0].emit("exit", null, "SIGTERM")
  await settle()
  assert.equal(h.probes.length, 0)
  assert.equal(h.closed, 1)

  const late = harness()
  await started(late)
  await acceptedRelaunch(late, late.chromes[0])
  late.chromes[0].emit("exit", 0, null)
  await settle()
  late.quit()
  late.probes[0]("/")
  await settle()
  assert.equal(late.chromes.length, 1)
  assert.equal(late.menu, false)
})

test("closing the wallet's Chrome with no relaunch pending quits the app", async () => {
  const h = harness()
  await started(h)
  h.chromes[0].emit("exit", 0, null)
  await settle()
  assert.equal(h.closed, 1)
  assert.equal(h.probes.length, 0)
  assert.equal(h.menu, false)
})

test("only the wallet's launch asks for the DevTools pipe", () => {
  const common = {
    hostname: "localhost",
    localPort: 5173,
    spkiSha256: "spki",
    profilePath: "/tmp/profile",
    startPath: "/",
  }
  assert.ok(
    buildChromeArguments({ ...common, devtoolsPipe: true }).includes("--remote-debugging-pipe"),
  )
  assert.ok(!buildChromeArguments(common).includes("--remote-debugging-pipe"))
})

// A stand-in Chrome: reads NUL-terminated commands on fd 3, answers each on fd 4, exits on
// Browser.close.
const FAKE_CHROME = `
const net = require("node:net")
const commands = new net.Socket({ fd: 3, readable: true, writable: false })
const replies = new net.Socket({ fd: 4, readable: false, writable: true })
let buffered = ""
commands.on("data", (chunk) => {
  buffered += chunk
  const messages = buffered.split("\\0")
  buffered = messages.pop()
  for (const message of messages) {
    const command = JSON.parse(message)
    replies.write(JSON.stringify({ id: command.id, result: {} }) + "\\0", () => {
      if (command.method === "Browser.close") process.exit(0)
    })
  }
})
`

test(
  "a piped launch gets fds 3 and 4, answers the probe, and Browser.close reaches the process",
  { skip: process.platform === "win32" && "the stand-in reads its pipes as POSIX sockets" },
  async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-devtools-pipe-"))
    try {
      const script = path.join(directory, "chrome.js")
      fs.writeFileSync(script, FAKE_CHROME)
      const child = launchChrome(process.execPath, [script, "--remote-debugging-pipe"])
      const replies = []
      child.stdio[4].on("data", (chunk) => replies.push(chunk))
      const exited = once(child, "exit")
      await waitForDevtools(child)
      await closeChrome(child)
      assert.deepEqual(await exited, [0, null])
      assert.equal(
        Buffer.concat(replies).toString(),
        '{"id":0,"result":{}}\0{"id":1,"result":{}}\0',
      )

      const pipeless = launchChrome(process.execPath, ["-e", ""])
      assert.equal(pipeless.stdio[3], undefined)
      await once(pipeless, "exit")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
)
