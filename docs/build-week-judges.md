# Loom.js Build Week judge guide

## Project in one sentence

Loom.js is a provider-neutral, browser-native runtime that composes AI models, tools, project
workspaces, storage, and JavaScript, Node.js, or Python execution behind replaceable plugins.

The current working demonstration uses ChatGPT first. An experimental Chrome companion lets an
eligible user sign in through a Codex-compatible ChatGPT flow without pasting a Platform API key
into the workbench page. The runtime is designed to support additional providers through model and
transport adapters.

## Public links

- Project site: <https://www.mgravey.com/loom.js/>
- Browser workbench: <https://www.mgravey.com/loom.js/workbench.html>
- Interactive documentation: <https://www.mgravey.com/loom.js/docs.html>
- Source repository: <https://github.com/mgravey/loom.js>

## How Codex and GPT-5.6 were used

Codex was a primary engineering collaborator throughout the project. GPT-5.6-sol powered Codex
sessions used for:

- architecture exploration and enforcement of provider-neutral package boundaries;
- TypeScript implementation and refactoring across the monorepo;
- focused unit, integration, and real-Chromium test development;
- debugging the browser workbench, extension messaging, origin approval, model transport, and
  deployment behavior;
- security review of credential, workspace, ZIP, and execution-runtime boundaries;
- technical documentation, onboarding, branding integration, and submission preparation.

The repository and its real acceptance commands were available to Codex during this work. Changes
were validated against strict TypeScript, architectural lint rules, Vitest coverage gates,
Playwright browser tests, builds, Chrome extension packaging checks, and formatting rules.

GPT-5.6-sol also runs inside the Loom.js demonstration. The workbench defaults to `gpt-5.6-sol` and
uses the GPT-5.6 Responses Lite input-item shape. Loom translates streamed model output into session
events and tool requests, validates tool calls, executes approved workspace or runtime operations,
and supplies their results to the next model turn.

## What to test without authentication

Open the [project site](https://www.mgravey.com/loom.js/) to review the product explanation,
architecture, onboarding, legal pages, and workbench interface. The repository can be built and its
complete automated acceptance suite can be run without live credentials.

```sh
git clone https://github.com/mgravey/loom.js.git
cd loom.js
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Recommended tooling is Node.js 22 and pnpm 11.7.0. The package metadata permits Node.js 20.19 or
newer.

## Test the complete experimental ChatGPT workbench

The real-provider path is deliberately disabled by default and is not a supported OpenAI OAuth
integration. It requires Chrome or Chromium 116 or newer and an eligible judge-owned ChatGPT
account. No shared submission credentials are provided or required.

1. Build the experimental companion:

   ```sh
   pnpm --filter @mgravey/loom-extension-codex-experimental build
   ```

2. Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose
   `packages/extension-codex-experimental/dist`.
3. Open the extension options, read the warning, enable the experiment, and choose **Sign in with
   ChatGPT** or the device-code fallback.
4. Start the local site:

   ```sh
   python3 -m http.server 4173 --directory packages
   ```

5. Open <http://localhost:4173/example-codex-experimental/workbench.html>.
6. Enter the unpacked extension ID if it is not already configured, approve the exact localhost
   origin in trusted extension UI, and reload the workbench.
7. Choose a local-folder, temporary-memory, or persistent-browser workspace.
8. Submit a coding request, inspect the workspace tool activity, and ask the agent to execute the
   result with QuickJS, WebContainer Node.js, or Pyodide Python.
9. Log out after testing. Logout removes the stored refresh credential and account-routing state.

Model availability is controlled by the signed-in account and may change independently of Loom.js.
Never paste tokens, cookies, or Platform API keys into the workbench.

## Suggested judge prompt

For a small memory or OPFS project, submit:

> Create a Python script that generates a labeled chart from a small synthetic dataset, save the
> script in the workspace, run it, inspect any error, and explain the generated figure.

This exercises the streamed agent loop, workspace writes, schema-described website tools, Pyodide
execution, captured stdout/stderr, package handling, and Matplotlib artifact rendering.

For QuickJS, try:

> Create a JavaScript program that validates and summarizes a JSON dataset, save it, run it with
> QuickJS, and show me the real output.

## Supported environment and important limitations

- The reusable library targets browser-capable JavaScript environments.
- The complete demonstration currently targets desktop Chrome or Chromium.
- QuickJS and compatible Pyodide behavior can run on the static hosted site.
- WebContainers require cross-origin isolation headers that GitHub Pages cannot provide; test the
  Node.js mode with a suitable HTTPS host configured for COOP/COEP.
- WebContainers allow one live instance per page and may require a StackBlitz license for commercial
  production use.
- Pyodide installs pure-Python or compatible WASM/Emscripten wheels, not arbitrary native wheels.
- The ChatGPT/Codex connection is an unsupported interoperability experiment. The separately
  documented OpenAI Platform Responses adapter requires an application-owned secure transport or
  trusted-host credential source.

## Security boundary summary

- Refresh and ID credentials remain in the companion extension.
- An exact website origin must be approved in trusted extension UI.
- The approved workbench may receive a short-lived access token and account-routing identifier for
  direct model requests; it never receives the refresh or ID token.
- QuickJS, WebContainer, and Pyodide receive project snapshots and command arguments, not browser
  credentials, cookies, or arbitrary request headers.
- Workspace paths, patches, archives, tool inputs, and extension envelopes are validated as
  untrusted data.
- Read-only execution uses copied snapshots and discards filesystem changes.

## Submission artifact

The optional judge upload bundle contains this guide, the repository README, and the Build Week
thumbnail. The source repository remains the authoritative implementation.
