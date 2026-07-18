import type {
  BrowserExecutionContext,
  BrowserExecutionResult,
  BrowserExecutionRuntime,
  BrowserExecutionWorkspace,
  BrowserWorkspaceInvocation,
} from './contracts.js';
import { BrowserExecutionError } from './errors.js';

export async function executeBrowserWorkspace(
  runtime: BrowserExecutionRuntime,
  workspace: BrowserExecutionWorkspace,
  invocation: BrowserWorkspaceInvocation,
  context: BrowserExecutionContext = {},
): Promise<BrowserExecutionResult> {
  context.signal?.throwIfCancelled();
  let project;
  try {
    project = await workspace.load(context);
  } catch (error) {
    throw new BrowserExecutionError(
      'WORKSPACE_SYNC_FAILED',
      'Unable to snapshot the browser execution workspace.',
      { cause: error },
    );
  }
  context.signal?.throwIfCancelled();
  const result = await runtime.execute(
    {
      command: invocation.command,
      ...(invocation.arguments === undefined ? {} : { arguments: invocation.arguments }),
      ...(invocation.workingDirectory === undefined
        ? {}
        : { workingDirectory: invocation.workingDirectory }),
      ...(invocation.timeoutMs === undefined ? {} : { timeoutMs: invocation.timeoutMs }),
      project,
    },
    context,
  );
  context.signal?.throwIfCancelled();
  try {
    await workspace.commit(result.project, context);
  } catch (error) {
    throw new BrowserExecutionError(
      'WORKSPACE_SYNC_FAILED',
      'Execution finished, but its workspace changes could not be committed.',
      { cause: error },
    );
  }
  context.signal?.throwIfCancelled();
  return result;
}
