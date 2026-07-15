# Credential broker example

Build the required packages from the repository root:

```sh
pnpm build
```

In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select
`packages/extension/dist`. Copy the generated extension ID. Then serve the package directory:

```sh
python3 -m http.server 4173 --directory packages
```

Open `http://localhost:4173/example-extension/`, enter the extension ID, and request a token. The
page constructs `@loom/auth-extension` with the page's external-message runtime, registers its
`AuthProvider` in a Loom runtime, requests the provider ID `loom/mock`, and disposes the runtime.

The development extension contains only a mock provider and mock refresh credential. It does not
implement login, OAuth, Codex authentication, or any production provider flow. Do not reuse its
localhost manifest or built-in mock credential for deployment.
