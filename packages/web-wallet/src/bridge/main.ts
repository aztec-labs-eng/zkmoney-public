import { selectWebPasskeyRpId } from "@obsidion/passkey-web"
/**
 * Entry of `bridge.html`, the page the campaign frames on the wallet origin. Built on its own
 * (`vite.bridge.config.ts`) into one self-contained file: no React, no config boot, no PXE. It
 * reads its two facts from the build, not from the profile the app boots from.
 */
import { campaignOriginFrom } from "../config/campaignOrigin"
import { installBridge } from "./listener"

installBridge(window, {
  campaignOrigin: campaignOriginFrom(import.meta.env.VITE_CAMPAIGN_URL),
  rpId: selectWebPasskeyRpId(import.meta.env),
})
