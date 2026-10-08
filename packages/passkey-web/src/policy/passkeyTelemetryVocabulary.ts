/**
 * The closed vocabulary of the `passkey_ceremony` event and the error-report `env` object. Every
 * value either front sends, and every value the API stores, is one of these, except the `env`
 * object's `aaguid`. Imports nothing, so the API can read this file by path and fail when its
 * projection drifts from it.
 */

export const PASSKEY_CEREMONY_EVENT = "passkey_ceremony"

export const PASSKEY_CEREMONIES = [
  "create",
  "sign_in",
  "unlock",
  "approve_tx",
  "untracked",
] as const
export type PasskeyCeremonyKind = (typeof PASSKEY_CEREMONIES)[number]

export const PASSKEY_OUTCOMES = [
  "succeeded",
  "cancelled",
  "refused",
  "failed",
  "abandoned",
] as const
export type PasskeyOutcome = (typeof PASSKEY_OUTCOMES)[number]

export const PASSKEY_CANCEL_REASONS = ["prompt_closed", "prompt_aborted", "in_app_cancel"] as const
export type PasskeyCancelReason = (typeof PASSKEY_CANCEL_REASONS)[number]

export const PASSKEY_REFUSAL_REASONS = [
  "security_key_required",
  "phone_required",
  "local_passkey_required",
  "not_synced",
  "security_key_no_prf",
  "incomplete_creation",
  "no_prf",
  "single_salt_provider",
  "provider_not_supported",
  "no_wallet_for_passkey",
  "phone_unreachable",
  "rotated_credential",
  "ambiguous_passkey",
  "related_origin",
  "passkey_mismatch",
] as const
export type PasskeyRefusalReason = (typeof PASSKEY_REFUSAL_REASONS)[number]

export const PASSKEY_FAILURE_REASONS = [
  "request_stuck",
  "no_credential_returned",
  "unsupported_algorithm",
  "invalid_state",
  "security_error",
  "not_supported",
  "constraint",
  "signer_mismatch",
  "session_lost",
  "registry_unconfirmed",
  "request_failed",
  "after_prompt",
] as const
export type PasskeyFailureReason = (typeof PASSKEY_FAILURE_REASONS)[number]

export const PASSKEY_REASONS = [
  ...PASSKEY_CANCEL_REASONS,
  ...PASSKEY_REFUSAL_REASONS,
  ...PASSKEY_FAILURE_REASONS,
] as const
export type PasskeyReason = (typeof PASSKEY_REASONS)[number]

export const PASSKEY_PROVIDERS = [
  "icloud_keychain",
  "google_password_manager",
  "chrome_profile",
  "windows_hello",
  "1password",
  "bitwarden",
  "nordpass",
  "dashlane",
  "proton_pass",
  "samsung_pass",
  "yubikey",
  "not_reported",
  "other",
  "unknown",
] as const
export type PasskeyProvider = (typeof PASSKEY_PROVIDERS)[number]

export const PASSKEY_CREDENTIAL_CREATED = ["yes", "no"] as const
export type PasskeyCredentialCreated = (typeof PASSKEY_CREDENTIAL_CREATED)[number]

export const PASSKEY_BACKUP_ELIGIBLE = ["yes", "no", "unknown"] as const
export type PasskeyBackupEligible = (typeof PASSKEY_BACKUP_ELIGIBLE)[number]

export const PASSKEY_ROUTES = ["same_device", "phone_qr", "security_key", "unknown"] as const
export type PasskeyRoute = (typeof PASSKEY_ROUTES)[number]

export const PASSKEY_PROMPTS = ["0", "1", "2+"] as const
export type PasskeyPrompts = (typeof PASSKEY_PROMPTS)[number]

export const PASSKEY_ATTEMPTS = ["1", "2", "3+"] as const
export type PasskeyAttempt = (typeof PASSKEY_ATTEMPTS)[number]

export const PASSKEY_ELAPSED = ["under_1s", "1_10s", "10_60s", "over_60s"] as const
export type PasskeyElapsed = (typeof PASSKEY_ELAPSED)[number]

/**
 * What a laptop's phone-route check answered, on a creation it let start. A browser below the
 * floor is refused, and its row says so in `reason`.
 */
export const PASSKEY_PHONE_REACHES = ["ok", "no_hybrid", "unknown"] as const
export type PasskeyPhoneReach = (typeof PASSKEY_PHONE_REACHES)[number]

export const PASSKEY_DEVICE_CLASSES = ["phone", "laptop"] as const
export type PasskeyDeviceClass = (typeof PASSKEY_DEVICE_CLASSES)[number]

export const PASSKEY_OS_FAMILIES = [
  "ios",
  "macos",
  "android",
  "windows",
  "linux",
  "chromeos",
  "unknown",
] as const
export type PasskeyOs = (typeof PASSKEY_OS_FAMILIES)[number]

export const PASSKEY_BROWSER_FAMILIES = [
  "safari",
  "chrome",
  "edge",
  "firefox",
  "samsung",
  "brave",
  "unknown",
] as const
export type PasskeyBrowser = (typeof PASSKEY_BROWSER_FAMILIES)[number]

export const PASSKEY_FLOWS = [
  "enter",
  "handoff",
  "onboarding",
  "unlock",
  "deposit",
  "send",
  "paylink-create",
  "paylink-claim-l1",
  "withdraw",
  "other",
] as const
export type PasskeyFlow = (typeof PASSKEY_FLOWS)[number]

/** `os_major` and `browser_major` are whole numbers in this range, or absent. */
export const PASSKEY_MAJOR_MIN = 1
export const PASSKEY_MAJOR_MAX = 999

/** Every event prop that takes a listed value. */
export const PASSKEY_CEREMONY_ENUM_PROPS = {
  ceremony: PASSKEY_CEREMONIES,
  outcome: PASSKEY_OUTCOMES,
  reason: PASSKEY_REASONS,
  provider: PASSKEY_PROVIDERS,
  credential_created: PASSKEY_CREDENTIAL_CREATED,
  backup_eligible: PASSKEY_BACKUP_ELIGIBLE,
  route: PASSKEY_ROUTES,
  prompts: PASSKEY_PROMPTS,
  attempt: PASSKEY_ATTEMPTS,
  elapsed: PASSKEY_ELAPSED,
  phone_reach: PASSKEY_PHONE_REACHES,
  device_class: PASSKEY_DEVICE_CLASSES,
  os: PASSKEY_OS_FAMILIES,
  browser: PASSKEY_BROWSER_FAMILIES,
  flow: PASSKEY_FLOWS,
} as const

/** Every event prop that takes a major version. */
export const PASSKEY_CEREMONY_INTEGER_PROPS = ["os_major", "browser_major"] as const

/** The error-report `env` object's keys. */
export const PASSKEY_REPORT_ENV_KEYS = [
  "device_class",
  "os",
  "os_major",
  "browser",
  "browser_major",
  "provider",
  "aaguid",
] as const

/**
 * The only `platform` values the event is stored under. `web` is the wallet with a consent answer
 * behind it; `web-signup` is the same wallet reporting a signup step, carrying no identifier.
 */
export const PASSKEY_TELEMETRY_PLATFORMS = ["web", "web-signup", "campaign-web"] as const
export type PasskeyTelemetryPlatform = (typeof PASSKEY_TELEMETRY_PLATFORMS)[number]

/** The campaign's one `app_version`. */
export const PASSKEY_CAMPAIGN_APP_VERSION = "1"
