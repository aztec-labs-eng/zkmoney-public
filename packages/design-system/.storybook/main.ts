import type { StorybookConfig } from "@storybook/react-vite"

import { dirname, resolve } from "path"

import { fileURLToPath } from "url"

/**
 * This function is used to resolve the absolute path of a package.
 * It is needed in projects that use Yarn PnP or are set up within a monorepo.
 */
function getAbsolutePath(value: string) {
  return dirname(fileURLToPath(import.meta.resolve(`${value}/package.json`)))
}

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  addons: [],
  framework: getAbsolutePath("@storybook/react-vite"),
  viteFinal: async (viteConfig) => {
    // Stories import the package by name (matches the design-sync bundler's import redirection).
    const dsAlias = {
      "@obsidion/web-ds": resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
    }
    viteConfig.resolve ??= {}
    viteConfig.resolve.alias = Array.isArray(viteConfig.resolve.alias)
      ? [
          ...viteConfig.resolve.alias,
          { find: "@obsidion/web-ds", replacement: dsAlias["@obsidion/web-ds"] },
        ]
      : { ...viteConfig.resolve.alias, ...dsAlias }
    // Prebundle react with CJS interop so ESM deps (e.g. @samasante/liquid-glass) that
    // default-import React don't hit the raw CJS file in dev mode.
    viteConfig.optimizeDeps = {
      ...viteConfig.optimizeDeps,
      include: [
        ...(viteConfig.optimizeDeps?.include ?? []),
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "react-dom/client",
        "@samasante/liquid-glass",
      ],
    }
    return viteConfig
  },
}
export default config
