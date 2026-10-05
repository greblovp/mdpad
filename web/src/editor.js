import {EditorState, EditorSelection, Compartment, Transaction, Annotation, Prec, Text} from "@codemirror/state";
import {EditorView, keymap, drawSelection, dropCursor, rectangularSelection} from "@codemirror/view";
import {defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll} from "@codemirror/commands";
import {markdown, markdownLanguage} from "@codemirror/lang-markdown";
import {syntaxTree, syntaxHighlighting, HighlightStyle, indentOnInput} from "@codemirror/language";
import {languages} from "@codemirror/language-data";
import {search, searchKeymap, highlightSelectionMatches, openSearchPanel} from "@codemirror/search";
import {tags as t} from "@lezer/highlight";

import {native, post, env, frontmatterRange} from "./bridge.js";
import {preview, refreshBlocks, WIKILINK_RE} from "./preview.js";
import {tableTab, tableEnter, formatTable, addColumn, deleteColumn, deleteRow, insertTable} from "./tables.js";
import {smartPaste} from "./paste.js";
import {renderHTML, exportDocument} from "./render.js";
import {outlineAndStatus} from "./outline.js";

const External = Annotation.define();

// ---------- highlight style ----------

const highlight = HighlightStyle.define([
  {tag: t.strong, fontWeight: "700"},
  {tag: t.emphasis, fontStyle: "italic"},
  {tag: t.strikethrough, textDecoration: "line-through", color: "var(--muted)"},
  {tag: t.link, color: "var(--link)"},
  {tag: t.url, color: "var(--link)"},
  {tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "700"},
  {tag: t.processingInstruction, color: "var(--muted)"},
  {tag: t.labelName, color: "var(--muted)"},
  {tag: t.monospace, fontFamily: "var(--mono)"},
  {tag: t.quote, color: "var(--quote)"},
  {tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: "var(--c-keyword)"},
  {tag: [t.string, t.special(t.string), t.regexp], color: "var(--c-string)"},
  {tag: [t.comment, t.lineComment, t.blockComment], color: "var(--c-comment)", fontStyle: "italic"},
  {tag: [t.number, t.bool, t.null, t.atom], color: "var(--c-number)"},
  {tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--c-func)"},
  {tag: [t.typeName, t.className, t.namespace], color: "var(--c-type)"},
  {tag: [t.propertyName, t.attributeName], color: "var(--c-prop)"},
  {tag: [t.tagName], color: "var(--c-keyword)"},
]);

// ---------- formatting commands ----------

function toggleWrap(view, mark) {
  const {state} = view;
  const ml = mark.length;
  const tr = state.changeByRange(range => {
    const before = state.sliceDoc(range.from - ml, range.from);
    const after = state.sliceDoc(range.to, range.to + ml);
    const inner = state.sliceDoc(range.from, range.to);
    if (before === mark && after === mark)
      return {changes: [{from: range.from - ml, to: range.from}, {from: range.to, to: range.to + ml}], range: EditorSelection.range(range.from - ml, range.to - ml)};
    if (inner.length >= 2 * ml && inner.startsWith(mark) && inner.endsWith(mark))
      return {changes: [{from: range.from, to: range.from + ml}, {from: range.to - ml, to: range.to}], range: EditorSelection.range(range.from, range.to - 2 * ml)};
    return {changes: [{from: range.from, insert: mark}, {from: range.to, insert: mark}], range: EditorSelection.range(range.from + ml, range.to + ml)};
  });
  view.dispatch(state.update(tr, {scrollIntoView: true, userEvent: "input"}));
  view.focus();
}

function insertLink(view) {
  const {state} = view;
  const tr = state.changeByRange(range => {
    const text = state.sliceDoc(range.from, range.to);
    const cursor = text ? range.from + text.length + 3 : range.from + 1;
    return {changes: {from: range.from, to: range.to, insert: `[${text}]()`}, range: EditorSelection.cursor(cursor)};
  });
  view.dispatch(state.update(tr, {scrollIntoView: true, userEvent: "input"}));
  view.focus();
}

