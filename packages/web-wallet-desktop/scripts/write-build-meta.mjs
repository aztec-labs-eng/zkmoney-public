import { writeFileSync } from "node:fs"
import { assertWebPasskeyBuild } from "../../passkey-web/dist/index.js"

const pageHostname = process.env.DESKTOP_PAGE_HOSTNAME
if (!pageHostname) throw new Error("DESKTOP_PAGE_HOSTNAME is required")
const passkeyRpId = assertWebPasskeyBuild({
  ...process.env,
  VITE_WALLET_URL: `https://${pageHostname}`,
})
writeFileSync(
  new URL("../build-meta.json", import.meta.url),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      bakedNodeUrl: process.env.VITE_NODE_URL,
      pageHostname,
      passkeyRpId,
    },
    null,
    2,
  ) + "\n",
)
