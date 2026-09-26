# Mobile Contacts and Share

ULT-783 uses the existing contact directory, registry lookup and fresh verification before saving. At phone widths, Contacts owns its centered back/title row and search; `App.tsx` opts exact `/contacts` into `SidebarLayout.mobilePageHeaderPaths`. The page follows the 80px reference header and 24px horizontal insets, with safe areas applied once by its outer content container. It scrolls naturally without a fixed header-height subtraction. The existing background glow is positioned for the Contacts content frame. Desktop keeps its existing header, search and directory layout. A one-shot `/contacts` route state `{searchTag: normalizedTag}` prefills and focuses the existing search, then removes only that key with a history replacement. Saving still requires an explicit Add. The shared search shows local matches, lookup progress, an explicit Add action for an unsaved result, and a not-found state. Add remains busy through fresh verification. Verification errors stay next to the result for retry, and editing or dismissing a search invalidates its pending navigation and verification.

On phones, incoming notification toasts do not appear while Contacts owns the header; persisted notifications remain accessible through the shell bell on other routes. Locked Contacts retains the shell brand lockup and menu until unlock.

## Web Figma phone geometry

The Contacts reference is web-wallet node `10231:67168`, a 402×678 content frame without browser chrome. The phone page uses an 80px title row, 24px content insets, a 44px search field, 8px between each section label and card, and 8px between sections. Cards keep 12px padding and 16px row gaps; ordinary rows are 52px tall with a 44px avatar and a 28px initial. Long names can increase a row's height. The search placeholder is 14px; the input remains 16px to avoid phone focus zoom. These geometry styles are scoped to Contacts and do not alter the shell's expanded search. Both phone search consumers use the web Figma search glyph; only `.ww-search__suffix` is hidden on phones. Desktop keeps its original glyph and suffix.

The optional trailing action sits immediately after `TagSearchBar` inside `.ww-contacts__search`. The wrapper has one flexible column until `.ww-contacts__search-action` is present, then uses `minmax(0, 1fr) 44px` with an 8px gap. Search results remain in the first column and the action stays at the input's top edge. ULT-785 supplies the guarded `Scan QR code` button and its focus-return reference; it also removes the extra title-row Share action. Keyboard order follows the input and then Scan. Existing blur/outside cancellation and one-shot destination search focus remain in place.

The Contacts background reuses the exact web Figma circle artwork, preserving its intrinsic filter bounds inside the 1280×749 reference frame instead of stretching the SVG to that frame. This adjustment applies only while the Contacts page is present. Desktop and other flow backgrounds retain their existing styles.

Phone controls consume the shared `PhoneIcon` assets without changing design-system defaults. Contacts keeps a 44px Back hit target with a 40px visible circle and uses a 24px back glyph, 18px search glyph and 16px row chevrons. Share uses a 24px share arrow and Close glyph, a 16px copy glyph, and a 20px optional scan glyph. Its phone `bare` Modal owns a 44px Close target with the reference 30px visible circle; desktop keeps the existing `create` variant. A breakpoint change keeps the same mint session and restores focus inside the dialog if a focused control is replaced.

Phone Share uses the web reference subtitle “Let other users find you”, 16px subtitle text, 48px filled action buttons and 24px body gaps. The functional differences retained by the design correction are Copy link and the full handshake packet, the denser generated QR, the phone contrast correction, recovery/loading controls, safe areas and scrolling. Fixture identities and browser chrome are not design comparisons. Scanner capability and manual-input behavior remain owned by ULT-785; physical-device and design acceptance remain separate gates.

## Activity recency

The web activity subscription hydrates the existing account stores, follows their change events, rejects stale overlapping reads and removes listeners on unmount. `recentContacts` in front-core selects up to three saved contacts by their latest recorded interaction. It uses transfer timestamps, contact-request creation times and bridge start times. It matches L2 addresses or normalized tags, and matches current L1 addresses using the same provider rule as contact storage: generic or missing providers match a known provider; distinct known providers remain separate. It excludes unknown contacts, cancelled requests, locally cancelled transfers without a transaction hash and unfunded SIPA deposits. A directory without activity has no Recent section. Completion and polling times do not move a contact forward.

## Share and QR

Share keeps a full newly minted connect link in the generated QR, Web Share and both copy controls. An optional `onScan` callback renders the scan entry; without it the entry is hidden. The parent owns switching between Share and Scan and mounts a new Share session on return. Mint errors expose Retry. Closing or switching during mint prevents a late mint from starting a new ledger write or updating the closed surface.

