# Minimal coding agent

Phase 2 adds one deliberately small coding-agent loop without expanding Loom Core. The feature is
split between two plugins:

- `@loom/agent-codex` owns orchestration and its normalized model protocol;
- `@loom/tool-workspace` owns the list, read, and write tool contracts and adapts an injected text
  workspace.

Neither package performs model inference or accesses a host filesystem. Applications still choose
every implementation by explicit capability ID.

## Composition boundary

Agent construction belongs to the application. After the runtime is running, the application:

1. creates a session;
2. resolves the agent factory, model, and three workspace tools by their exported structural keys;
3. passes only the model, tools, optional memory, and the agent plugin's session configuration to
   the factory;
4. calls `run` with the session ID and Loom-owned cancellation signal;
5. consumes the streamed agent events before closing the session.

Core does not select a model, assemble tools, create conversations, or track an active agent run.
Closing a session cancels its signal, so model and tool adapters must observe the forwarded
operation context. A caller-held agent remains an ordinary JavaScript value; callers must not invoke
it after its session or runtime has been disposed.

## Workspace contract

Workspace paths are slash-separated, normalized, relative paths. Absolute paths, backslashes, empty
segments, `.` segments, and `..` segments are rejected. Omitting the path from a list request means
the workspace root.

`@loom/tool-workspace` operates on UTF-8 text through an injected `TextWorkspace`. It defines no
filesystem permissions, symlink behavior, persistence, or browser API. A later platform plugin can
implement the same adapter over File System Access API, OPFS, remote storage, or another backing
store without changing the agent.

The only supported operations are:

- `workspace/list-files`;
- `workspace/read-file`;
- `workspace/write-file`.

The operation discriminator is stable orchestration metadata. Display names and capability IDs are
not used to guess a tool's behavior.

## Model protocol

The Codex-style agent sends a provider-neutral request containing instructions, immutable message
history, and definitions for the three workspace tools. A model adapter streams complete normalized
events: text deltas, complete tool calls, and a completion marker. Provider-specific streaming
fragments must be assembled inside the model adapter before they reach the agent.

Tool calls are executed serially and their immutable JSON results are appended to the next model
request. Unknown tools, malformed events, duplicate call IDs, missing completion markers, and
duplicate/missing workspace tools fail with typed agent errors. A configurable turn limit prevents
an unbounded tool loop.

The protocol intentionally remains in `@loom/agent-codex`. It is not part of `@loom/plugin-api`, so
future planner, Claude-style, OpenHands-like, or custom agents can define different orchestration
protocols without changing core.

## Deliberate omissions

Phase 2 does not add authentication, a model provider, a browser filesystem adapter, command
execution, Git, search, persisted history, automatic agent selection, or automatic per-session agent
construction. The in-memory workspace and scripted model in `@loom/examples` are deterministic
fixtures, not production providers.
