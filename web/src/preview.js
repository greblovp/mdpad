// Live preview: markup is hidden and rendered everywhere except on the lines the cursor is on.

import {StateField, StateEffect} from "@codemirror/state";
import {EditorView, Decoration, ViewPlugin, WidgetType} from "@codemirror/view";
import {syntaxTree, ensureSyntaxTree} from "@codemirror/language";
import {post, resolveSrc, isDark, frontmatterRange, calloutStyle, CALLOUT_RE} from "./bridge.js";
import {TableWidget} from "./tables.js";
import {MermaidWidget} from "./mermaid.js";

const hide = Decoration.replace({});
const BULLETS = ["•", "◦", "▪"];
const INDENT = 1.5; // em per nesting level

// ---------- widgets ----------

class MarkerWidget extends WidgetType {
  constructor(text, width, kind) { super(); this.text = text; this.width = width; this.kind = kind; }
  eq(o) { return o.text === this.text && o.width === this.width && o.kind === this.kind; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-list-marker cm-list-marker-" + this.kind;
    s.style.width = this.width + "em";
    s.textContent = this.text;
    return s;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, width) { super(); this.checked = checked; this.width = width; }
  eq(o) { return o.checked === this.checked && o.width === this.width; }
  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "cm-list-marker";
    wrap.style.width = this.width + "em";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", e => e.preventDefault());
    box.addEventListener("click", e => {
      e.preventDefault();
      const pos = view.posAtDOM(wrap);
      const line = view.state.doc.lineAt(pos);
      const m = /\[[ xX]\]/.exec(line.text.slice(pos - line.from));
      if (!m) return;
      const at = pos + m.index;
      view.dispatch({changes: {from: at, to: at + 3, insert: /x/i.test(m[0]) ? "[ ]" : "[x]"}, userEvent: "input"});
    });
    wrap.appendChild(box);
    return wrap;
  }
  ignoreEvent() { return false; }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-hr"; return s; }
}

class FenceWidget extends WidgetType {
  constructor(lang) { super(); this.lang = lang; }
  eq(o) { return o.lang === this.lang; }
  toDOM(view) {
    const s = document.createElement("span");
    s.className = "cm-fence-label";
    const label = document.createElement("span");
    label.textContent = this.lang;
    const btn = document.createElement("button");
    btn.className = "cm-copy";
    btn.textContent = "Копировать";
    btn.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(s);
      for (let n = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
        if (n.name !== "FencedCode") continue;
        const code = n.getChild("CodeText");
        post({type: "copy", text: code ? view.state.sliceDoc(code.from, code.to) : ""});
        btn.textContent = "Скопировано";
        setTimeout(() => { btn.textContent = "Копировать"; }, 1200);
        break;
      }
    });
    s.append(label, btn);
    return s;
  }
  ignoreEvent(e) { return !!(e.target && e.target.closest && e.target.closest(".cm-copy")); }
}

class CalloutTitleWidget extends WidgetType {
  constructor(icon, label) { super(); this.icon = icon; this.label = label; }
  eq(o) { return o.icon === this.icon && o.label === this.label; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-callout-icon";
    s.textContent = this.label ? `${this.icon} ${this.label}` : this.icon + " ";
    return s;
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src && o.alt === this.alt; }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-image";
    const img = document.createElement("img");
    img.src = resolveSrc(this.src);
    img.alt = this.alt;
    img.onerror = () => { wrap.textContent = "🖼 " + (this.alt || this.src); wrap.classList.add("cm-image-broken"); };
    wrap.appendChild(img);
    return wrap;
  }
}

