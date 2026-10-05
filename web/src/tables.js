// GFM tables: rendered widget for reading, and editing commands for the raw view.

import {EditorSelection} from "@codemirror/state";
import {WidgetType} from "@codemirror/view";
import {syntaxTree} from "@codemirror/language";
import {post} from "./bridge.js";

// ---------- parsing helpers ----------

export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; }
    else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function plainLength(cell) {
  return cell.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").length;
}

// display width in a monospace font: CJK and emoji take two columns
function strWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
         (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) || (c >= 0x1f300 && c <= 0x1faff) ? 2 : 1;
  }
  return w;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
}

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a data-wiki="$1">$2</a>').replace(/\[\[([^\]]+)\]\]/g, '<a data-wiki="$1">$1</a>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a data-href="$2">$1</a>');
  return s;
}

function alignOf(cell) {
  const c = (cell || "").trim();
  if (c.length > 1 && c.startsWith(":") && c.endsWith(":")) return "center";
  if (c.endsWith(":")) return "right";
  if (c.startsWith(":")) return "left";
  return "";
}

// ---------- rendered widget ----------

export class TableWidget extends WidgetType {
  constructor(source) { super(); this.source = source; }
  eq(o) { return o.source === this.source; }

  toDOM(view) {
    const lines = this.source.split("\n");
    const head = splitRow(lines[0]);
    const align = (lines[1] ? splitRow(lines[1]) : []).map(c => alignOf(c) || "left");
    const rows = lines.slice(2).filter(l => l.trim()).map(splitRow);

    // Short columns (paths, codes, numbers) stay on one line; long prose columns
    // wrap and share the remaining width in proportion to how much text they hold.
    const longest = head.map((h, i) => Math.max(plainLength(h), ...rows.map(r => plainLength(r[i] || ""))));
    const nowrap = longest.map(n => n <= 28);
    const wrapTotal = longest.reduce((sum, n, i) => sum + (nowrap[i] ? 0 : Math.min(n, 400)), 0);
    const cellStyle = i => {
      let st = `text-align:${align[i] || "left"};`;
      if (nowrap[i]) st += "white-space:nowrap;";
      else st += `min-width:${Math.max(8, Math.round(24 * Math.min(longest[i], 400) / wrapTotal))}em;`;
      return st;
    };

    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    let html = `<table${nowrap.every(Boolean) ? "" : ' style="width:100%"'}><thead><tr>`;
    head.forEach((c, i) => { html += `<th style="${cellStyle(i)}">${renderInline(c)}</th>`; });
    html += "</tr></thead><tbody>";
    for (const cells of rows) {
      html += "<tr>";
      head.forEach((_, i) => { html += `<td style="${cellStyle(i)}">${renderInline(cells[i] || "")}</td>`; });
      html += "</tr>";
    }
    html += "</tbody></table>";
    wrap.innerHTML = html;

    wrap.addEventListener("mousedown", e => {
      const a = e.target.closest("a[data-href], a[data-wiki]");
      if (a && e.metaKey) {
        e.preventDefault();
        if (a.dataset.wiki) post({type: "wikilink", target: a.dataset.wiki});
        else post({type: "open", url: a.dataset.href});
        return;
      }
      e.preventDefault();
      // put the cursor into the clicked cell
      const cell = e.target.closest("td, th");
      const pos = view.posAtDOM(wrap);
      let target = pos;
      if (cell) {
        const tr = cell.parentElement;
        const rowIdx = tr.parentElement.tagName === "THEAD" ? 0 : tr.sectionRowIndex + 2;
        const lineNo = view.state.doc.lineAt(pos).number + rowIdx;
        if (lineNo <= view.state.doc.lines) {
          const line = view.state.doc.line(lineNo);
          const r = cellRange(line.text, cell.cellIndex);
          target = line.from + r.to;
        }
      }
      view.focus();
      view.dispatch({selection: {anchor: target}});
    });
    return wrap;
  }

  ignoreEvent() { return true; }
}

// ---------- editing ----------

function countPipes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "|" && s[i - 1] !== "\\") n++;
  return n;
}

// content range (trimmed) of cell #col in a raw table line
function cellRange(line, col) {
  const lead = line.trimStart().startsWith("|");
  let count = lead ? -1 : 0, start = lead ? -1 : 0;
  if (!lead && col === 0) start = 0;
  for (let i = 0; i <= line.length; i++) {
    const isPipe = i === line.length || (line[i] === "|" && line[i - 1] !== "\\");
    if (!isPipe) continue;
    if (i < line.length) count++;
    if (count === col && start < 0) { start = i + 1; continue; }
    if (start >= 0 && (count === col + 1 || i === line.length)) {
      let a = start, b = i;
      while (a < b && line[a] === " ") a++;
      while (b > a && line[b - 1] === " ") b--;
      if (a === b) a = b = Math.min(start + 1, i); // empty cell: right after "| "
      return {from: a, to: b};
    }
  }
  return {from: line.length, to: line.length};
}

export function tableAt(state, pos) {
  let node = null;
  for (const side of [-1, 1]) {
    for (let n = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) if (n.name === "Table") { node = n; break; }
    if (node) break;
  }
  if (!node) return null;
  const doc = state.doc;
  const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
  const lines = [];
  for (let i = first.number; i <= last.number; i++) lines.push(doc.line(i).text);
  const cur = doc.lineAt(pos);
  const before = cur.text.slice(0, pos - cur.from);
  const col = Math.max(0, countPipes(before) - (cur.text.trimStart().startsWith("|") ? 1 : 0));
  return {from: first.from, to: last.to, lines, row: cur.number - first.number, col};
}

