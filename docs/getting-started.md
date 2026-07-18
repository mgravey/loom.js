# Getting started with Loom.js

This guide takes a new contributor from a clean checkout to a deterministic coding session, then
introduces Loom Core, plugin lifecycle, typed custom-tool registration, secure model transports,
browser execution, and the example workbench.

For a rendered version, serve the `packages` directory and open
`http://localhost:4173/example-codex-experimental/docs.html`.

## 1. Set up the repository

Loom packages are private workspace packages at version `0.1.0`; they are not published to npm. Work
from this repository until package publication, licensing, and namespace ownership are ready.

Requirements:

- Node.js 20.19 or newer; Node.js 22 matches CI;
- pnpm 11.7.0 through Corepack; and
- Chromium for browser and extension integration tests.

```sh
git clone <repository-url> loom.js
cd loom.js

corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

`pnpm check` is the complete acceptance gate. It does not require live credentials or provider
access; automated OAuth and model tests use deterministic fixtures.

## 2. Understand the composition

Loom Core validates a fixed plugin graph, owns lifecycle, and exposes capability and service
registries. Behavior enters through replaceable packages:

| Boundary      | Responsibility                                                    | Starting package               |
| ------------- | ----------------------------------------------------------------- | ------------------------------ |
| Orchestration | Prompts, transcript, follow-ups, events, cancellation             | `@loom/coding`                 |
| Model         | Agent-protocol translation and credential-free provider transport | `@loom/model-openai-responses` |
| Tools         | Validated operations with narrow authority                        | `@loom/tool-workspace`         |
| Workspace     | Memory, OPFS, File System Access, or a custom host                | `@loom/workspace-fsa`          |
| Execution     | Credential-free project snapshots executed by an injected runtime | `@loom/execution-browser`      |

Use `createCodingSession()` directly for a small embedding. Use `@loom/core` when the application
needs typed capability discovery, dependency ordering, configuration, events, and full plugin
lifecycle.

## 3. Create an in-memory project

An in-memory project is deterministic and permission-free. Parent directories must exist before
nested initial files.

```ts
import {
  createMemoryProjectWorkspace,
  createProjectWorkspaceTools,
  createWorkspaceTools,
  workspacePath,
  type WorkspaceTool,
} from '@loom/tool-workspace';

const workspace = createMemoryProjectWorkspace({
  entries: [
    { path: workspacePath('src'), kind: 'directory' },
    {
      path: workspacePath('src/main.js'),
      kind: 'file',
      content: 'console.log("Hello from Loom");\n',
    },
  ],
});

const projectTools = createProjectWorkspaceTools(workspace);
const modelTools: readonly WorkspaceTool[] = Object.freeze([
  ...createWorkspaceTools(workspace),
  projectTools.stat,
  projectTools.createDirectory,
  projectTools.move,
  projectTools.remove,
  projectTools.applyPatch,
]);
```

Binary operations remain available to trusted host code:

```ts
const image = await workspace.readBytes(workspacePath('assets/icon.png'));
await workspace.writeBytes(workspacePath('assets/icon-copy.png'), image);
```

They are not included in the current model tool list because the agent protocol is JSON-oriented.

After the memory composition works, replace only the workspace adapter:

- use OPFS for a persistent browser-owned project;
- use File System Access for an explicitly selected host directory; or
- implement `ProjectWorkspace` for a database, remote repository, or trusted host.

## 4. Create a deterministic coding session

Prove orchestration without networking before connecting a real model.

```ts
import type { CodexModel } from '@loom/agent-codex';
import { createCodingSession } from '@loom/coding';

const model: CodexModel = {
  async *generate() {
    yield { type: 'text', text: 'The project is ready.' };
    yield { type: 'completed' };
  },
};

const session = createCodingSession({
  model,
  tools: modelTools,
  configuration: {
    maxTurns: 8,
    instructions: 'Inspect the project and make only requested changes.',
  },
});

