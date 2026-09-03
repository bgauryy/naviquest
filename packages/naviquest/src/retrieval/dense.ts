/**
 * The dense lane: static embeddings, int8, no model inference at query time.
 *
 * This is `model2vec` inference and nothing more — BERT WordPiece with no
 * special tokens, an int8 row lookup per token, mean-pool, L2 normalise. There
 * is no transformer here and no matrix multiply beyond a dot product, which is
 * why it can run in a worker on a phone at 0.023-0.039 ms per document.
 *
 * Three facts from docs/VALIDATION.md § 8 shape every decision below, and each
 * one was measured before this file existed:
 *
 *   1. `potion-base-8M` BEATS `potion-retrieval-32M` on this task at a quarter of
 *      the bytes (fused hit@1 71% vs 57%). The retrieval-tuned model is worse.
 *   2. int8 quantisation is FREE: cosine against f32 is mean 0.999969 over 544
 *      real chunks, worst 0.999924. There is no reason to ship f32.
 *   3. Dense must NEVER replace lexical. Alone it scores BELOW BM25 at rank 1
 *      (57-62% vs 67%) because a static embedding has no compositionality: "the
 *      input where I type a new todo" puts `Toggle Todo` at 0.574 and
 *      `What needs to be done?` at 0.083. It earns its place only in fusion.
 *
 * Pure: no DOM, no fetch, no globals. The worker calls it; Node can import it
 * directly to verify the pipeline offline.
 */
import type { DenseCorpus, DenseTable, Hit } from '../types.ts';

// ---- tokenisation ----------------------------------------------------------

/**
 * BERT basic tokenisation: lowercase, strip accents, split on whitespace, and
 * split punctuation off as its own token. CJK is split per character, which is
 * what the BERT vocabulary expects.
 */
function basicTokenize(text: string): string[] {
  const s = String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const out: string[] = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (/\s/.test(ch)) { flush(); continue; }
    // Punctuation is its own token — but BERT's definition of punctuation is
    // NOT `\p{P}\p{S}`. It is: any ASCII character in the four non-alphanumeric
    // ranges, PLUS anything in Unicode category P. Currency and maths symbols
    // outside ASCII are ordinary word characters to it, so `£1` is ONE word
    // while `+44` splits — because `+` is ASCII 43 and `£` is not ASCII at all.
    // Treating `\p{S}` as punctuation split `£1` into `£` + `1` and produced a
    // different id sequence with no error. Caught by tokenizer-parity.mjs.
    if (isPunct(c, ch)) { flush(); out.push(ch); continue; }
    // CJK IDEOGRAPHS are single-character tokens. Kana and Hangul are NOT, and
    // getting that wrong is silent: BERT's `_is_chinese_char` covers the
    // ideograph blocks only, so hiragana runs through WordPiece with `##`
    // continuations like any other word. Splitting kana per character produced
    // `["は","て","あ","る"]` where the reference produces `["は","て","##あ",
    // "##る"]` — different ids, different vectors, no error anywhere.
    // Caught by tokenizer-parity.mjs against Python `tokenizers`.
    if (isIdeograph(c)) { flush(); out.push(ch); continue; }
    buf += ch;
  }
  flush();
  return out;
}

/** BERT's `_is_punctuation`, verbatim. */
const P = /\p{P}/u;
function isPunct(c: number, ch: string): boolean {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64)
    || (c >= 91 && c <= 96) || (c >= 123 && c <= 126) || P.test(ch);
}

/** BERT's `_is_chinese_char`, verbatim. Deliberately excludes kana and Hangul. */
function isIdeograph(c: number): boolean {
  return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f)
    || (c >= 0x20000 && c <= 0x2a6df) || (c >= 0x2a700 && c <= 0x2b73f)
    || (c >= 0x2b740 && c <= 0x2b81f) || (c >= 0x2b820 && c <= 0x2ceaf);
}

/**
 * Greedy longest-match-first WordPiece. Unknown words are DROPPED rather than
 * mapped to [UNK]: an [UNK] row is a real vector and averaging it in moves the
 * document toward "unknown" rather than leaving it unaffected.
 */
function wordpiece(text: string, vocab: Map<string, number>, maxChars = 100): number[] {
  const ids: number[] = [];
  for (const word of basicTokenize(text)) {
    if (word.length > maxChars) continue;
    let start = 0;
    const pieces: number[] = [];
    let bad = false;
    while (start < word.length) {
      let end = word.length;
      let found = -1;
      while (start < end) {
        const sub = start === 0 ? word.slice(start, end) : '##' + word.slice(start, end);
        const id = vocab.get(sub);
        if (id !== undefined) { found = id; break; }
        end--;
      }
      if (found < 0) { bad = true; break; }
      pieces.push(found);
      start = end;
    }
    if (!bad) ids.push(...pieces);
  }
  return ids;
}

