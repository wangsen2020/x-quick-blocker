# Privacy Policy — X Blocker

_Last updated: 2026-10-06_

**X Blocker does not collect, transmit, sell, or share any personal or usage data with the developer or any third party.** It is a local-only Chrome extension: blocking, scanning and settings stay in your browser, with block/unblock requests sent directly to X's (Twitter's) own servers. Installation and uninstall also open the product website as described below.

## What the extension does

- Adds a one-click "block" icon next to posts on `x.com` / `twitter.com`.
- Lets you define keywords / regular expressions to scan the visible timeline; matching accounts are added to a candidate list that **you review and confirm** before anything is blocked (fully-automatic mode is opt-in and off by default).
- To do this, the extension reads page content already visible to you in your browser (post text, display names, handles) and calls the same internal web API endpoints that `x.com` itself uses (`POST /i/api/1.1/blocks/create.json`, etc.) to block or unblock the accounts you choose, using your existing logged-in session (cookies + CSRF token already present in your browser).

## Data collection

None. The extension:

- Has no backend server.
- Uses no analytics, telemetry, or crash-reporting SDKs.
- Does not send timeline content, account identifiers, filters or action logs to the developer. Product website URLs carry only the technical metadata described below.

## Data storage

Everything below is stored **only on your device**, using `chrome.storage.local` (mirrored into `x.com`'s own `localStorage` so your settings survive an extension reinstall):

- Your keyword / regex filters and allowlist.
- Your settings (throttling, matching scope, automation toggle, etc.).
- A local action log (who was blocked/unblocked, when, and which rule matched) — used only to let you review and undo actions.
- A short-lived technical cache (X's internal GraphQL query IDs and `screen_name → user_id` lookups) needed to call the block endpoint reliably.

None of this data ever leaves your browser, and it is deleted if you remove the extension or clear site data for `x.com`.

## Permissions justification

| Permission | Why it's needed |
| --- | --- |
| `storage` | Save your filters, settings and log locally in the browser. |
| Host access to `x.com`, `twitter.com`, `api.x.com`, `api.twitter.com` | Inject the block button / panel UI into the page, and call X's own block/unblock API endpoints on your behalf. |

The extension requests no other permissions (no `tabs`, no `<all_urls>`, no `webRequest` blocking, no remote code execution).

## Third parties

Blocking requests go directly from your browser to X's own domains — the same requests the `x.com` website already makes when you use its built-in "Block" feature. The product website handles welcome visits and voluntary feedback separately, as described below.

## Install welcome and voluntary uninstall feedback

The extension stores its first install date locally and opens a localized welcome page on installation. Uninstalling opens a website page whose URL carries only the extension version, browser UI language, install date (when available), fixed `utm_*` values and the fixed product code `ext=xbl`. It carries no user or account identifier, filters, browsing history or action log. Submitting feedback and providing contact details or permission for an X direct message are voluntary. Feedback submitted on that page is handled by the website rather than the extension.

## Changes to this policy

Any changes will be committed to this file in the project's GitHub repository, with the update visible in the commit history.

## Contact

Questions or concerns: open an issue at https://github.com/wangsen2020/x-quick-blocker/issues