// rows: array of cell arrays; rows[1] is the delimiter row (alignment markers)
function layout(rows) {
  const ncols = Math.max(...rows.map(r => r.length));
  const align = Array.from({length: ncols}, (_, i) => alignOf(rows[1] && rows[1][i]));
  const esc = s => s.replace(/\|/g, "\\|");
  const body = rows.map((r, ri) => ri === 1 ? null : Array.from({length: ncols}, (_, i) => esc(r[i] || "")));
  const width = Array.from({length: ncols}, (_, i) => Math.max(3, ...body.filter(Boolean).map(r => strWidth(r[i]))));
  const pad = (s, w, a) => {
    const d = w - strWidth(s);
    if (a === "right") return " ".repeat(d) + s;
    if (a === "center") { const l = Math.floor(d / 2); return " ".repeat(l) + s + " ".repeat(d - l); }
    return s + " ".repeat(d);
  };
  const delim = (w, a) => a === "center" ? ":" + "-".repeat(w - 2) + ":" : a === "right" ? "-".repeat(w - 1) + ":" : a === "left" ? ":" + "-".repeat(w - 1) : "-".repeat(w);
  const lines = body.map((r, ri) => ri === 1
    ? "| " + width.map((w, i) => delim(w, align[i])).join(" | ") + " |"
    : "| " + r.map((c, i) => pad(c, width[i], align[i])).join(" | ") + " |");
  return {lines, ncols};
}

function apply(view, t, rows, row, col, selectCell = true) {
  const {lines, ncols} = layout(rows);
  row = Math.max(0, Math.min(row, lines.length - 1));
  col = Math.max(0, Math.min(col, ncols - 1));
  let off = 0;
  for (let i = 0; i < row; i++) off += lines[i].length + 1;
  const c = cellRange(lines[row], col);
  const anchor = t.from + off + c.from, head = t.from + off + c.to;
  view.dispatch({
    changes: {from: t.from, to: t.to, insert: lines.join("\n")},
    selection: selectCell ? EditorSelection.range(anchor, head) : EditorSelection.cursor(head),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

const rowsOf = t => t.lines.map(splitRow);

export function tableTab(view, dir) {
  const t = tableAt(view.state, view.state.selection.main.head);
  if (!t) return false;
  const rows = rowsOf(t);
  const ncols = Math.max(...rows.map(r => r.length));
  let row = t.row, col = Math.min(t.col, ncols - 1) + dir;
  if (col >= ncols) { col = 0; row++; }
  else if (col < 0) { col = ncols - 1; row--; }
  if (row === 1) row += dir;
  if (row < 0) { row = 0; col = 0; }
  if (row >= rows.length) rows.push(Array(ncols).fill(""));
  return apply(view, t, rows, row, col);
}

export function tableEnter(view) {
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const t = tableAt(view.state, sel.head);
  if (!t) return false;
  const rows = rowsOf(t);
  const ncols = Math.max(...rows.map(r => r.length));
  const isLast = t.row === rows.length - 1;
  if (t.row >= 2 && isLast && rows[t.row].every(c => !c)) {
    // Enter on an empty last row leaves the table
    rows.pop();
    const {lines} = layout(rows);
    const text = lines.join("\n") + "\n";
    view.dispatch({changes: {from: t.from, to: t.to, insert: text}, selection: {anchor: t.from + text.length}, scrollIntoView: true, userEvent: "input"});
    return true;
  }
  const at = Math.max(2, t.row + 1);
  rows.splice(at, 0, Array(ncols).fill(""));
  return apply(view, t, rows, at, 0, false);
}

export function formatTable(view) {
  const t = tableAt(view.state, view.state.selection.main.head);
  if (!t) return false;
  return apply(view, t, rowsOf(t), t.row, t.col, false);
}

export function addColumn(view) {
  const t = tableAt(view.state, view.state.selection.main.head);
  if (!t) return false;
  const rows = rowsOf(t).map((r, i) => { const c = [...r]; c.splice(t.col + 1, 0, i === 1 ? "---" : ""); return c; });
  return apply(view, t, rows, 0, t.col + 1);
}

export function deleteColumn(view) {
  const t = tableAt(view.state, view.state.selection.main.head);
  if (!t) return false;
  const rows = rowsOf(t);
  if (Math.max(...rows.map(r => r.length)) <= 1) return true;
  rows.forEach(r => r.splice(t.col, 1));
  return apply(view, t, rows, t.row, Math.max(0, t.col - 1), false);
}

export function deleteRow(view) {
  const t = tableAt(view.state, view.state.selection.main.head);
  if (!t || t.row < 2) return true;
  const rows = rowsOf(t);
  rows.splice(t.row, 1);
  return apply(view, t, rows, Math.min(t.row, rows.length - 1), t.col, false);
}

export function insertTable(view) {
  const {state} = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const {lines} = layout([["Колонка 1", "Колонка 2", "Колонка 3"], ["---", "---", "---"], ["", "", ""]]);
  const text = lines.join("\n");
  const prefix = line.text.trim() ? "\n\n" : "";
  const at = line.text.trim() ? line.to : line.from;
  const start = at + prefix.length;
  const c = cellRange(lines[0], 0);
  view.dispatch({
    changes: {from: at, to: line.text.trim() ? at : line.to, insert: prefix + text + "\n"},
    selection: EditorSelection.range(start + c.from, start + c.to),
    scrollIntoView: true,
    userEvent: "input",
  });
  view.focus();
  return true;
}
