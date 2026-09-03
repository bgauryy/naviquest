#!/usr/bin/env node

/**
 * Serve this fixtures folder over http on an ephemeral 127.0.0.1 port and print
 * the origin as the first stdout line.
 *
 * Two reasons this is a separate process rather than a server inside the
 * grader: the grader drives Chrome with blocking `spawnSync` calls, which would
 * starve its own event loop and make every fixture request hang (Chrome would
 * then show an error page and the assertions would blame the SDK); and the
 * WebMCP CDP domain cannot be enabled on a `file://` document at all, because
 * enabling it grants a permission to the frame's origin and a file origin is
 * opaque — so the fixture has to be real http.
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { dirname, extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

const server = createServer((req, res) => {
  const requested = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  const file = join(HERE, requested === '/' ? 'plain-page.html' : requested);
  // Serve only out of this folder; a fixture server that can be walked upward
  // with `..` is a local file-read primitive.
  if (!file.startsWith(HERE)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}/`);
});