function setHeading(view, level) {
  const {state} = view;
  const changes = [];
  const seen = new Set();
  for (const r of state.selection.ranges) {
    for (let p = r.from; p <= r.to;) {
      const line = state.doc.lineAt(p);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        const m = /^(#{1,6})\s+/.exec(line.text);
        const current = m ? m[1].length : 0;
        const prefix = level === 0 || current === level ? "" : "#".repeat(level) + " ";
        changes.push({from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix});
      }
      p = line.to + 1;
    }
  }
  view.dispatch({changes, userEvent: "input"});
  view.focus();
}

// ---------- links: Cmd+click ----------

function linkAt(view, pos) {
  const {state} = view;
  const line = state.doc.lineAt(pos);
  WIKILINK_RE.lastIndex = 0;
  for (let m; (m = WIKILINK_RE.exec(line.text));) {
    const start = line.from + m.index, end = start + m[0].length;
    if (pos >= start && pos <= end) return {wiki: m[2].split("|")[0]};
  }
  for (const side of [1, -1]) {
    for (let node = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "URL" || node.name === "Autolink") return {url: state.sliceDoc(node.from, node.to).replace(/^<|>$/g, "")};
      if (node.name === "Link" || node.name === "Image") {
        const url = node.getChild("URL");
        return url ? {url: state.sliceDoc(url.from, url.to)} : null;
      }
    }
  }
  return null;
}

const linkClicks = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!e.metaKey) return false;
    const pos = view.posAtCoords({x: e.clientX, y: e.clientY});
    if (pos == null) return false;
    const link = linkAt(view, pos);
    if (!link) return false;
    e.preventDefault();
    post(link.wiki ? {type: "wikilink", target: link.wiki} : {type: "open", url: link.url});
    return true;
  },
});

window.addEventListener("keydown", e => { if (e.key === "Meta") document.body.classList.add("cmd-held"); });
window.addEventListener("keyup", e => { if (e.key === "Meta") document.body.classList.remove("cmd-held"); });
window.addEventListener("blur", () => document.body.classList.remove("cmd-held"));

// ---------- editor ----------

// Cmd+/ is "show source" and Cmd+I is italic (both via the app menu), not CodeMirror's defaults
const taken = new Set(["Mod-/", "Mod-i", "Alt-A", "Shift-Alt-a"]);
const baseKeys = defaultKeymap.filter(b => !taken.has(b.key));

const previewMode = new Compartment();
const spellMode = new Compartment();
let sourceMode = false;
let spellcheck = false;

const spellAttrs = on => EditorView.contentAttributes.of({spellcheck: on ? "true" : "false", autocorrect: "off", autocapitalize: "off"});

const outlineEl = document.getElementById("outline");
const statusEl = document.getElementById("status");

function extensions() {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    indentOnInput(),
    EditorView.lineWrapping,
    markdown({base: markdownLanguage, codeLanguages: languages, addKeymap: true}),
    syntaxHighlighting(highlight),
    search({top: true}),
    highlightSelectionMatches(),
    previewMode.of(sourceMode ? [] : preview),
    spellMode.of(spellAttrs(spellcheck)),
    linkClicks,
    smartPaste,
    outlineAndStatus(outlineEl, statusEl),
    Prec.highest(keymap.of([
      {key: "Tab", run: v => tableTab(v, 1)},
      {key: "Shift-Tab", run: v => tableTab(v, -1)},
      {key: "Enter", run: tableEnter},
    ])),
    keymap.of([...searchKeymap, ...historyKeymap, ...baseKeys, indentWithTab]),
    EditorView.updateListener.of(u => {
      if (u.docChanged && !u.transactions.some(tr => tr.annotation(External)))
        post({type: "change", text: u.state.doc.toString()});
    }),
  ];
}

const view = new EditorView({
  state: EditorState.create({doc: "", extensions: extensions()}),
  parent: document.getElementById("editor"),
});

