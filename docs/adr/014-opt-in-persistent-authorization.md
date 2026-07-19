# ADR-014: Allow explicit profile-local authorization persistence

- Status: Accepted
- Date: 2026-07-19
- Supersedes: ADR-009's session-only refresh/routing retention rule

## Context

ADR-009 deliberately kept the experimental refresh credential and ChatGPT account-routing ID in
`chrome.storage.session`, forcing a new sign-in after Chrome restarted. This is the safest default,
but it makes repeated use on a private computer unnecessarily disruptive.

Chrome's extension-local storage survives a browser restart and is scoped to the extension on the
current machine/profile. It is not an encrypted operating-system credential vault. Anyone able to
use or compromise the unlocked Chrome profile may be able to use the stored authorization.

## Decision

Keep session storage as the default. Add a trusted extension-options control named **Remember
sign-in on this Chrome profile**. Enabling it requires an explicit private-computer warning and
moves only the refresh credential plus account-routing ID to `chrome.storage.local` with
`TRUSTED_CONTEXTS` access. Do not use website storage, cookies, or `chrome.storage.sync`.

Access tokens remain memory-only, raw ID tokens are never persisted, and PKCE verifier, state,
callback bridge, and redirect rule data remain session-only. The account-routing ID stays paired
with the refresh credential so a remembered grant continues to target the account selected during
authorization.

Mode changes write and verify the destination before changing the preference, then delete the old
copy. Initialization deletes inactive and incomplete state. Logout, experiment disable, credential
rejection, and explicit storage clearing remove authorization from both areas. Turning persistence
off moves a current authorization back to session storage before deleting the local copy.

## Consequences

Users on private computers can remain authorized after closing Chrome. The option does not bind the
grant to a Loom website user, an operating-system unlock, or a Google account; the effective user
boundary is the current unlocked Chrome profile. The UI and privacy disclosures must state this
limitation without implying encryption.

The extension continues to need only its existing `storage` permission. Tests must cover the session
default, both migration directions, reconstruction with an empty session area, rotated refresh
credentials, incomplete-state cleanup, and deletion from both areas.
