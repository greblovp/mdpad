// Markdown -> HTML for "Copy as Rich Text" and PDF export / printing.

import {Marked} from "marked";
import {Text} from "@codemirror/state";
import {resolveSrc, frontmatterRange, calloutStyle} from "./bridge.js";
import {renderMermaid} from "./mermaid.js";

const marked = new Marked({gfm: true, breaks: false});

const CALLOUT_COLORS = {
  blue: "#0969da", teal: "#0a8f86", green: "#1a7f37", yellow: "#b08800",
  orange: "#d4730b", red: "#cf222e", purple: "#8250df", gray: "#6e7781",
};

function prepareSource(md) {
  const fm = frontmatterRange(Text.of(md.split("\n")));
  if (fm) md = md.slice(fm.to + 1);
  // wiki links become plain text: [[Note|alias]] -> alias, [[Note]] -> Note
  return md.replace(/!?\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2").replace(/!?\[\[([^\]\n]+)\]\]/g, "$1");
}

function transformCallouts(root) {
  root.querySelectorAll("blockquote").forEach(bq => {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== "P") return;
    const m = /^\[!([\w-]+)\][+-]?[ \t]*([^\n]*)(\n|$)/.exec(p.innerHTML);
    if (!m) return;
    const {color, icon, label} = calloutStyle(m[1]);
    const div = document.createElement("div");
    div.className = "callout";
    div.dataset.color = color;
    const title = document.createElement("div");
    title.className = "callout-title";
    title.innerHTML = `${icon} ${m[2] || label}`;
    div.appendChild(title);
    const rest = p.innerHTML.slice(m[0].length).trim();
    if (rest) { const np = document.createElement("p"); np.innerHTML = rest; div.appendChild(np); }
    [...bq.children].slice(1).forEach(c => div.appendChild(c));
    bq.replaceWith(div);
  });
}

export async function renderHTML(md, mode) {
  const tpl = document.createElement("template");
  tpl.innerHTML = marked.parse(prepareSource(md));
  const root = tpl.content;
  root.querySelectorAll("img").forEach(img => img.setAttribute("src", resolveSrc(img.getAttribute("src"))));
  transformCallouts(root);

  if (mode === "print") {
    for (const code of root.querySelectorAll("pre > code.language-mermaid")) {
      const fig = document.createElement("div");
      fig.className = "mermaid-figure";
      try { fig.innerHTML = await renderMermaid(code.textContent, false); }
      catch (e) { fig.textContent = "Mermaid: " + String(e.message || e).split("\n")[0]; }
      code.parentElement.replaceWith(fig);
    }
  }

  if (mode === "clipboard") {
    // mail clients ignore <style>, so everything that matters goes inline
    const style = (sel, css) => root.querySelectorAll(sel).forEach(el => el.setAttribute("style", css + (el.getAttribute("style") || "")));
    style("table", "border-collapse:collapse;");
    style("th", "border:1px solid #c8ccd0;padding:4px 10px;background:#f3f4f6;text-align:left;");
    style("td", "border:1px solid #c8ccd0;padding:4px 10px;vertical-align:top;");
    style("pre", "background:#f4f5f7;padding:8px 12px;border-radius:4px;");
    style("code", "font-family:Menlo,Consolas,monospace;font-size:90%;");
    style("blockquote", "border-left:3px solid #d0d7de;margin-left:0;padding-left:12px;color:#57606a;");
    root.querySelectorAll(".callout").forEach(c => {
      const col = CALLOUT_COLORS[c.dataset.color] || CALLOUT_COLORS.blue;
      c.setAttribute("style", `border-left:3px solid ${col};padding:6px 12px;margin:8px 0;`);
      c.querySelector(".callout-title").setAttribute("style", `font-weight:bold;color:${col};`);
    });
  }

  const out = document.createElement("div");
  out.appendChild(root.cloneNode(true));
  return out.innerHTML;
}

const PRINT_CSS = `
@page { margin: 16mm 18mm; }
html { -webkit-print-color-adjust: exact; }
body { font: 11pt/1.55 -apple-system, "Helvetica Neue", sans-serif; color: #1f2328; margin: 0; padding: 0; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.2em 0 0.4em; page-break-after: avoid; }
h1 { font-size: 22pt; margin-top: 0; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4 { font-size: 11.5pt; }
p, ul, ol { margin: 0 0 0.7em; }
li { margin: 0.15em 0; }
a { color: #0969da; text-decoration: none; }
code { font: 9.5pt "SF Mono", Menlo, monospace; background: #f1f2f4; padding: 0.1em 0.3em; border-radius: 3px; }
pre { background: #f4f5f7; padding: 10px 14px; border-radius: 6px; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #d0d7de; margin: 0 0 0.8em; padding: 0 0 0 14px; color: #57606a; }
table { border-collapse: collapse; margin: 0.4em 0 1em; font-size: 10pt; width: 100%; }
th, td { border: 1px solid #d0d7de; padding: 5px 9px; vertical-align: top; text-align: left; }
th { background: #f3f4f6; }
tr { page-break-inside: avoid; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.4em 0; }
img { max-width: 100%; }
li:has(> input[type=checkbox]) { list-style: none; position: relative; }
li > input[type=checkbox] { position: absolute; left: -1.4em; top: 0.35em; margin: 0; }
.callout { border-left: 3px solid var(--c); background: color-mix(in srgb, var(--c) 8%, white); padding: 8px 14px; margin: 0 0 0.9em; border-radius: 4px; page-break-inside: avoid; }
.callout-title { font-weight: 600; color: var(--c); margin-bottom: 0.2em; }
.callout p:last-child { margin-bottom: 0; }
.callout[data-color=blue] { --c: #0969da; } .callout[data-color=teal] { --c: #0a8f86; } .callout[data-color=green] { --c: #1a7f37; }
.callout[data-color=yellow] { --c: #b08800; } .callout[data-color=orange] { --c: #d4730b; } .callout[data-color=red] { --c: #cf222e; }
.callout[data-color=purple] { --c: #8250df; } .callout[data-color=gray] { --c: #6e7781; }
.mermaid-figure { text-align: center; margin: 0.6em 0 1em; page-break-inside: avoid; }
.mermaid-figure svg { max-width: 100%; height: auto; }
`;

export async function exportDocument(md, title) {
  const body = await renderHTML(md, "print");
  const esc = s => s.replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title || "")}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
}
