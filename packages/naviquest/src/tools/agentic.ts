/**
 * Site-level agent content — `llms.txt`, and what to do when it is not there.
 *
 * The other five tools answer about THIS DOCUMENT. That is the right scope for
 * orientation and grounding, and the wrong scope for the question an agent asks
 * first: *what is this site, and which page should I even be on?* Today an agent
 * answers that by crawling, which costs a page load per guess.
 *
 * `llms.txt` (llmstxt.org) is the community answer: one markdown file at the
 * origin root listing the pages that matter, each with a one-line description.
 * It is a good idea with a bad ergonomic — it is prose, so an agent still has to
 * fetch it, guess whether it exists, parse markdown, resolve relative links, and
 * decide what to do when it is absent. That is four failure modes in front of a
 * capability, and absence is the common case.
 *
 * This module makes it one call that always answers something useful:
 *
 *   - it finds the best available source and NAMES which one answered;
 *   - it resolves every link to an absolute, same-origin resource URL without
 *     pretending an agent-readable resource is the site's live HTML page;
 *   - when no manifest exists it degrades to the page's own outbound links
 *     rather than returning nothing, because "this site publishes no manifest"
 *     is not the same answer as "there is nowhere to go".
 *
 * SAME-ORIGIN ONLY, in every path. A tool that fetches a URL an agent supplies
 * is a request forgery primitive pointed at whatever the user's cookies can
 * reach. Every candidate is resolved against `location.origin` and dropped if it
 * lands anywhere else, and `read` additionally refuses any URL that is not
 * already in the manifest this origin published.
 */

/** What the agent asked for. One tool, three questions. */
export type AgenticIntent = 'list' | 'read' | 'find';

/** Where the answer came from. Never inferred by the caller. */
export type AgenticSource = 'llms.txt' | 'llms-full.txt' | 'page-links' | 'none';

export interface AgenticDoc {
  title: string;
  url: string;
  /** The `##` section the entry sat under — llms.txt's own grouping. */
  section: string | null;
  /** The text after `: ` on the link line. The author's own summary. */
  note: string | null;
}

export interface AgenticManifest {
  source: AgenticSource;
  origin: string;
  /** The `#` heading of the manifest. */
  title: string | null;
  /** The `>` blockquote under it — the site's own one-line self-description. */
  summary: string | null;
  docs: AgenticDoc[];
  /**
   * Entries the same-origin guard removed, and the hosts they pointed at.
   *
   * Found by a historical run on the WebMCP spec site, whose llms.txt is 117
   * entries of which 116 point at github.com: the guard did its job and the tool
   * reported ONE document, silently, as though that were the whole manifest. A
   * silently trimmed response reads to a model as "that is everything", which is
   * the single failure mode this SDK is built not to have. Dropping them is
   * still right — it must never hand an agent an off-origin URL — but it has to
   * say so.
   */
  crossOrigin: { dropped: number; hosts: string[] };
  /** Paths tried and what happened, so a host can debug a manifest that is not
   *  being picked up without reading this source. */
  tried: Array<{ path: string; status: string }>;
}

export interface AgenticTuning {
  /** Turn the whole tool off. */
  enabled: boolean;
  /** Tried in order; the first that parses to at least one link wins. */
  paths: string[];
  /** Cap on a fetched body. A `llms-full.txt` can be a whole book, and an
   *  unbounded read is a memory footgun on a phone. */
  maxBytes: number;
  /** Abort a manifest or document fetch after this long. A hung request must
   *  not hang the agent's turn. */
  timeoutMs: number;
  /** Characters of a document returned by `read` before declared truncation. */
  maxReadChars: number;
}

/**
 * Parse llms.txt.
 *
 * The format is deliberately loose — it is markdown a human maintains — so this
 * is tolerant by design and reports what it got rather than throwing. The shape
 * it recognises, per llmstxt.org:
 *
 *   # Title
 *   > one-line summary
 *   (free prose, ignored)
 *   ## Section
 *   - [Title](/path): note
 *
 * Anything else is skipped rather than treated as an error. A manifest with a
 * malformed line should lose that line, not the manifest.
 */
