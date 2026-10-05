// Mermaid is ~5 MB, so it is loaded only when a document actually contains a diagram.

import {WidgetType} from "@codemirror/view";

let loader = null;
let counter = 0;
const cache = new Map();

function load() {
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "mermaid.min.js";
      s.onload = () => {
        window.mermaid.initialize({startOnLoad: false, securityLevel: "strict"});
        resolve(window.mermaid);
      };
      s.onerror = () => { loader = null; reject(new Error("mermaid.min.js is missing")); };
      document.head.appendChild(s);
    });
  }
  return loader;
}

export async function renderMermaid(code, dark) {
  const key = (dark ? "d:" : "l:") + code;
  if (cache.has(key)) return cache.get(key);
  const m = await load();
  const id = "mmd" + ++counter;
  const theme = `%%{init: {"theme": "${dark ? "dark" : "default"}"}}%%\n`;
  try {
    const {svg} = await m.render(id, theme + code);
    cache.set(key, svg);
    return svg;
  } finally {
    // mermaid leaves its scratch element behind when a diagram fails to parse
    document.getElementById("d" + id)?.remove();
    document.getElementById(id)?.remove();
  }
}

export class MermaidWidget extends WidgetType {
  constructor(code, dark) { super(); this.code = code; this.dark = dark; }
  eq(o) { return o.code === this.code && o.dark === this.dark; }
  get estimatedHeight() { return 240; }

  toDOM(view) {
    const box = document.createElement("div");
    box.className = "cm-mermaid";
    const key = (this.dark ? "d:" : "l:") + this.code;
    if (cache.has(key)) box.innerHTML = cache.get(key);
    else {
      box.textContent = "Рисую диаграмму…";
      box.classList.add("cm-mermaid-pending");
      renderMermaid(this.code, this.dark).then(svg => {
        box.classList.remove("cm-mermaid-pending");
        box.innerHTML = svg;
        view.requestMeasure();
      }).catch(err => {
        box.classList.remove("cm-mermaid-pending");
        box.classList.add("cm-mermaid-error");
        box.textContent = "Mermaid: " + String(err && err.message || err).split("\n")[0];
        view.requestMeasure();
      });
    }
    box.addEventListener("mousedown", e => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const line = view.state.doc.lineAt(pos);
      view.focus();
      view.dispatch({selection: {anchor: Math.min(line.to + 1, view.state.doc.length)}});
    });
    return box;
  }

  ignoreEvent() { return true; }
}
