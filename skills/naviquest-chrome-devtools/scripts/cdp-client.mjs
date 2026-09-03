/**
 * The raw Chrome DevTools Protocol client: native WebSocket for the session,
 * `fetch` against `/json*` for target discovery. No Playwright, no puppeteer.
 *
 * Extracted from `cdp-runner.mjs` so there is ONE derivation of the protocol
 * plumbing. The runner is CLI-shaped — it picks a target, runs one script and
 * exits — but a long-lived caller (a server holding one tab per session across
 * many requests) needs the same session object without that lifecycle. Before
 * this file existed the only way to get one was to write a second client, and a
 * second client is a second set of bugs: the request/response correlation, the
 * per-call timeout, the event fan-out and the drain-on-close are all easy to
 * get subtly wrong and hard to notice.
 *
 * Node 22+ only: `globalThis.WebSocket` is native there, so this has no deps.
 * The version is checked lazily rather than at import, so importing this module
 * has no side effect and the caller's own CLI can report the failure.
 */

export function requireWebSocket() {
  const WS = globalThis.WebSocket;
  if (!WS) throw new Error(`Node.js 22+ required (you have ${process.versions.node}). Native WebSocket is unavailable.`);
  return WS;
}

/** The browser's HTTP endpoint. Short timeout: these are localhost calls, so a
 *  slow one means the browser is gone, not busy. */
export async function cdpHttp(port, path, method = 'GET') {
  const res = await fetch(`http://localhost:${port}${path}`, { method, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} for ${path}`);
  return res.json();
}

export const getVersion = (port) => cdpHttp(port, '/json/version');
export const getTargets = (port) => cdpHttp(port, '/json');
export const openTab = (port, url) => cdpHttp(port, `/json/new?${encodeURIComponent(url)}`, 'PUT');
export const activateTarget = (port, id) => cdpHttp(port, `/json/activate/${id}`);
export async function closeTab(port, id) {
  try {
    const res = await fetch(`http://localhost:${port}/json/close/${id}`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

/**
 * One CDP session over one WebSocket. Resolves once the socket is open, so a
 * caller never has to guess when `send` becomes usable.
 *
 * `send` rejects on the protocol error rather than hanging, and every in-flight
 * call is drained on close or socket error — otherwise a dropped browser leaves
 * the caller awaiting a promise that can never settle.
 */
export function createSession(wsUrl, targetInfo, { timeout = 60000, onHandlerError } = {}) {
  const WS = requireWebSocket();
  return new Promise((resolveSession, rejectSession) => {
    const ws = new WS(wsUrl);
    let msgId = 1;
    const pending = new Map();
    const handlers = new Map();
    let closed = false;

    function drainPending(reason) {
      if (pending.size === 0) return;
      const err = new Error(reason);
      pending.forEach(({ rej, timer }) => { clearTimeout(timer); rej(err); });
      pending.clear();
    }

    ws.onopen = () => {
      resolveSession({
        targetInfo,

        send(method, params = {}, sessionId = undefined) {
          if (closed) return Promise.reject(new Error('Session already closed'));
          return new Promise((res, rej) => {
            const id = msgId++;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`CDP timeout (${timeout}ms) for: ${method}`));
            }, timeout);
            pending.set(id, { res, rej, timer });
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            ws.send(JSON.stringify(payload));
          });
        },

        on(event, handler) {
          if (!handlers.has(event)) handlers.set(event, new Set());
          handlers.get(event).add(handler);
        },

        off(event, handler) {
          handlers.get(event)?.delete(handler);
        },

        log(...args) {
          console.log('[BROWSER]', ...args);
        },

        outputDir: '',

        close() {
          if (closed) return;
          closed = true;
          drainPending('Session closed');
          handlers.clear();
          try { ws.close(); } catch { /* already gone */ }
        },
      });
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(typeof evt === 'string' ? evt : evt.data); } catch { return; }

      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) rej(new Error(`CDP error [${msg.error.code}]: ${msg.error.message}`));
        else res(msg.result ?? {});
      } else if (msg.method) {
        const meta = msg.sessionId ? { sessionId: msg.sessionId } : {};
        // One throwing handler must not take down the message pump, or a single
        // bad listener silently stops every later event on the session.
        handlers.get(msg.method)?.forEach((h) => {
          try { h(msg.params ?? {}, meta); } catch (e) { onHandlerError?.(e); }
        });
        handlers.get('*')?.forEach((h) => {
          try { h(msg.method, msg.params ?? {}, meta); } catch { /* wildcard listener */ }
        });
      }
    };

    ws.onerror = (e) => {
      const msg = e?.message ?? String(e);
      drainPending(`WebSocket error: ${msg}`);
      if (!closed) rejectSession(new Error(`WebSocket error: ${msg}`));
    };

    ws.onclose = () => {
      drainPending('WebSocket closed unexpectedly');
    };
  });
}