function parseLlmsTxt(text: string, base: string): Omit<AgenticManifest, 'source' | 'tried'> {
  const origin = safeOrigin(base);
  let title: string | null = null;
  let summary: string | null = null;
  let section: string | null = null;
  const docs: AgenticDoc[] = [];
  const offOrigin = new Set<string>();
  let dropped = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (!title && line.startsWith('# ')) { title = line.slice(2).trim(); continue; }
    if (line.startsWith('>')) {
      const part = line.replace(/^>+\s*/, '').trim();
      // Wrapped blockquotes are one summary, not the first line of one.
      if (part) summary = summary ? `${summary} ${part}` : part;
      continue;
    }
    if (line.startsWith('## ')) { section = line.slice(3).trim() || null; continue; }

    // `- [Title](url)` with an optional `: note`. The link may also appear as a
    // bare list item on some sites, which is not the spec and is not accepted:
    // a link with no title is not something an agent can choose between.
    const m = /^[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/.exec(line);
    if (!m) continue;
    const url = sameOriginUrl(m[2], base, origin);
    // Cross-origin entries are dropped — an agent that sees a URL in a list will
    // fetch it, and the one guarantee this module makes is that it never points
    // anywhere but this origin. But the DROP IS COUNTED and reported, because a
    // manifest that is 99% off-origin must not look like an empty one.
    if (!url) {
      dropped++;
      try { offOrigin.add(new URL(m[2], base).host); } catch { /* unparseable */ }
      continue;
    }
    docs.push({
      title: m[1].trim(),
      url,
      section,
      note: (m[3] ?? '').trim() || null,
    });
  }
  return { origin, title, summary, docs,
           // Host names are already deduplicated and materially smaller than
           // the omitted document rows. Capping this diagnostic made two sites
           // with the same `dropped` count look equivalent while hiding where
           // the agent must continue with its browser tool.
           crossOrigin: { dropped, hosts: [...offOrigin] } };
}

/** `null` unless the URL resolves inside this origin. */
export function sameOriginUrl(href: string, base: string, origin: string): string | null {
  try {
    const u = new URL(href, base);
    return u.origin === origin ? u.href : null;
  } catch { return null; }
}

function safeOrigin(base: string): string {
  try { return new URL(base).origin; } catch { return ''; }
}

/** One fetch, bounded in both time and size, that never throws. */
async function getText(url: string, cfg: AgenticTuning): Promise<
  { ok: true; text: string } | { ok: false; status: string; tooLarge?: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const want = safeOrigin(url);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
    if (!res.ok) return { ok: false, status: `HTTP ${res.status}` };

    // WHERE THE BYTES CAME FROM, not where we asked. `redirect: 'follow'` means a
    // same-origin /llms.txt that 302s away hands back someone else's document —
    // and the parser then resolves ITS relative links against OUR origin and
    // blesses them as same-origin URLs of this site. Credentials are omitted so
    // this is not a data leak, but it launders provenance, which defeats the one
    // guarantee this module advertises in its header.
    const got = safeOrigin(res.url);
    if (got && want && got !== want) return { ok: false, status: `redirected off-origin to ${got}` };

    // Content type is NOT used to decide whether this is a manifest.
    //
    // It was, and real sites broke it: docs.anthropic.com serves a valid 688-entry
    // llms.txt as `text/html`, which the guard rejected outright. A missing
    // llms.txt does often return an SPA shell with 200 rather than 404 — but the
    // parse result already catches that, because a shell yields zero `- [x](y)`
    // lines. One signal, and it is the one that cannot be wrong about content.
    const capped = await readCapped(res, cfg.maxBytes);
    // A byte cap is not a page boundary. The server supplied neither a stable
    // revision nor a range contract with which the next call could recover the
    // omitted suffix, so exposing this prefix would make a permanently partial
    // source look pageable. Refuse it instead; manifests can fall through to
    // another source/page links, and document reads tell the agent to navigate.
    if (capped.sourceTruncated) {
      return { ok: false, status: `exceeds ${cfg.maxBytes}-byte source cap`, tooLarge: true };
    }
    return { ok: true, text: capped.text };
  } catch (e) {
    return { ok: false, status: (e as Error)?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally { clearTimeout(timer); }
}

/**
 * Read at most `maxBytes`, then stop pulling and release the connection.
 *
 * `(await res.text()).slice(0, maxBytes)` bounded what we KEPT, not what we
 * downloaded: the entire body was already resident before the slice ran, which
 * is precisely the footgun the `maxBytes` doc comment claims to prevent. An
 * `llms-full.txt` is entitled to be a book. A phone is not entitled to hold one.
 */
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; sourceTruncated: boolean }> {
  const reader = res.body?.getReader?.();
  // No streaming here (older runtime, or a mocked Response). One buffered read is
  // then the only option and is still capped on the way out.
  if (!reader) {
    const text = await res.text();
    const bytes = new TextEncoder().encode(text);
    return { text: new TextDecoder().decode(bytes.slice(0, maxBytes)),
      sourceTruncated: bytes.length > maxBytes };
  }
  const decoder = new TextDecoder();
  let out = '';
  let seen = 0;
  let sourceTruncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { out += decoder.decode(); break; }
      const remaining = maxBytes - seen;
      if (value.byteLength > remaining) {
        out += decoder.decode(value.slice(0, remaining));
        sourceTruncated = true;
        break;
      }
      seen += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (seen === maxBytes) {
        // Read one byte/chunk beyond the ceiling only to distinguish "exactly
        // full" from "cut". The extra chunk is never decoded or retained.
        sourceTruncated = !(await reader.read()).done;
        out += decoder.decode();
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: out, sourceTruncated };
}

