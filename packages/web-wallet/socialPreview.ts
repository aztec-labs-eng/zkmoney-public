import type { Plugin } from "vite"

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

// A payee's pay page, /pay/<tag>. The CDN serves one page for every tag, so the card cannot name it.
const PAY_PREVIEW: PreviewCopy = {
  title: "zk.money pay page",
  description: "Pay privately with zk.money, or from any Ethereum wallet.",
}

/** Every pay page path, all served from pay.html. */
export const PAY_PAGE_PATH = /^\/pay\/[A-Za-z0-9_-]+$/

/**
 * Copies of index.html that differ only in their card. The CDN serves them at /link, /request and
 * /pay/<tag> (iac/modules/app-tier/modules/web-wallet), and `vite preview` resolves /link to
 * link.html itself.
 */
export const ROUTE_PAGES: Record<string, PreviewCopy> = {
  "link.html": LINK_PREVIEW,
  "request.html": LINK_PREVIEW,
  "pay.html": PAY_PREVIEW,
}

const PLACEHOLDER = /__OG_[A-Z_]+__/

function withCopy(html: string, copy: PreviewCopy): string {
  return html
    .replaceAll("__OG_TITLE__", copy.title)
    .replaceAll("__OG_DESCRIPTION__", copy.description)
}

function copyFor(url: string | undefined): PreviewCopy {
  const path = (url ?? "/").split(/[?#]/)[0]
  if (PAY_PAGE_PATH.test(path)) return PAY_PREVIEW
  return path === "/link" || path === "/request" ? LINK_PREVIEW : HOME_PREVIEW
}

/**
 * Fills index.html's card and emits the route pages, so a crawler reads the card from the HTML it
 * fetches. Chat apps need an absolute image URL, and the wallet host is not known at build time
 * everywhere (previews, local): the image is served from VITE_SITE_ORIGIN when set, else from a
 * relative path, and the card degrades to text. Desktop builds emit no route pages: the launcher injects its globals
 * into index.html only.
 */
export function socialPreview(env: Record<string, string>): Plugin {
  const origin = (env.VITE_SITE_ORIGIN ?? "").replace(/\/$/, "")
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
