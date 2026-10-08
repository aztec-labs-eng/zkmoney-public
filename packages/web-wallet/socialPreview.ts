import type { Plugin } from "vite"
import { campaignOriginFrom } from "./src/config/campaignOrigin"

/** The card a chat app renders from a page's Open Graph tags. */
export interface PreviewCopy {
  title: string
  description: string
}

// The campaign site and the CDN's X card at / show the same card.
export const HOME_PREVIEW: PreviewCopy = {
  title: "zk.money",
  description:
    "Join zk.money to send or receive crypto privately. Open source, self-custodial, built on Ethereum.",
}

// A shared link lands in a chat as /link#… or /request#…. The fragment never reaches a crawler, so
// the card cannot name the amount.
const LINK_PREVIEW: PreviewCopy = {
  title: "zk.money pay link",
  description: "Receive or send crypto privately with pay links.",
}

/**
 * Copies of index.html that differ only in their card. The CDN serves them at /link and /request
 * (iac/modules/app-tier/modules/web-wallet), and `vite preview` resolves /link to link.html itself.
 */
export const ROUTE_PAGES: Record<string, PreviewCopy> = {
  "link.html": LINK_PREVIEW,
  "request.html": LINK_PREVIEW,
}

const PLACEHOLDER = /__OG_[A-Z_]+__/

function withCopy(html: string, copy: PreviewCopy): string {
  return html
    .replaceAll("__OG_TITLE__", copy.title)
    .replaceAll("__OG_DESCRIPTION__", copy.description)
}

function copyFor(url: string | undefined): PreviewCopy {
  const path = (url ?? "/").split(/[?#]/)[0]
  return ROUTE_PAGES[`${path.slice(1)}.html`] ?? HOME_PREVIEW
}

/**
 * Fills index.html's card and emits the route pages, so a crawler reads the card from the HTML it
 * fetches. Chat apps need an absolute image URL, and the wallet host is not known at build time
 * everywhere (previews, local): the image is served from VITE_SITE_ORIGIN when set, else from the
 * paired campaign origin, which is public and ships the same og.png. With neither, a relative path:
 * the card degrades to text. Desktop builds emit no route pages: the launcher injects its globals
 * into index.html only.
 */
export function socialPreview(env: Record<string, string>): Plugin {
  const origin = (env.VITE_SITE_ORIGIN || campaignOriginFrom(env.VITE_CAMPAIGN_URL)).replace(
    /\/$/,
    "",
  )
  const desktop = env.VITE_DESKTOP_BUILD === "true"
  return {
    name: "social-preview",
    // After vite:build-html, which emits index.html in its own generateBundle.
    enforce: "post",
    transformIndexHtml: {
      // Before vite's HTML pass, which treats `og:image` content as an asset URL and would root the
      // placeholder under the page's path.
      order: "pre",
      handler(html, ctx) {
        const withImage = html.replaceAll("__OG_IMAGE_URL__", `${origin}/og.png`)
        return ctx.server ? withCopy(withImage, copyFor(ctx.originalUrl)) : withImage
      },
    },
    generateBundle(_options, bundle) {
      const index = bundle["index.html"]
      if (index?.type !== "asset") return this.error("social-preview: no index.html in the bundle")
      const html = String(index.source)
      const page = (copy: PreviewCopy) => {
        const source = withCopy(html, copy)
        const left = PLACEHOLDER.exec(source)
        if (left) this.error(`social-preview: a page still carries ${left[0]}`)
        return source
      }
      index.source = page(HOME_PREVIEW)
      if (desktop) return
      for (const [fileName, copy] of Object.entries(ROUTE_PAGES)) {
        this.emitFile({ type: "asset", fileName, source: page(copy) })
      }
    },
  }
}