/**
 * Find and parse the site's manifest.
 *
 * Resolved once per origin per SDK instance and cached, including the negative
 * result: a site without an `llms.txt` must not be re-probed on every call, or
 * an agent in a loop generates one round trip per reasoning step for a file that
 * will still not be there.
 */
export async function loadManifest(cfg: AgenticTuning, base: string): Promise<AgenticManifest> {
  const origin = safeOrigin(base);
  const tried: AgenticManifest['tried'] = [];

  for (const path of cfg.paths) {
    const url = sameOriginUrl(path, base, origin);
    if (!url) { tried.push({ path, status: 'not same-origin' }); continue; }

    const got = await getText(url, cfg);
    if (!got.ok) { tried.push({ path, status: got.status }); continue; }

    const parsed = parseLlmsTxt(got.text, url);
    if (!parsed.docs.length) { tried.push({ path, status: 'no usable links' }); continue; }

    return {
      ...parsed,
      source: path.includes('full') ? 'llms-full.txt' : 'llms.txt',
      tried,
    };
  }
  return { source: 'none', origin, title: null, summary: null, docs: [],
           crossOrigin: { dropped: 0, hosts: [] }, tried };
}

/**
 * Fetch one document the manifest already vouched for.
 *
 * An HTML entry is DECLINED rather than returned. Handing back a page's markup
 * is precisely the cost this SDK exists to remove — and once the agent
 * navigates there, `find_on_page` answers the same question for a fraction of
 * the tokens, against a live DOM rather than a detached string. So the honest
 * answer to "read this HTML page" is "go there and ask it", and this says so
 * with the URL rather than failing.
 */
export async function readDoc(url: string, cfg: AgenticTuning): Promise<
  { text: string } | { navigate: true } | { tooLarge: true } | { error: string }> {
  const got = await getText(url, cfg);
  if (!got.ok) return got.tooLarge ? { tooLarge: true } : { error: got.status };
  // Judged by the BODY, not the declared type, for the same reason manifest
  // detection is: real servers mislabel text as html and html as text. A
  // document that opens with a doctype or an <html>/<head> tag is a page, and a
  // page is something to navigate to rather than to paste into a context window.
  if (/^\s*(<!doctype\s+html|<html[\s>]|<head[\s>])/i.test(got.text)) return { navigate: true };
  // Page-sized slicing belongs to the tool so a revision-bound continuation can
  // recover every omitted character from this complete, bounded fetch.
  return { text: got.text };
}

/**
 * Rank manifest entries against a query.
 *
 * Deliberately NOT the BM25 index: that index is built over this page's chunks,
 * and a manifest is a few dozen short titles from other pages. Term-overlap
 * scoring over title + note + section is the right size of instrument, it needs
 * no index build, and it cannot drift from the retrieval lane because it does
 * not share one. Scores are reported as coverage — the share of the query's
 * terms present — which is the same currency `locate_control` reports, so an
 * agent reads one confidence scale across the whole surface.
 */
export function rankDocs(docs: AgenticDoc[], query: string,
                         tokenize: (text: string) => string[]): Array<AgenticDoc & { coverage: number }> {
  // Reuse the page's frozen Unicode tokenizer. The former regex lane discarded
  // every one-code-point CJK term (`猫`) and disagreed with find_on_page about
  // which words existed at all.
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  return docs
    .map((d) => {
      const hay = new Set(tokenize(`${d.title} ${d.note ?? ''} ${d.section ?? ''}`));
      const hit = terms.filter((t) => hay.has(t)).length;
      return { ...d, coverage: hit / terms.length };
    })
    .filter((d) => d.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage);
}
