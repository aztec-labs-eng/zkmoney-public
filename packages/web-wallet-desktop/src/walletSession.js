"use strict"

const { closeChrome, waitForDevtools } = require("./chrome")

const HANDOFF_GRACE_MS = 5_000
const CLOSE_GRACE_MS = 2_000
// A Chrome that owns the profile answers the version request well within this; past it, the silent
// pipe is logged so a settings entry that never turns on can be explained.
const DEVTOOLS_ANSWER_MS = 15_000

/**
 * The wallet's Chrome across relaunches. A relaunch sends Chrome its own close command over the
 * DevTools pipe, and the exit handler starts the replacement; nothing kills Chrome except a quit.
 *
 * The settings entry works only once the piped Chrome has answered on its pipe, proving it owns the
 * profile, and while no relaunch is pending. A pipe-less spawn at any other time (cold start, a
 * relaunch, a quit, a Chrome still starting) would become the profile's owner, and so would one
 * still handing its window over when the wallet's Chrome exits: a relaunch ends those before it
 * starts the replacement, and a quit ends them too.
 */
function createWalletSession({
  // (startPath) => the wallet's ChildProcess, started with the DevTools pipe.
  spawnWallet,
  // () => ChildProcess — hands an extra window to the running Chrome, then exits.
  spawnSettingsWindow,
  // () => Promise<startPath>
  chooseStartPath,
  // (enabled) => void — called when the settings entry turns on or off.
  onMenuChange,
  onSpawnError,
  // The wallet's Chrome exited with no relaunch pending, or while quitting.
  onClosed,
  isQuitting,
  log = console,
}) {
  let current = null
  // The running Chrome has answered on its DevTools pipe.
  let answered = false
  // From the close command until the replacement is spawned.
  let pending = false
  let menuShown = false
  // Settings-window launches that have not exited yet.
  const handoffs = new Set()
  // SIGTERM, then SIGKILL. Resolves on exit, or once the last wait runs out, so a helper that will
  // not die cannot hold the relaunch forever.
  const endHandoff = (helper) =>
    new Promise((resolve) => {
      const later = (ms, action) => {
        const timer = setTimeout(action, ms)
        timer.unref?.()
        return timer
      }
      const timers = [
        later(HANDOFF_GRACE_MS, () => helper.kill("SIGKILL")),
        later(2 * HANDOFF_GRACE_MS, () => {
          log.warn("a settings window did not exit; starting the wallet's Chrome anyway")
          resolve()
        }),
      ]
      helper.once("exit", () => {
        timers.forEach(clearTimeout)
        resolve()
      })
      helper.kill("SIGTERM")
    })
  const endHandoffs = () => Promise.all([...handoffs].map(endHandoff))

  // True once `child` has exited (the exit handler clears `current`), false after `ms`.
  const exitsWithin = (child, ms) =>
    new Promise((resolve) => {
      if (current !== child) return resolve(true)
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
      child.once("exit", () => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  const settingsAvailable = () => current !== null && answered && !pending && !isQuitting()
  const refreshMenu = () => {
    const enabled = settingsAvailable()
    if (enabled === menuShown) return
    menuShown = enabled
    onMenuChange(enabled)
  }

  // Logged only. Once the close command is written a later pipe error cannot take it back, and
  // Chrome's own shutdown may raise one before its exit, which must still count as the relaunch.
  const onPipeError = (error) => {
    log.warn("wallet Chrome's DevTools pipe failed:", error.message)
  }

  const onExit = async (child) => {
    if (current === child) current = null
    refreshMenu()
    if (!pending || isQuitting()) {
      onClosed()
      return
    }
    const [startPath] = await Promise.all([chooseStartPath(), endHandoffs()])
    launch(startPath)
  }

  function launch(startPath) {
    // Every launch follows an awaited probe, so a quit can land in between: the servers are
    // already closing, and a Chrome started now would outlive them.
    if (isQuitting()) return
    const child = spawnWallet(startPath)
    current = child
    answered = false
    pending = false
    child.once("error", (error) => {
      if (current === child) current = null
      refreshMenu()
      onSpawnError(error)
    })
    child.once("exit", () => void onExit(child))
    for (const pipe of [child.stdio[3], child.stdio[4]]) pipe.on("error", onPipeError)
    const silent = setTimeout(() => {
      if (current === child) log.warn("wallet Chrome has not answered on its DevTools pipe")
    }, DEVTOOLS_ANSWER_MS)
    silent.unref?.()
    waitForDevtools(child).then(
      () => {
        clearTimeout(silent)
        if (current !== child) return
        answered = true
        refreshMenu()
      },
      // A pipe that cannot take the command leaves the entry off.
      () => clearTimeout(silent),
    )
    refreshMenu()
  }

  // "accepted" once the close command is written or Chrome exits anyway, since the asking window
  // closes with Chrome.
  async function relaunch() {
    if (pending) return "already-relaunching"
    if (current === null || isQuitting()) throw new Error("The wallet is not running")
    const child = current
    pending = true
    refreshMenu()
    try {
      await closeChrome(child)
    } catch (error) {
      // A pipe that refuses the command usually means Chrome is already exiting, and its exit
      // handler then owns the restart. Only a Chrome still running calls the relaunch off.
      if (await exitsWithin(child, CLOSE_GRACE_MS)) return "accepted"
      pending = false
      refreshMenu()
      throw error
    }
    return "accepted"
  }

  function openSettings() {
    if (!settingsAvailable()) return
    const helper = spawnSettingsWindow()
    handoffs.add(helper)
    let spawned = false
    helper.once("spawn", () => (spawned = true))
    helper.once("exit", () => handoffs.delete(helper))
    // Before "spawn" an error means it never started; after it, a kill failed and it lives on.
    helper.on("error", (error) => {
      if (spawned) log.warn("settings window:", error.message)
      else handoffs.delete(helper)
    })
  }

  // Called once isQuitting() holds. The app-quit path ends Chrome with a signal. The app may exit
  // before any timer runs, so settings windows still opening get SIGKILL at once.
  function stop() {
    refreshMenu()
    for (const helper of handoffs) helper.kill("SIGKILL")
    if (current && !current.killed) current.kill("SIGTERM")
  }

  return { launch, relaunch, openSettings, stop }
}

module.exports = { createWalletSession }
