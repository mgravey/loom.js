# Chrome Web Store submission dossier

- Status: **not ready for submission**
- Prepared: 18 July 2026

Target package: `@loom/extension-codex-experimental` / **Loom Secure Model Bridge**

This dossier is the engineering, privacy, listing, testing, and reviewer handoff for a future Chrome
Web Store submission. It follows the official requirements reviewed on 18 July 2026. Chrome policy
and applicable law can change; re-audit the linked sources immediately before every submission.

## 1. Hard release blockers

Do not upload for public review until every item is resolved.

- [ ] Obtain a supported provider/client-registration path or written confirmation that this
      third-party extension may use the current ChatGPT/Codex authentication and inference
      contracts. The current paths are audited compatibility behavior, not a documented public
      OpenAI OAuth product.
- [ ] Select the actual publishing person/entity and software license.
- [ ] Replace `REPLACE_*` and `.invalid` values in
      `packages/example-codex-experimental/deployment-config.js`.
- [ ] Have qualified counsel review privacy, terms, legal notice/imprint, consumer, data-transfer,
      and target-country obligations.
- [ ] Register and verify the final HTTPS domain, support email, security email, and publisher
      contact details.
- [ ] Complete a live end-to-end test with the release provider account and production origin.
- [ ] Upload a private draft to allocate the permanent Chrome Web Store extension ID, then update
      the website deployment configuration.
- [ ] Produce and review the required Store images and listing copy.
- [ ] Decide distribution: trusted testers/unlisted first is recommended; public only after the
      compatibility and legal blockers are closed.
- [ ] Confirm that the default session-only authorization and the separately confirmed
      private-computer persistence option meet the product requirement and Store disclosures.

Store packaging, privacy pages, and this dossier are readiness infrastructure. They do not resolve
the unsupported provider contract.

## 2. Proposed single purpose

Use this in the Developer Dashboard **Single purpose** field:

> Authenticate a user-initiated Loom coding session and provide its authorized workbench with a
> short-lived credential for a direct-first model request, with an extension relay only when the
> browser receives no HTTP response.

Every feature must remain subordinate to that purpose:

- explicit browser or device-code authentication;
- refresh and account-routing state inside extension storage;
- exact callback transformation;
- short-lived direct-auth delivery to the authorized Loom origin;
- origin-authorized model relay after a direct pre-response failure;
- status and logout; and
- secret-safe diagnostics.

Do not add unrelated browsing, content injection, advertising, analytics, general tab management, or
website automation.

## 3. Draft Store listing

### Name

`Loom Secure Model Bridge`

The name is neutral and does not suggest that Google or OpenAI publishes or endorses the extension.

### Manifest summary (132-character maximum)

`Authenticates Loom sessions and relays model requests only when direct browser access fails.`

### Category

Start with **Developer Tools** if available for the target listing; otherwise use the closest
productivity/developer category shown by the current dashboard.

### Detailed description

> Loom Secure Model Bridge is the login and refresh boundary for the Loom.js browser coding
> workbench.
>
> After you explicitly enable it and sign in, the extension stores authorization in trusted
> extension session storage until Chrome exits. A separate “Remember sign-in on this Chrome profile”
> control can retain the refresh credential and routing ID locally after a private-computer warning.
> The Loom website can ask whether you are authenticated, request a short-lived access token plus
> account-routing ID, or log out. It cannot read or request your refresh or ID credentials. The
> workbench sends prompts, selected project excerpts, tool results, account-routing metadata, and
> short-lived provider authentication to OpenAI/ChatGPT only to produce the model response you
> request. If the direct browser request fails before an HTTP response, the extension processes and
> relays that model traffic. HTTP errors and cancellation are not retried.
>
> The bridge accepts messages only from the declared Loom website origin, and first contact still
> requires a separate exact-origin approval in trusted extension UI. It does not inspect unrelated
> tabs, browsing history, cookies, or page content. It contains no ads or developer analytics.
>
> Project access remains controlled by the Loom website and browser permission prompts. Credentials
> are not passed to project files, OPFS, QuickJS, WebContainer, or Pyodide.
>
> This product is independently developed and is not affiliated with, endorsed by, or supported by
> Google or OpenAI. Provider account eligibility, availability, and terms still apply.

Do not call the integration “official,” “supported by OpenAI,” or “the Codex extension” unless the
relevant trademark owner has explicitly approved that representation.

## 4. Dashboard privacy answers

These answers must match the final code and public privacy policy exactly.

### Permissions justifications

