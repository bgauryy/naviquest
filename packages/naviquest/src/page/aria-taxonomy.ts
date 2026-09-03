/**
 * ARIA superclass-chain sets, hand-maintained.
 *
 * Originally derived from `aria-query`'s role taxonomy (139 roles, 127 concrete).
 * The generator is gone, so a role added to a future ARIA version will not
 * classify itself until this file is updated. `yarn eval --only roles` is the sensor.
 */

/** Roles whose superclass chain contains `landmark`. */
export const LANDMARK_ROLES: readonly string[] = [
  'banner', 'complementary', 'contentinfo', 'doc-acknowledgments', 'doc-afterword',
  'doc-appendix', 'doc-bibliography', 'doc-chapter', 'doc-conclusion', 'doc-credits',
  'doc-endnotes', 'doc-epilogue', 'doc-errata', 'doc-foreword', 'doc-glossary', 'doc-index',
  'doc-introduction', 'doc-pagelist', 'doc-part', 'doc-preface', 'doc-prologue', 'doc-toc',
  'form', 'main', 'navigation', 'region', 'search',
];

/** Roles whose superclass chain contains the abstract `widget` role. */
export const WIDGET_ROLES: readonly string[] = [
  'button', 'checkbox', 'columnheader', 'combobox', 'doc-backlink', 'doc-biblioref',
  'doc-glossref', 'doc-noteref', 'grid', 'gridcell', 'link', 'listbox', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'progressbar', 'radio',
  'radiogroup', 'row', 'rowheader', 'scrollbar', 'searchbox', 'slider', 'spinbutton', 'switch',
  'tab', 'tablist', 'textbox', 'tree', 'treegrid', 'treeitem',
];

/** Repeated addressable containers — see gen-taxonomy.ts for the extension. */
export const ROW_ROLES: readonly string[] = [
  'article', 'doc-biblioentry', 'doc-endnote', 'gridcell', 'listitem', 'option', 'row',
  'treeitem',
];

/** Every non-abstract role name, for validating an authored `role` attribute. */
export const VALID_ROLES: readonly string[] = [
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
  'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo',
  'definition', 'deletion', 'dialog', 'directory', 'doc-abstract', 'doc-acknowledgments',
  'doc-afterword', 'doc-appendix', 'doc-backlink', 'doc-biblioentry', 'doc-bibliography',
  'doc-biblioref', 'doc-chapter', 'doc-colophon', 'doc-conclusion', 'doc-cover', 'doc-credit',
  'doc-credits', 'doc-dedication', 'doc-endnote', 'doc-endnotes', 'doc-epigraph',
  'doc-epilogue', 'doc-errata', 'doc-example', 'doc-footnote', 'doc-foreword', 'doc-glossary',
  'doc-glossref', 'doc-index', 'doc-introduction', 'doc-noteref', 'doc-notice', 'doc-pagebreak',
  'doc-pagefooter', 'doc-pageheader', 'doc-pagelist', 'doc-part', 'doc-preface', 'doc-prologue',
  'doc-pullquote', 'doc-qna', 'doc-subtitle', 'doc-tip', 'doc-toc', 'document', 'emphasis',
  'feed', 'figure', 'form', 'generic', 'graphics-document', 'graphics-object',
  'graphics-symbol', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note',
  'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row',
  'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
  'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table',
  'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree',
  'treegrid', 'treeitem',
];

/** Roles whose accessible name may come from their own contents. */
export const NAME_FROM_CONTENT_ROLES: readonly string[] = [
  'button', 'cell', 'checkbox', 'columnheader', 'doc-backlink', 'doc-biblioref', 'doc-glossref',
  'doc-noteref', 'graphics-object', 'gridcell', 'heading', 'link', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowgroup', 'rowheader',
  'switch', 'tab', 'tooltip', 'treeitem',
];
