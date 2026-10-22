import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRoot = resolve(projectRoot, 'packages/example-codex-experimental');
const prefix = '/example-codex-experimental/';
const workbench = `${prefix}workbench.html`;
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.ico', 'image/x-icon'],
  ['.wasm', 'application/wasm'],
]);

/** Static files only. This server neither exchanges codes nor receives OAuth tokens. */
export async function createChatGPTBrowserServer({ root = defaultRoot, port = 4174 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Use a valid LOOM_BROWSER_PORT (1–65535).');
  }
  const assetRoot = await realpath(root);
  let origin;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    const fail = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(message);
    };
    if (request.headers.host !== new URL(origin).host) {
      fail(403, 'Open this server using its printed 127.0.0.1 URL.');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      fail(405, 'This server only serves static files.');
      return;
    }
    // Discard callback query strings immediately. Do not log URLs, headers, or request bodies.
    let pathname;
    try {
      pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    } catch {
      fail(400, 'Invalid path.');
      return;
    }
    if (pathname === '/') {
      response.writeHead(302, { Location: workbench });
      response.end();
      return;
    }
    const relative =
      pathname === '/auth/callback'
        ? 'chatgpt-callback.html'
        : pathname.startsWith(prefix)
          ? pathname.slice(prefix.length)
          : '';
    const segments = relative.split('/');
    if (
      relative === '' ||
      relative.includes('\\') ||
      segments.some((segment) => segment.startsWith('.') || segment === '') ||
      (segments.length > 1 && !['dist', 'assets'].includes(segments[0])) ||
      !types.has(extname(relative))
    ) {
      fail(404, 'Not found.');
      return;
    }
    void (async () => {
      const file = await realpath(resolve(assetRoot, relative));
      if (!file.startsWith(assetRoot + sep) || !(await stat(file)).isFile()) {
        fail(404, 'Not found.');
        return;
      }
      response.writeHead(200, { 'Content-Type': types.get(extname(relative)) });
      if (request.method === 'HEAD') response.end();
      else await pipeline(createReadStream(file), response);
    })().catch(() => {
      if (!response.headersSent) fail(404, 'Not found. Build the workbench first.');
      else response.destroy();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      accept();
    });
  });
  return { server, origin, url: origin + workbench };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { server, url } = await createChatGPTBrowserServer({
      port: Number(process.env.LOOM_BROWSER_PORT ?? 4174),
    });
    console.log(`Loom browser-only login test: ${url}`);
    console.log('Static files only. Authentication and model requests run in your browser.');
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        server.close();
        server.closeAllConnections();
      });
    }
  } catch (error) {
    console.error(
      error?.code === 'EADDRINUSE'
        ? 'Port is in use. Choose another with LOOM_BROWSER_PORT=4175 pnpm dev:chatgpt.'
        : 'Could not start the static server. Check the build and LOOM_BROWSER_PORT.',
    );
    process.exitCode = 1;
  }
}
