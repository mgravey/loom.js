# Chrome Web Store media

## Ready-to-paste listing copy

### Name

```text
Loom.js Companion
```

### Summary

```text
Authenticates Loom sessions and relays model requests only when direct browser access fails.
```

### Category and language

- Category: **Developer Tools**
- Language: **English**

### Detailed description

```text
Loom.js Companion connects the Loom.js browser coding workbench to a user-initiated ChatGPT sign-in while keeping long-lived authorization inside the extension.

After you explicitly enable the extension and sign in, authorization is stored in trusted extension session storage until Chrome exits. On a private computer, you can separately choose to remember the sign-in on that Chrome profile.

The extension lets you:
• approve each workbench website by its exact origin;
• check authentication status and sign out;
• provide a short-lived access token and account-routing ID to an approved workbench; and
• relay a model request only when the browser's direct request fails before receiving an HTTP response.

Any HTTPS website can request to appear in the extension's approval list, but authentication and model operations remain blocked until you approve that exact origin from the trusted extension options page. Local HTTP access is restricted to the Loom.js development server.

Loom.js Companion does not inspect unrelated tabs, browsing history, cookies, or page content. It contains no advertising or developer analytics. Refresh and ID credentials are not exposed to websites, project files, OPFS, QuickJS, WebContainer, or Pyodide.

The approved Loom.js workbench sends prompts, selected project context, tool results, account-routing metadata, and short-lived provider authentication to OpenAI/ChatGPT only to produce the response you request.

This is an experimental, independently developed integration. It is not affiliated with, endorsed by, or supported by Google or OpenAI. Provider account eligibility, availability, and terms still apply.
```

## Submission assets

| Dashboard field  | File                                                                   | Required size |
| ---------------- | ---------------------------------------------------------------------- | ------------- |
| Store icon       | [`../icons/icon128.png`](../icons/icon128.png)                         | 128×128 PNG   |
| Small promo tile | [`promo-small-440x280.png`](./promo-small-440x280.png)                 | 440×280 PNG   |
| Screenshot       | [`screenshot-options-1280x800.png`](./screenshot-options-1280x800.png) | 1280×800 PNG  |

The marquee promo tile and promotional video are optional. The required media above is generated and
verified from repository-owned assets.

## Regenerate media

Generate the final listing media from the packaged extension and the approved Loom Direction 08
mark:

```sh
pnpm chrome:store:media
```

The command writes and validates:

- `promo-small-440x280.png` — required small promotional image;
- `screenshot-options-1280x800.png` — required screenshot of the actual packaged options page; and
- `media-manifest.json` — exact dimensions, SHA-256 digests, and provenance.

The media files are uploaded separately in the Chrome Web Store Developer Dashboard. They must not
be added to the extension ZIP. Re-run the command after any visible options-page or brand change and
review both images at full size before uploading.