| Dashboard permission/host                  | Reviewer justification                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                                  | Stores explicit enablement, persistence preference, and user-approved exact origins in trusted local extension storage. Refresh/routing state uses trusted session storage by default and moves locally only after explicit confirmation. Pending login/origin requests remain session-only. The website cannot read either storage area. |
| `declarativeNetRequest`                    | Creates one session rule scoped to the user-initiated login tab. It transforms only `http://localhost:1455/auth/callback` into the packaged callback and is removed after a completed callback, handled failure, retry, logout, disable, or browser shutdown.                                                                             |
| `http://localhost:1455/*`                  | Required solely for the registered provider loopback callback. The rule intercepts the main-frame navigation before a localhost server is contacted.                                                                                                                                                                                      |
| `https://auth.openai.com/*`                | Required for user-initiated authorization/device flows and token refresh.                                                                                                                                                                                                                                                                 |
| `https://chatgpt.com/backend-api/codex/*`  | Required only for direct-first fallback. The extension contacts this path after the browser receives no HTTP response and streams the result back to the approved origin.                                                                                                                                                                 |
| `externally_connectable` production origin | Restricts external broker/direct-auth messages to one exact HTTPS Loom website origin. The production packager removes development website origins.                                                                                                                                                                                       |
| web-accessible `callback.html`             | The exact authentication callback transformation must reach the packaged callback page. No executable remote resource is loaded.                                                                                                                                                                                                          |

### Remote code

Select **No, I am not using remote code**, but revalidate the submitted ZIP first.

- all extension JavaScript is bundled inside the package;
- no extension page includes an HTTP(S) script URL;
- no `eval`, `new Function`, or downloaded interpreter logic is used;
- HTTPS authorization/model responses are data, not executable extension logic; and
- browser workbench QuickJS/WebContainer/Pyodide runtimes are website code, not packaged extension
  code and have no extension API access.

### Data categories to disclose

Evaluate and disclose every applicable dashboard category, including:

- authentication information;
- account identifiers / personally identifiable information used for provider routing;
- website or project content included in prompts and tool results;
- personal communications if user conversations can contain them; and
- user-generated content.

Do not claim “no user data” merely because the credential is stored locally. Google treats login and
locally processed data as handled data.

### Data-use certifications

Certify only after verifying the final build:

- data is used only for the disclosed single purpose;
- data is not sold or transferred for advertising, credit, or unrelated purposes;
- human access is not permitted except with specific consent, security necessity, or legal duty;
- user data is transmitted over HTTPS;
- the public policy and in-product disclosure match the behavior; and
- the dedicated public policy contains the Chrome Web Store Limited Use affirmation.

## 5. Public URLs and legal package

Required before submission:

| Purpose              | Target                          |
| -------------------- | ------------------------------- |
| Homepage             | `https://<domain>/`             |
| Privacy policy       | `https://<domain>/privacy.html` |
| Support              | `https://<domain>/support.html` |
| Terms                | `https://<domain>/terms.html`   |
| Legal notice/imprint | `https://<domain>/legal.html`   |

Templates exist in `packages/example-codex-experimental/`. They intentionally show a draft warning
until the publishing identity and real contacts are configured.

The privacy policy must describe collection, use, sharing/recipients, storage, retention, deletion,
security, user choices, applicable rights, international/provider processing, children, changes, and
contact. The options page also contains the prominent pre-enable disclosure required for handled
authentication and user content.

## 6. Store image inventory

Official Store guidance currently requires an icon, small promotional image, and at least one
screenshot.

- [x] Packaged icons: 16×16, 32×32, 48×48, and 128×128 PNG. A compact square crop shortens the long
      input tails so the weave and endpoint rings use substantially more vertical space, including
      almost the full 16px toolbar canvas. The options page uses the full self-contained Lottie
      weave in its heading, as does the bundled privacy page. Both retain the compact 128px asset as
      their reduced-motion and rendering fallback.
- [ ] Required small promotional image: 440×280 PNG/JPEG, brand-led and readable when reduced.
- [ ] At least one screenshot, preferably 3–5: 1280×800 or 640×400, full bleed, actual experience.
- [ ] Optional marquee image: 1400×560 for future featuring.

Recommended screenshots:

1. Extension options showing the disclosure, disabled-by-default state, sign-in choices, and no
   secrets.
2. Workbench authentication status plus workspace modes.
3. A completed model/tool turn with sanitized event output.
4. Privacy/support pages and logout/data-deletion control.