// redraw diagrams when the system switches between light and dark
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => view.dispatch({effects: refreshBlocks.of(null)}));

function selectedMarkdown() {
  const {state} = view;
  const parts = state.selection.ranges.filter(r => !r.empty).map(r => state.sliceDoc(r.from, r.to));
  return parts.length ? parts.join("\n\n") : state.doc.toString();
}

let loaded = false;
const WIDTHS = {narrow: "640px", medium: "760px", wide: "960px", full: "100%"};

window.md = {
  setContent(text) {
    if (!loaded) {
      loaded = true;
      // start below the front matter so it opens collapsed
      const fm = frontmatterRange(Text.of(text.split("\n")));
      const anchor = fm ? Math.min(fm.to + 1, text.length) : 0;
      view.setState(EditorState.create({doc: text, selection: {anchor}, extensions: extensions()}));
      return;
    }
    if (text === view.state.doc.toString()) return;
    const head = Math.min(view.state.selection.main.head, text.length);
    view.dispatch({
      changes: {from: 0, to: view.state.doc.length, insert: text},
      selection: {anchor: head},
      annotations: [Transaction.addToHistory.of(false), External.of(true)],
    });
  },
  setBase(dir) { env.baseDir = dir || ""; },
  setPrefs(p) {
    const root = document.documentElement.style;
    if (p.fontSize) root.setProperty("--font-size", p.fontSize + "px");
    root.setProperty("--content-width", WIDTHS[p.width] || WIDTHS.medium);
    document.body.classList.toggle("font-serif", p.font === "serif");
    document.body.classList.toggle("font-mono", p.font === "mono");
    document.body.classList.toggle("show-outline", !!p.outline);
    if (!!p.spellcheck !== spellcheck) {
      spellcheck = !!p.spellcheck;
      view.dispatch({effects: spellMode.reconfigure(spellAttrs(spellcheck))});
    }
    view.requestMeasure();
  },
  focus() { view.focus(); },
  toggleSource() {
    sourceMode = !sourceMode;
    view.dispatch({effects: previewMode.reconfigure(sourceMode ? [] : preview)});
    document.body.classList.toggle("source-mode", sourceMode);
  },
  undo() { undo(view); },
  redo() { redo(view); },
  selectAll() { view.focus(); selectAll(view); },
  find() { view.focus(); openSearchPanel(view); },
  bold() { toggleWrap(view, "**"); },
  italic() { toggleWrap(view, "*"); },
  code() { toggleWrap(view, "`"); },
  strike() { toggleWrap(view, "~~"); },
  link() { insertLink(view); },
  heading(level) { setHeading(view, level); },
  insertText(text) {
    view.focus();
    view.dispatch(view.state.replaceSelection(text), {userEvent: "input.paste", scrollIntoView: true});
  },
  insertImage(path, alt) {
    view.focus();
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.from);
    const endLine = view.state.doc.lineAt(sel.to);
    // an image is its own paragraph
    const before = line.text.slice(0, sel.from - line.from).trim() ? "\n\n" : "";
    const after = endLine.text.slice(sel.to - endLine.from).trim() ? "\n\n" : "";
    view.dispatch(view.state.replaceSelection(`${before}![${alt || ""}](${path})${after}`), {userEvent: "input.paste", scrollIntoView: true});
  },
  insertTable() { insertTable(view); },
  formatTable() { formatTable(view); },
  addColumn() { addColumn(view); },
  deleteColumn() { deleteColumn(view); },
  deleteRow() { deleteRow(view); },
  async copyRich() {
    const html = await renderHTML(selectedMarkdown(), "clipboard");
    post({type: "copyRich", html});
    return html;
  },
  exportHTML(title) { return exportDocument(view.state.doc.toString(), title); },
};

if (native) post({type: "ready"});
else fetch(new URLSearchParams(location.search).get("f") || "sample.md")
  .then(r => r.ok ? r.text() : "")
  .then(text => window.md.setContent(text || "# MDPad\n\nNo sample.md"));