class FrontmatterWidget extends WidgetType {
  constructor(source) { super(); this.source = source; }
  eq(o) { return o.source === this.source; }
  toDOM(view) {
    const box = document.createElement("div");
    box.className = "cm-frontmatter-box";
    const rows = [];
    let current = null;
    for (const line of this.source.split("\n")) {
      const kv = /^([\w\-. ]+):\s*(.*)$/.exec(line);
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (kv) { current = {key: kv[1], values: kv[2] ? [kv[2]] : []}; rows.push(current); }
      else if (item && current) current.values.push(item[1]);
    }
    const esc = s => s.replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
    const clean = v => v.replace(/^["']|["']$/g, "").replace(/^\[|\]$/g, "");
    box.innerHTML = rows.length
      ? rows.map(r => {
          let vals = r.values.length === 1 && /^\[.*\]$/.test(r.values[0]) ? r.values[0].slice(1, -1).split(",") : r.values;
          vals = vals.map(v => clean(v.trim())).filter(Boolean);
          const html = vals.length > 1 || r.values.length > 1 || /^tags?$|^aliases$/.test(r.key)
            ? vals.map(v => `<span class="cm-fm-chip">${esc(v)}</span>`).join(" ")
            : esc(vals[0] || "");
          return `<div class="cm-fm-row"><span class="cm-fm-key">${esc(r.key)}</span><span class="cm-fm-val">${html}</span></div>`;
        }).join("")
      : `<div class="cm-fm-row"><span class="cm-fm-key">properties</span></div>`;
    box.addEventListener("mousedown", e => {
      e.preventDefault();
      view.focus();
      view.dispatch({selection: {anchor: Math.min(view.state.doc.line(1).to + 1, view.state.doc.length)}});
    });
    return box;
  }
  ignoreEvent() { return true; }
}

// ---------- helpers ----------

function activeLines(view) {
  const set = new Set();
  if (!view.hasFocus) return set;
  const doc = view.state.doc;
  for (const r of view.state.selection.ranges) {
    const a = doc.lineAt(r.from).number, b = doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set;
}

function selectionTouches(state, from, to) {
  return state.selection.ranges.some(r => r.to >= from && r.from <= to);
}

function listDepth(list) {
  let d = 0;
  for (let p = list.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") d++;
  return d;
}

function inCode(tree, pos) {
  for (let n = tree.resolveInner(pos, 1); n; n = n.parent)
    if (n.name === "InlineCode" || n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "CodeText") return true;
  return false;
}

function fenceLang(state, node) {
  const info = node.getChild("CodeInfo");
  return info ? state.sliceDoc(info.from, info.to).trim() : "";
}

export const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

// ---------- inline decorations ----------

function buildInline(view) {
  const {state} = view;
  const doc = state.doc;
  const active = activeLines(view);
  const isActive = (from, to) => {
    const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
    for (let i = a; i <= b; i++) if (active.has(i)) return true;
    return false;
  };
  const decos = [];
  const lineDeco = (pos, spec) => decos.push(Decoration.line(spec).range(doc.lineAt(pos).from));
  const lineClass = (pos, cls) => lineDeco(pos, {class: cls});
  const eachLine = (from, to, fn) => { for (let p = from; p <= to;) { const l = doc.lineAt(p); fn(l); p = l.to + 1; } };
  const tree = syntaxTree(state);
  const fm = frontmatterRange(doc);
  const seen = new Set();

  if (fm) eachLine(fm.from, fm.to, l => lineClass(l.from, "cm-frontmatter"));

  for (const {from, to} of view.visibleRanges) {
    tree.iterate({from, to, enter: node => {
      if (fm && node.from <= fm.to) return node.to > fm.to ? undefined : false;
      const key = node.name + ":" + node.from + ":" + node.to;
      if (seen.has(key)) return false;
      seen.add(key);
      const name = node.name;

      if (name === "Table") {
        if (isActive(node.from, node.to) || selectionTouches(state, doc.lineAt(node.from).from, doc.lineAt(node.to).to))
          eachLine(node.from, node.to, l => lineClass(l.from, "cm-table-raw"));
        return false;
      }

      const h = /^ATXHeading(\d)$/.exec(name);
      if (h) {
        lineClass(node.from, "cm-h" + h[1]);
        if (!isActive(node.from, node.to)) {
          for (let c = node.node.firstChild; c; c = c.nextSibling) {
            if (c.name !== "HeaderMark") continue;
            let start = c.from, end = c.to;
            if (doc.sliceString(end, end + 1) === " ") end++;
            if (start > node.from && doc.sliceString(start - 1, start) === " ") start--;
            if (end > start) decos.push(hide.range(start, end));
          }
        }
        return;
      }

      const sh = /^SetextHeading(\d)$/.exec(name);
      if (sh) {
        eachLine(node.from, node.to, l => lineClass(l.from, /^\s*[=-]+\s*$/.test(l.text) ? "cm-setext-mark" : "cm-h" + sh[1]));
        return;
      }

      if (name === "EmphasisMark" || name === "StrikethroughMark") {
        const parent = node.node.parent;
        if (parent && !isActive(parent.from, parent.to)) decos.push(hide.range(node.from, node.to));
        return;
      }

      if (name === "InlineCode") {
        decos.push(Decoration.mark({class: "cm-inline-code"}).range(node.from, node.to));
        if (!isActive(node.from, node.to))
          for (let c = node.node.firstChild; c; c = c.nextSibling) if (c.name === "CodeMark") decos.push(hide.range(c.from, c.to));
        return false;
      }

      if (name === "Link") {
        const n = node.node;
        const marks = n.getChildren("LinkMark");
        const url = n.getChild("URL");
        decos.push(Decoration.mark({class: "cm-link-text"}).range(node.from, node.to));
        if (!isActive(node.from, node.to) && marks.length >= 2 && doc.lineAt(node.from).number === doc.lineAt(node.to).number) {
          decos.push(hide.range(marks[0].from, marks[0].to));
          decos.push(hide.range(marks[1].from, node.to));
        }
        return url ? false : undefined;
      }

      if (name === "Image") {
        const n = node.node;
        const url = n.getChild("URL");
        const single = doc.lineAt(node.from).number === doc.lineAt(node.to).number;
        if (url && single && !isActive(node.from, node.to)) {
          const marks = n.getChildren("LinkMark");
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
          decos.push(Decoration.replace({widget: new ImageWidget(doc.sliceString(url.from, url.to), alt)}).range(node.from, node.to));
        }
        return false;
      }

      if (name === "Autolink" || name === "URL") {
        decos.push(Decoration.mark({class: "cm-link-text cm-bare-url"}).range(node.from, node.to));
        return false;
      }

      if (name === "Blockquote") {
        const first = doc.lineAt(node.from);
        const m = CALLOUT_RE.exec(first.text);
        const last = doc.lineAt(node.to);
        if (!m) { eachLine(node.from, node.to, l => lineClass(l.from, "cm-blockquote")); return; }
        const {color, icon, label} = calloutStyle(m[2]);
        eachLine(node.from, node.to, l => {
          let cls = `cm-callout cm-callout-${color}`;
          if (l.number === first.number) cls += " cm-callout-first";
          if (l.number === last.number) cls += " cm-callout-last";
          lineClass(l.from, cls);
        });
        const typeFrom = first.from + m[1].length;
        const typeTo = typeFrom + m[2].length + 3 + m[3].length;
        const title = m[4];
        if (title) decos.push(Decoration.mark({class: "cm-callout-title"}).range(first.to - title.length, first.to));
        if (!isActive(first.from, first.to)) {
          let end = typeTo;
          while (doc.sliceString(end, end + 1) === " " || doc.sliceString(end, end + 1) === "\t") end++;
          decos.push(Decoration.replace({widget: new CalloutTitleWidget(icon, title ? "" : label)}).range(typeFrom, end));
        }
        return;
      }

      if (name === "QuoteMark") {
        if (!isActive(node.from, node.to)) {
          let end = node.to;
          if (doc.sliceString(end, end + 1) === " ") end++;
          decos.push(hide.range(node.from, end));
        }
        return;
      }

      if (name === "ListItem") {
        const item = node.node;
        const list = item.parent;
        const mark = item.getChild("ListMark");
        if (!mark || !list) return;
        const line = doc.lineAt(item.from);
        const depth = listDepth(list);
        const ordered = list.name === "OrderedList";
        const task = item.getChild("Task");
        const taskMarker = task && task.getChild("TaskMarker");
        const markText = doc.sliceString(mark.from, mark.to);
        const width = taskMarker ? 1.7 : ordered ? Math.max(1.5, markText.length * 0.58 + 0.6) : 1.3;
        const pad = depth * INDENT + width;
        const plainLead = /^\s*$/.test(doc.sliceString(line.from, mark.from));

        if (plainLead) {
          lineDeco(line.from, {class: "cm-list-line", attributes: {style: `padding-left:${pad}em;text-indent:-${width}em`}});
          if (mark.from > line.from) decos.push(hide.range(line.from, mark.from));
        }

        let markerEnd = taskMarker ? taskMarker.to : mark.to;
        if (doc.sliceString(markerEnd, markerEnd + 1) === " ") markerEnd++;
        const checked = taskMarker && /x/i.test(doc.sliceString(taskMarker.from, taskMarker.to));

        if (isActive(line.from, line.to)) {
          decos.push(Decoration.mark({class: "cm-list-mark", attributes: {style: `display:inline-block;min-width:${width}em;text-indent:0`}}).range(mark.from, markerEnd));
        } else {
          const widget = taskMarker ? new CheckboxWidget(checked, width)
            : new MarkerWidget(ordered ? markText : BULLETS[depth % 3], width, ordered ? "ordered" : "bullet");
          decos.push(Decoration.replace({widget}).range(mark.from, markerEnd));
        }
        if (checked && markerEnd < task.to) decos.push(Decoration.mark({class: "cm-task-done"}).range(markerEnd, task.to));

        // continuation lines of the same item hang under the text, not under the marker
        if (plainLead) {
          const skip = [];
          for (let c = item.firstChild; c; c = c.nextSibling)
            if (/List$|FencedCode|CodeBlock|Table|Blockquote/.test(c.name)) skip.push([c.from, c.to]);
          const last = doc.lineAt(item.to).number;
          for (let n = line.number + 1; n <= last; n++) {
            const l = doc.line(n);
            if (!l.text.trim() || skip.some(([a, b]) => l.to >= a && l.from <= b)) continue;
            const ws = /^\s*/.exec(l.text)[0].length;
            lineDeco(l.from, {class: "cm-list-line", attributes: {style: `padding-left:${pad}em`}});
            if (ws) decos.push(hide.range(l.from, l.from + ws));
          }
        }
        return;
      }

      if (name === "HorizontalRule") {
        if (!isActive(node.from, node.to)) decos.push(Decoration.replace({widget: new RuleWidget()}).range(node.from, node.to));
        return false;
      }

      if (name === "FencedCode" || name === "CodeBlock") {
        const fenced = name === "FencedCode";
        const lang = fenced ? fenceLang(state, node.node) : "";
        const first = doc.lineAt(node.from), last = doc.lineAt(node.to);
        if (lang.toLowerCase() === "mermaid" && !selectionTouches(state, first.from, last.to)) return false; // drawn as a diagram
        const active = isActive(node.from, node.to);
        const closing = l => /^\s*(```|~~~)/.test(l.text);
        eachLine(node.from, node.to, l => {
          let cls = "cm-codeblock";
          if (l.number === first.number) cls += " cm-codeblock-begin";
          if (l.number === last.number) cls += " cm-codeblock-end";
          if (fenced && !active && (l.number === first.number || (l.number === last.number && closing(l)))) cls += " cm-fence-line";
          lineClass(l.from, cls);
        });
        if (fenced && !active) {
          if (first.length > 0) decos.push(Decoration.replace({widget: new FenceWidget(lang)}).range(first.from, first.to));
          if (last.number !== first.number && closing(last) && last.length > 0) decos.push(hide.range(last.from, last.to));
        }
        return;
      }
    }});

    // [[wiki links]] are not part of the Markdown grammar, so find them by hand
    const text = doc.sliceString(from, to);
    WIKILINK_RE.lastIndex = 0;
    for (let m; (m = WIKILINK_RE.exec(text));) {
      const start = from + m.index, end = start + m[0].length;
      if ((fm && start <= fm.to) || inCode(tree, start) || seen.has("wiki:" + start)) continue;
      seen.add("wiki:" + start);
      const open = start + m[1].length;
      const pipe = m[2].indexOf("|");
      decos.push(Decoration.mark({class: "cm-link-text cm-wikilink"}).range(start, end));
      if (!isActive(start, end)) {
        decos.push(hide.range(start, open + 2));
        if (pipe >= 0) decos.push(hide.range(open + 2, open + 2 + pipe + 1));
        decos.push(hide.range(end - 2, end));
      }
    }
  }
  return Decoration.set(decos, true);
}

const inlinePreview = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildInline(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
      this.decorations = buildInline(u.view);
  }
}, {decorations: v => v.decorations});

// ---------- block widgets: front matter, tables, diagrams ----------

export const refreshBlocks = StateEffect.define();

function buildBlocks(state) {
  const decos = [];
  const doc = state.doc;
  const fm = frontmatterRange(doc);
  if (fm && !selectionTouches(state, fm.from, fm.to))
    decos.push(Decoration.replace({widget: new FrontmatterWidget(doc.sliceString(fm.bodyFrom, fm.bodyTo)), block: true}).range(fm.from, fm.to));

  const tree = ensureSyntaxTree(state, doc.length, 200) || syntaxTree(state);
  const dark = isDark();
  tree.iterate({enter: node => {
    if (fm && node.from <= fm.to) return node.to > fm.to ? undefined : false;
    if (node.name === "Table") {
      const from = doc.lineAt(node.from).from, to = doc.lineAt(node.to).to;
      if (!selectionTouches(state, from, to))
        decos.push(Decoration.replace({widget: new TableWidget(doc.sliceString(from, to)), block: true}).range(from, to));
      return false;
    }
    if (node.name === "FencedCode") {
      if (fenceLang(state, node.node).toLowerCase() !== "mermaid") return false;
      const from = doc.lineAt(node.from).from, to = doc.lineAt(node.to).to;
      const code = node.node.getChild("CodeText");
      if (code && !selectionTouches(state, from, to))
        decos.push(Decoration.replace({widget: new MermaidWidget(doc.sliceString(code.from, code.to), dark), block: true}).range(from, to));
      return false;
    }
  }});
  return Decoration.set(decos, true);
}

const blockPreview = StateField.define({
  create: buildBlocks,
  update(value, tr) {
    return tr.docChanged || tr.selection || tr.effects.some(e => e.is(refreshBlocks)) ? buildBlocks(tr.state) : value;
  },
  provide: f => EditorView.decorations.from(f),
});

export const preview = [inlinePreview, blockPreview];
