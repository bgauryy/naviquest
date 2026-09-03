/**
 * The six callable names, and NOTHING else.
 *
 * Routing needs names eagerly: `tools` is a public sync property, so the
 * dispatch map has to exist before any tool is called. Agent-facing METADATA —
 * titles, descriptions, JSON Schemas — does not, and it is 4,888 minified bytes
 * (1,405 gzip of the eager closure, measured 2026-09-02). Keeping the schemas in
 * `tool-specs.ts` behind the same dynamic import as the answer engine is what
 * puts the eager bundle back under the 30 kB product line.
 *
 * This file is the single source for the names. `tool-specs.ts` imports it and
 * tsc rejects any drift between the two (§ ToolNamesCoverSpecs there), so the
 * split is not a second declaration of the tool surface.
 */
export const TOOL_NAMES = ['describe_app', 'find_on_page', 'locate_control',
  'resolve_address', 'query_selector', 'agentic_content'] as const;

export type ToolSpecName = typeof TOOL_NAMES[number];