Never include a real account ID, email, token, authorization code, private project, extension debug
log, or provider response body in listing media.

## 7. Reviewer test instructions

Draft text for the **Test instructions** tab:

> 1. Install the extension and open Extension options.
> 2. Confirm authentication is disabled and no credential exists.
> 3. Read the disclosure, enable the bridge, and select the supplied test authentication method.
>    Optionally test “Remember sign-in on this Chrome profile” only in the dedicated review profile.
> 4. Open the production Loom workbench URL supplied below.
> 5. Confirm the preconfigured Store extension ID. The page checks it automatically; select
>    Reconnect only if needed.
> 6. Approve the exact production origin in extension options, return, and reload the workbench.
> 7. Open/import the provided non-sensitive fixture project.
> 8. Submit the supplied test prompt and confirm a streamed response and compact workspace list/read
>    activity rows.
> 9. Return to options, select Remove stored authorization, and confirm the website reports that
>    authentication is required.
>
> The extension does not alter unrelated pages. The localhost callback is transformed by a temporary
> exact tab-scoped DNR rule; no localhost server is required.

Before submission, provide a dedicated test account or provider-approved review method that does not
expose a personal credential. Never place secrets in this repository or listing description.

## 8. Build the submitted ZIP

```sh
LOOM_SITE_ORIGIN=https://<domain> \
LOOM_PRIVACY_URL=https://<domain>/privacy.html \
LOOM_SUPPORT_URL=https://<domain>/support.html \
LOOM_CHROME_EXTENSION_ID=<permanent-store-id> \
pnpm chrome:store:package
```

For the first private draft, omit `LOOM_CHROME_EXTENSION_ID`. The Store assigns the permanent ID.
Then update `deployment-config.js`, deploy the public site configuration, rebuild, and re-upload a
higher manifest version if the submitted package changed.

The packaging variables configure the exact external origin, manifest homepage, public privacy and
support links, and submission metadata. `LOOM_CHROME_EXTENSION_ID` is metadata-only; the extension
does not need to know its own assigned ID. Configure that ID in the companion website instead.

The ZIP is written under ignored `store-artifacts/` with `manifest.json` at its root. Inspect its
contents manually:

```sh
unzip -l store-artifacts/loom-secure-model-bridge-*.zip
```

Confirm:

- [ ] only runtime HTML/JS, icons, privacy disclosure, and manifest are present;
- [ ] `externally_connectable.matches` contains only the exact production HTTPS origin;
- [ ] required localhost/auth/model host permissions are unchanged;
- [ ] no source maps, declarations, `.tsbuildinfo`, test files, credentials, or private keys exist;
- [ ] manifest name, description, version, icons, and minimum Chrome version are correct; and
- [ ] a clean Chrome profile can complete reviewer instructions.

## 9. Submission sequence

1. Enable 2-Step Verification on the publisher account and verify contact emails.
2. Register/set up the Chrome Web Store developer account.
3. Close every hard blocker in section 1.
4. Deploy the final HTTPS website and legal/support pages.
5. Generate and inspect the first production-origin ZIP.
6. Upload as a new draft to allocate the permanent extension ID.
7. Update the website deployment configuration and Store URL.
8. Rebuild/re-upload if the package or manifest must change; increment the version.
9. Complete Store Listing, Privacy, Distribution, and Test Instructions tabs.
10. Begin with trusted testers or unlisted distribution and deferred publication.
11. Perform a Store-installed production smoke test.
12. Submit for review. Monitor the verified publisher email and answer reviewer questions promptly.
13. After approval, publish within the current staged-publication window and monitor support,
    authentication failures, policy updates, and provider contract changes.

## 10. Pre-submission verification gate

```sh
pnpm check
```

Additionally:

- [ ] Chrome Web Store packager succeeds with final URLs;
- [ ] real sign-in and model streaming succeed in the release profile;
- [ ] logout, disable, token rejection, callback expiry, and uninstall deletion are verified;
- [ ] no secrets appear in page/extension logs or Store media;
- [ ] legal, privacy, dashboard disclosures, listing, and actual code agree;
- [ ] permission set has been re-reviewed for minimum access;
- [ ] remote-code scan and manual bundle inspection pass; and
- [ ] provider authorization remains valid on submission day.

## Official references

- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare)
- [Fill out privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Supplying images](https://developer.chrome.com/docs/webstore/images)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Manifest key and development IDs](https://developer.chrome.com/docs/apps/manifest/key)

This dossier is an engineering checklist, not legal advice.
