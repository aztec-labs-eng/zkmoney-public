"use strict"

const fs = require("node:fs")
const path = require("node:path")
const { validateHostname } = require("../src/config")

function composeLauncherConfig(config, metadata) {
  const hostname = validateHostname(metadata.pageHostname)
  const passkeyRpId = validateHostname(metadata.passkeyRpId)
  return {
    ...config,
    hostname,
    passkeyRpId,
    localPort: hostname === "localhost" ? 5173 : 0,
    proxies:
      hostname === "localhost"
        ? config.proxies
        : {
            "/svc/predicate": `https://${hostname}/svc/predicate`,
          },
  }
}

function writeLauncherConfig(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config/default.json"), "utf8"))
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "build-meta.json"), "utf8"))
  fs.writeFileSync(
    path.join(root, "config/generated.json"),
    JSON.stringify(composeLauncherConfig(config, metadata), null, 2) + "\n",
  )
}

if (require.main === module) writeLauncherConfig(path.resolve(__dirname, ".."))

module.exports = { composeLauncherConfig, writeLauncherConfig }
