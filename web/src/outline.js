// Outline sidebar (headings) and the word-count status bar.

import {EditorView, ViewPlugin} from "@codemirror/view";
import {syntaxTree, ensureSyntaxTree} from "@codemirror/language";
import {frontmatterRange} from "./bridge.js";

function headings(state) {
  const out = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 150) || syntaxTree(state);
  const fm = frontmatterRange(state.doc);
  tree.iterate({enter: node => {
    if (fm && node.to <= fm.to) return false;
    const m = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
    if (!m) return;
    const line = state.doc.lineAt(node.from);
    const text = line.text
      .replace(/^\s*#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").trim();
    if (text) out.push({level: +m[1], text, pos: line.from});
    return false;
  }});
  return out;
}

const ruPlural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};
const countWords = s => (s.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || []).length;
const fmt = n => n.toLocaleString("ru-RU");

export function outlineAndStatus(outlineEl, statusEl) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.items = [];
      this.timer = 0;
      this.onScroll = () => this.markActive();
      view.scrollDOM.addEventListener("scroll", this.onScroll, {passive: true});
      // layout can't be read while the plugin is being constructed
      this.timer = setTimeout(() => this.rebuild(), 0);
    }

    update(u) {
      if (u.docChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.rebuild(), 250);
      } else if (u.selectionSet) this.status();
    }

    rebuild() {
      const view = this.view;
      this.items = headings(view.state);
      const min = Math.min(6, ...this.items.map(h => h.level));
      outlineEl.innerHTML = "";
      const title = document.createElement("div");
      title.className = "outline-title";
      title.textContent = "Оглавление";
      outlineEl.appendChild(title);
      if (!this.items.length) {
        const empty = document.createElement("div");
        empty.className = "outline-empty";
        empty.textContent = "Нет заголовков";
        outlineEl.appendChild(empty);
      }
      this.items.forEach(h => {
        const a = document.createElement("div");
        a.className = "outline-item outline-l" + (h.level - min + 1);
        a.textContent = h.text;
        a.title = h.text;
        a.addEventListener("mousedown", e => {
          e.preventDefault();
          view.dispatch({effects: EditorView.scrollIntoView(h.pos, {y: "start", yMargin: 16})});
        });
        h.el = a;
        outlineEl.appendChild(a);
      });
      this.markActive();
      this.status();
    }

    markActive() {
      if (!this.items.length) return;
      const top = this.view.lineBlockAtHeight(this.view.scrollDOM.scrollTop + 60).from;
      let cur = this.items[0];
      for (const h of this.items) { if (h.pos <= top) cur = h; else break; }
      if (cur === this.active) return;
      if (this.active && this.active.el) this.active.el.classList.remove("active");
      cur.el.classList.add("active");
      this.active = cur;
      const r = cur.el.getBoundingClientRect(), o = outlineEl.getBoundingClientRect();
      if (r.top < o.top + 30 || r.bottom > o.bottom) cur.el.scrollIntoView({block: "nearest"});
    }

    status() {
      const {state} = this.view;
      const words = countWords(state.doc.toString());
      const minutes = Math.max(1, Math.round(words / 180));
      let s = `${fmt(words)} ${ruPlural(words, "слово", "слова", "слов")} · ${minutes} мин`;
      const selected = state.selection.ranges.reduce((acc, r) => acc + (r.empty ? 0 : countWords(state.sliceDoc(r.from, r.to))), 0);
      if (selected) s = `выделено ${fmt(selected)} из ${s}`;
      statusEl.textContent = s;
    }

    destroy() {
      clearTimeout(this.timer);
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    }
  });
}