// ---- embedding -------------------------------------------------------------

/**
 * A loaded int8 embedding table.
 * @typedef {{ vocab: Map<string, number>, rows: Int8Array, scales: Float32Array, dims: number, n: number }} Table
 */

/** Mean-pool the token rows, then L2 normalise. Empty input yields a zero vector,
 *  whose cosine against everything is 0 — which is the honest answer. */
export function embed(text: string, table: DenseTable): Float32Array {
  const { vocab, rows, scales, dims } = table;
  const ids = wordpiece(text, vocab);
  const v = new Float32Array(dims);
  if (!ids.length) return v;
  for (const id of ids) {
    const off = id * dims;
    const sc = scales[id];
    for (let j = 0; j < dims; j++) v[j] += rows[off + j] * sc;
  }
  let norm = 0;
  for (let j = 0; j < dims; j++) { v[j] /= ids.length; norm += v[j] * v[j]; }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let j = 0; j < dims; j++) v[j] /= norm;
  return v;
}

/**
 * Embed a corpus into one contiguous int8 matrix with per-row scales.
 *
 * The matrix is allocated ONCE and never copied. Building an array of
 * Float32Arrays instead is how this design gets slow and how it fragments the
 * heap; at 3,000 x 256 this is 768 kB of int8 in a single allocation.
 */
export function buildCorpus(docs: string[], table: DenseTable): DenseCorpus {
  const dims = table.dims;
  const n = docs.length;
  const mat = new Int8Array(n * dims);
  const scales = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = embed(docs[i], table);
    let max = 0;
    for (let j = 0; j < dims; j++) { const a = Math.abs(v[j]); if (a > max) max = a; }
    const scale = max > 0 ? max / 127 : 0;
    scales[i] = scale;
    if (scale === 0) continue;
    const off = i * dims;
    for (let j = 0; j < dims; j++) mat[off + j] = Math.round(v[j] / scale);
  }
  return { mat, scales, dims, n };
}

/**
 * Top-k by cosine. Both sides are L2-normalised, so cosine IS the dot product —
 * no division, no vector store, no index. At n = 3,000 and d = 256 this is
 * ~768K multiply-adds, measured at 1.5 ms, which is roughly 30x inside a frame
 * budget. An HNSW index would add bytes and failure modes to beat arithmetic
 * that is already free.
 */
export function topK(queryVec: Float32Array, corpus: DenseCorpus, k = 10, floor = 0): Hit[] {
  const { mat, scales, dims, n } = corpus;
  const scored: Hit[] = [];
  for (let i = 0; i < n; i++) {
    const sc = scales[i];
    if (sc === 0) continue;
    const off = i * dims;
    let dot = 0;
    for (let j = 0; j < dims; j++) dot += queryVec[j] * mat[off + j];
    const cos = dot * sc;
    if (cos > floor) scored.push([i, cos]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, k);
}

// ---- table wire format -----------------------------------------------------

/**
 * The on-the-wire table, as written by `poc/fetch-model.mjs`.
 *
 *   meta.json   { model, dims, n, quant: "int8", vocabFile, tableFile }
 *   vocab.json  string[] indexed by token id
 *   table.bin   Int8Array(n * dims) rows, then Float32Array(n) scales
 *
 * Deliberately three plain files rather than one container: the browser can
 * cache them independently, `vocab.json` compresses ~4x on the wire, and
 * `table.bin` is already incompressible so it can be served with no encoding.
 */
export function decodeTable(meta: { dims: number; n: number }, vocabList: string[], buffer: ArrayBuffer): DenseTable {
  const dims = meta.dims, n = meta.n;
  // Network JSON. A NaN or negative dimension makes the length guard below
  // vacuously false (`x < NaN` is false), and `new Int8Array(buffer, 0, NaN)` is
  // a zero-length view — a lane that reports ready and ranks nothing. Fail here,
  // loudly; the caller already turns a throw into `status: 'unavailable'`.
  if (!Number.isSafeInteger(dims) || dims <= 0 || !Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`meta.json invalid: dims=${dims} n=${n}`);
  }
  const rowBytes = n * dims;
  if (buffer.byteLength < rowBytes + n * 4) {
    throw new Error(`table.bin too short: ${buffer.byteLength} bytes, expected ${rowBytes + n * 4}`);
  }
  const rows = new Int8Array(buffer, 0, rowBytes);
  // Float32Array requires 4-byte alignment; rowBytes is n*dims and dims is a
  // multiple of 4 in every shipped configuration, but copy rather than assume.
  const scales = new Float32Array(buffer.slice(rowBytes, rowBytes + n * 4));
  const vocab = new Map<string, number>();
  for (let i = 0; i < vocabList.length; i++) vocab.set(vocabList[i], i);
  return { vocab, rows, scales, dims, n };
}
