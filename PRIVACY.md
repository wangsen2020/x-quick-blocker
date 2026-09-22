# Privacy Policy — X Blocker

_Last updated: 2026-09-19_

**X Blocker does not collect, transmit, sell, or share any personal or usage data with the developer or any third party.** It is a local-only Chrome extension: everything it does happens inside your own browser, talking directly to X's (Twitter's) own servers.

## What the extension does

- Adds a one-click "block" icon next to posts on `x.com` / `twitter.com`.
- Lets you define keywords / regular expressions to scan the visible timeline; matching accounts are added to a candidate list that **you review and confirm** before anything is blocked (fully-automatic mode is opt-in and off by default).
- To do this, the extension reads page content already visible to you in your browser (post text, display names, handles) and calls the same internal web API endpoints that `x.com` itself uses (`POST /i/api/1.1/blocks/create.json`, etc.) to block or unblock the accounts you choose, using your existing logged-in session (cookies + CSRF token already present in your browser).

## Data collection

None. The extension:

- Has no backend server.
- Uses no analytics, telemetry, or crash-reporting SDKs.
- Does not send any data to the developer, ever.

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

None. All network requests go directly from your browser to X's own domains — the same requests the `x.com` website already makes when you use its built-in "Block" feature.

## Changes to this policy

Any changes will be committed to this file in the project's GitHub repository, with the update visible in the commit history.

## Contact

Questions or concerns: open an issue at https://github.com/wangsen2020/x-quick-blocker/issues
