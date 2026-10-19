/**
 * Counts the "open this in your browser" card: its first display per page load per moment, and
 * each control tapped. Displays and taps, never people: the events carry no identifier, a reload
 * counts again, and leaving through the app's own menu sends nothing.
 */
import { currentAppDropsOpenLink, currentUserAgentInfoSync } from "@obsidion/passkey-web"
import { fireOnboardingEvent } from "../../lib/analytics"

/** The surfaces that count the card; any other report context sends nothing. */
export const IN_APP_CARD_SCREENS = ["enter", "onboarding"] as const
export type InAppCardScreen = (typeof IN_APP_CARD_SCREENS)[number]

/** Before any passkey request, or after one failed. */
export type InAppCardWhen = "up_front" | "after_miss"
export type InAppCardControl = "open_link" | "copy_link" | "update_link"
export type InAppBrowser = "ios_x" | "ios_other" | "android_x" | "android_other"

export interface InAppCardContext {
  when: InAppCardWhen
  screen: InAppCardScreen
}

export function inAppCardScreen(reportContext: string): InAppCardScreen | undefined {
  return (IN_APP_CARD_SCREENS as readonly string[]).includes(reportContext)
    ? (reportContext as InAppCardScreen)
    : undefined
}

/**
 * The app whose browser this page is in. Read only where the card rendered, so any OS but iOS is
 * taken as Android; X is the app that drops the Open in browser link.
 */
export function currentInAppBrowser(): InAppBrowser {
  const ios = currentUserAgentInfoSync().osFamily === "ios"
  const x = currentAppDropsOpenLink()
  if (ios) return x ? "ios_x" : "ios_other"
  return x ? "android_x" : "android_other"
}

const shown = new Set<InAppCardWhen>()

/** The card's way out rendered. Once per page load per moment: a re-render or a second screen adds nothing. */
export function inAppCardShown(context: InAppCardContext): void {
  if (shown.has(context.when)) return
  shown.add(context.when)
  fireOnboardingEvent("onboarding_in_app_shown", {
    when: context.when,
    screen: context.screen,
    in_app: currentInAppBrowser(),
  })
}

/** One of the card's controls was activated. Every activation counts; a tap is not a departure. */
export function inAppCardTapped(context: InAppCardContext, control: InAppCardControl): void {
  fireOnboardingEvent("onboarding_in_app_exit", {
    when: context.when,
    screen: context.screen,
    in_app: currentInAppBrowser(),
    control,
  })
}

/** Test seam: forgets which moments this page load has counted. */
export function resetInAppCardCountsForTests(): void {
  shown.clear()
}