try {
  for await (const event of session.submit('Describe this project.')) {
    if (event.type === 'text') process.stdout.write(event.text);
  }

  for await (const event of session.followUp('Now create a README.')) {
    console.log(event);
  }
} finally {
  await session.dispose();
}
```

Session behavior:

- one operation may run at a time;
- `submit()` and `followUp()` stream agent events;
- `subscribe()` observes state, transcript, agent, and error events;
- `cancel()` targets the active operation; and
- `dispose()` is terminal and belongs in `finally`.

## 5. Compose plugins through Core

Use Core once the application has multiple independently owned capabilities:

```ts
import { createCodexAgentPlugin } from '@loom/agent-codex';
import { createLoomRuntime } from '@loom/core';
import { createProjectWorkspaceToolsPlugin } from '@loom/tool-workspace';

const runtime = createLoomRuntime({
  plugins: [createProjectWorkspaceToolsPlugin(workspace), createCodexAgentPlugin()],
});

await runtime.initialize();
await runtime.start();

try {
  // Resolve capabilities and create application sessions here.
} finally {
  await runtime.stop();
  await runtime.dispose();
}
```

The lifecycle is deliberate:

1. `initialize` registers capabilities and services.
2. `start` resolves optional integrations and begins work.
3. `stop` ends work started by a plugin.
4. `dispose` releases resources in reverse dependency order.

Plugin membership is fixed when the runtime is created. Version `0.1` has no hot installation,
removal, restart, or dependency version negotiation.

## 6. Register a custom tool capability

Generic tools use structural `(kind, namespaced ID)` identity. Export one canonical typed key from
the owning package so consumers do not reconstruct an incompatible type.

```ts
import {
  PLUGIN_API_VERSION,
  definePlugin,
  registerTool,
  toolKey,
  type Tool,
} from '@loom/plugin-api';
import { pluginId, semanticVersion } from '@loom/types';

interface EchoInput {
  readonly text: string;
}

interface EchoOutput {
  readonly text: string;
}

export const ECHO_TOOL_KEY = toolKey<EchoInput, EchoOutput>('example/echo');

const echoTool: Tool<EchoInput, EchoOutput> = Object.freeze({
  name: 'echo',
  description: 'Return the supplied text.',
  async execute(input, context) {
    context?.signal?.throwIfCancelled();
    if (typeof input !== 'object' || input === null || typeof input.text !== 'string') {
      throw new TypeError('echo requires string text.');
    }
    return Object.freeze({ text: input.text });
  },
});

export const echoPlugin = definePlugin({
  manifest: {
    id: pluginId('example/echo-plugin'),
    version: semanticVersion('0.1.0'),
    apiVersion: PLUGIN_API_VERSION,
  },
  initialize(context) {
    registerTool(context.capabilities, 'example/echo', echoTool);
  },
});
```

Resolve it from a running composition:

```ts
const runtime = createLoomRuntime({ plugins: [echoPlugin] });
await runtime.initialize();
await runtime.start();

try {
  const echo = runtime.capabilities.get(ECHO_TOOL_KEY);
  console.log(await echo.execute({ text: 'Hello' }));
} finally {
  await runtime.stop();
  await runtime.dispose();
}
```

Registration is allowed only during the owning plugin's `initialize` hook. Tool implementations must
validate exact input shapes, honor cancellation, return JSON-safe values, and expose the smallest
possible authority.

### Current model-tool limitation

Generic Core registration does not automatically expose a tool to the coding model. The current
`@loom/coding` session uses `@loom/agent-codex`, which accepts an audited, fixed set of workspace
operations and schemas. A future schema-bearing model-tool contract must generalize this safely,
including unique operation IDs and per-tool direct/programmatic authorization.

## 7. Connect a secure model transport

Replace the deterministic model with a provider adapter. Browser pages should inject a
credential-free transport to a trusted backend:

```ts
import { createOpenAIResponsesModel } from '@loom/model-openai-responses';