Phone Share is centered with 24px outside each safe-area edge, 24px inner padding and an internal height limit. The Figma reference at node `10212:62707` has a 402×678 app body; its surrounding browser strips are excluded from comparison. Phone QR code padding is 17px: the 270px long-packet inset case fails raw pixel decoding at 16px and passes at 17px. The card and label keep their reference width. This is a narrow measured window at DPR 1: 17px and 18px passed, while 12px, 14px, 15px, 16px, 20px and 24px failed for that same packet and 270px card. It is not a measured safety margin for other packets, device pixel ratios or cameras. The unchanged production contrast fallback also failed on the original 16px-padding image. DPR 2–3 and physical-camera validation remain external checks. Desktop Share geometry and QR styling remain unchanged.

The existing white overlay on the QR gradient prevents jsQR 1.4.0 from reading the test corpus. At widths up to 640px, Share removes that overlay while retaining the gradient and generated white modules. The phone correction decoded all nine tagged, tagless and long-packet cases at 390×844, 402×879 and 390×667. The initial foundation CSS decoded none of those nine cases. The three 1280×832 desktop QR images are byte-for-byte identical before and after this change; both versions fail this decoder corpus. That desktop limitation is pre-existing and is not presented as a successful decode check.

The explicit `pnpm test:qr` command requires a provisioned Chromium cache; ordinary `pnpm test` remains browser-free. `test/gradientQrCard.browser.tsx` mints real connect packets, renders the production QR component with the actual stylesheet in Chromium, and decodes unprocessed screenshot pixels with jsQR. It compares the decoded string with the full payload and parses it with the shared connect codec. Tests use public deterministic fixture keys and write PNGs and a JSON report outside the repository. This validates the rendered codec path, separate from scanner mocks and physical-camera testing.

```sh
PLAYWRIGHT_BROWSERS_PATH=/path/to/ms-playwright QR_EVIDENCE_DIR=/tmp/contact-qr pnpm test:qr
```

For a baseline measurement, set `QR_BASELINE_CSS` to the stylesheet extracted from the initial commit. Baseline mode records decoder outcomes without requiring the unfixed phone screenshots to decode. Preserve its report and images next to the fixed corpus. Physical-device camera readability remains a separate check.

## Demo fixtures

The repository capture plans use local data and block external services. Run them from `packages/web-wallet` with `pnpm ui:capture --plan scripts/ui-capture/plans/<name>.json --preset all --port 5783 --browser-cache /path/to/ms-playwright`.

| Plan | Data and states |
| --- | --- |
| `contacts-empty` | Fresh wallet without contacts |
| `contacts` | 26 contacts, long L1 and L2 labels, recorded activity and scrolling |
| `contact-search` | Local, lookup, resolved, not found, fresh verification busy/error/retry and save |
| `shell-contact-search` | The same lookup and save states through the expanded shell search |
| `contact-search-races` | Edit during verification, address mismatch and Escape dismissal |
| `share-tag` | Real connect mint pending, ready and copy feedback |
| `share-tag-retry` | Recoverable mint failure and retry |
| `share-tag-long` | Real long-origin, maximum-tag-length connect packet |

Capture reports establish local rendering and navigation. Physical iOS Safari and Android Chrome keyboard/toolbars, device QR readability and design review remain external acceptance checks.

The input label is `Search @tag`, the result region is `Contact search results`, and the explicit save action is `Add contact @<tag>`. The Share dialog is `Share @tag` and the generated QR is `My connect QR code`. The field keeps 16px text on phones to avoid focus zoom; Scan is supplied by ULT-785 when functional. Existing L1 names and L2 tags remain searchable.

Validation before the design-fidelity correction passed 1,043 web unit tests, 12 front-core recency tests, package builds and web typecheck. The dedicated browser suite passed 18 checks: 15 exact phone payload decodes (including 402×678 and simulated safe areas) plus three unchanged-desktop-style checks. The original/current desktop QR PNG hashes match. Capture reports must be checked for `geometry.scrollWidth <= viewport.width` in addition to the harness `ok` field, which covers service and console failures.

The design-fidelity integration passed 1,058 wallet unit tests, 12 front-core recency tests and web typecheck. Its changed-size QR corpus passed all 15 phone payload decodes, including the 270px inset case. The failed 16px-padding pixels and the passing 17px-padding pixels are preserved separately. This is browser pixel evidence, not physical-camera or design approval.
