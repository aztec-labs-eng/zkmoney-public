import type { Plugin } from "vite"

const SETTINGS_MODULE = /[\\/]src[\\/]desktopSettings[\\/]/

/**
 * The desktop launcher's settings page ships only in desktop builds. Fails any other build that
 * still emits code from it, which would mean the route's build-time check stopped folding away.
 */
export function desktopSettingsGuard(): Plugin {
  let desktop = false
  return {
    name: "desktop-settings-guard",
    apply: "build",
    configResolved(config) {
      desktop = config.env.VITE_DESKTOP_BUILD === "true"
    },
    generateBundle(_options, bundle) {
      if (desktop) return
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue
        const leaked = Object.entries(output.modules)
          .filter(([id, module]) => SETTINGS_MODULE.test(id) && module.renderedLength > 0)
          .map(([id]) => id)
        if (leaked.length > 0) {
          const chunk = output.fileName
          this.error(
            `${chunk} carries the desktop settings page outside a desktop build: ${leaked}`,
          )
        }
      }
    },
  }
}