const model = createOpenAIResponsesModel({
  model: 'your-supported-model',
  transport: {
    async send(request) {
      // The trusted backend owns the API key and POST /v1/responses.
      return secureResponsesBackend.send(request);
    },
  },
});
```

Never ship a Platform API key in browser JavaScript. The documented Platform Responses adapter and
the experimental ChatGPT extension transport are separate integrations. The extension is one
possible trusted boundary for the workbench; Loom.js itself does not require it.

Device-code login can run without a local Node companion, but it does not bypass ChatGPT inference
CORS. A complete browser-backed ChatGPT composition still needs the extension or a trusted server
for model requests.

## 8. Execute a browser project

Browser execution requests contain only a command, arguments, timeout, cancellation, output sink,
and copied project files:

```ts
import { createQuickJsExecutionRuntime } from '@loom/execution-browser';

const quickjs = createQuickJsExecutionRuntime({
  loadModule: () => import('quickjs-emscripten'),
});

try {
  const result = await quickjs.execute(
    {
      command: 'qjs',
      arguments: ['main.js'],
      timeoutMs: 10_000,
      project: {
        files: [
          {
            path: 'main.js',
            data: new TextEncoder().encode('console.log("Hello from QuickJS");\n'),
          },
        ],
      },
    },
    {
      onOutput(output) {
        const method = output.channel === 'stderr' ? 'error' : 'log';
        console[method](output.chunk);
      },
    },
  );
  console.log('Exit code:', result.exitCode);
} finally {
  await quickjs.dispose();
}
```

The package also supplies WebContainer and Pyodide adapters. WebContainer requires COOP/COEP
headers. Prefer dedicated Workers for generated QuickJS or Pyodide code when hard UI responsiveness
matters.

Two bridges remain application-local today:

- conversion between `ProjectWorkspace` and `BrowserExecutionWorkspace`; and
- conversion from promise-based `BrowserExecutionRuntime` to the event-stream runtime accepted by
  `CodingSession.runtimes`.

The browser workbench implements both integration responsibilities locally without passing
credentials into a runtime.

## 9. Run the welcome site and workbench

```sh
pnpm build
python3 -m http.server 4173 --directory packages
```

Open `http://localhost:4173/example-codex-experimental/` for the welcome page and rendered guide.

To run the ChatGPT-backed example:

1. Open `chrome://extensions` and enable Developer mode.
2. Load `packages/extension-codex-experimental/dist` as an unpacked extension.
3. Open its options, explicitly enable the experiment, and authenticate.
4. Copy the extension ID.
5. Open `http://localhost:4173/example-codex-experimental/workbench.html`.
6. Enter the extension ID and select direct directory, memory, or OPFS mode.
7. Import/open the project, run a request, inspect changes, and export a ZIP if needed.

The Python server does not provide the COOP/COEP headers required by WebContainer. Use a suitable
development or production server before selecting the Node.js runtime.

## 10. Security checklist

- Never place API keys, refresh tokens, cookies, or account credentials in browser code, files,
  runtime environments, events, or logs.
- Treat model responses, extension messages, imported folders, and ZIPs as untrusted input.
- Use Loom's bounded ZIP validators instead of extracting uploads directly.
- Require confirmation before committing runtime changes to a selected directory.
- Keep hosted model programs read-only; mutations remain direct validated tool calls.
- Prefer Worker isolation for generated code and document cooperative-cancellation limits.
- Keep experimental ChatGPT compatibility visually and architecturally separate from the
  provider-neutral library and documented Platform API adapter.
- Run `pnpm check` before integration and release changes.

## Current limitations

- Packages are private and unpublished.
- The coding agent does not yet accept arbitrary schema-bearing model tools.
- Browser execution and coding-session runtimes need a public bridge.
- Project-to-runtime synchronization is local to the example.
- The ChatGPT/Codex extension path is unsupported compatibility work.
- Production extension packaging, licensing, release versioning, and multi-browser CI are pending.

Continue with [Architecture](./architecture.md), [Plugin authoring](./plugin-authoring.md), and the
[browser workbench guide](./browser-coding-workbench.md).
