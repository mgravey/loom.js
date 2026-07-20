# GitHub Pages deployment

The `loom.js` project site is prepared for:

```text
https://mgravey.com/loom.js/
```

The `mgravey.github.io` user site already uses `mgravey.com` as its custom domain. GitHub applies a
user site's custom domain to project sites by default, so the `loom.js` repository is served beneath
the inherited `/loom.js/` path. Do not configure `mgravey.com` again as this project's custom
domain: that would override the inherited project path rather than create it.

GitHub documents this inherited custom-domain behavior under
[Using a custom domain across multiple repositories](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages#using-a-custom-domain-across-multiple-repositories).

## One-time repository setting

In the `mgravey/loom.js` repository:

1. Open **Settings → Pages**.
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Do not set a project-level custom domain while the inherited `mgravey.com/loom.js/` URL is
   desired.
4. Confirm the account-level `mgravey.com` domain is verified and HTTPS is enforced on the
   `mgravey.github.io` user site.

GitHub requires Pages to be enabled before a custom deployment workflow can publish. The workflow
uses `actions/configure-pages@v5`, `actions/upload-pages-artifact@v4`, and
`actions/deploy-pages@v4`, with the required Pages and OIDC permissions.

## Deployment

Pushing `master` or `main` runs `.github/workflows/pages.yml`. It:

1. installs the pinned pnpm/Node toolchain;
2. builds `@loom/example-codex-experimental`;
3. creates a validated static artifact under ignored `site-preview/`;
4. uploads that artifact to GitHub Pages; and
5. deploys it through the protected `github-pages` environment.

The artifact root contains `index.html`; GitHub supplies the `/loom.js/` project prefix. All site
links and assets are relative, so welcome, documentation, legal, support, installation, and
workbench pages continue to work below that prefix. `.nojekyll` prevents Jekyll from rewriting the
artifact.

Build and inspect the same artifact locally:

```sh
pnpm site:pages:build
python3 -m http.server 4173 --directory site-preview
```

The local artifact opens at <http://localhost:4173/> while its generated production configuration
records `https://mgravey.com/loom.js/`.

## Repository variables

The workflow reads these optional non-secret variables from **Settings → Secrets and variables →
Actions → Variables**:

| Variable                    | When to set it                                                                   |
| --------------------------- | -------------------------------------------------------------------------------- |
| `LOOM_CHROME_EXTENSION_ID`  | After the first Chrome Web Store draft assigns the permanent 32-character ID.    |
| `LOOM_CHROME_WEB_STORE_URL` | After the final `chromewebstore.google.com` listing URL exists.                  |
| `LOOM_LEGAL_NAME`           | Before public Store review, using the legally reviewed publishing person/entity. |
| `LOOM_LEGAL_ADDRESS`        | Before public Store review, using the legally reviewed publisher postal address. |

Support and security contacts are fixed to `sideproject@mgravey.com`. Until both legal variables are
configured, the deployed privacy, terms, and legal pages intentionally retain their visible draft
warning.

## Chrome extension origin

The Chrome extension sees origins, not URL paths. A Store build for this site therefore allows
`https://mgravey.com/*`, and the user approves the `https://mgravey.com` origin—not only
`/loom.js/`. Every application hosted on that origin must consequently be treated as part of the
same trust boundary. A dedicated subdomain such as `loom.mgravey.com` would provide tighter origin
isolation if that becomes desirable before Store review.

## Static-host limitation

GitHub Pages serves the site and workbench without an application server. It does not provide the
custom COOP/COEP response headers required by WebContainer's Node.js runtime. The landing pages,
documentation, extension connection, workspace features, QuickJS, and compatible Pyodide behavior
remain static-browser functionality; host the workbench behind a header-capable HTTPS service if the
Node.js runtime must be supported in production.
