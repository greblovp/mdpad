// Smart paste: rich HTML -> Markdown, images -> files next to the document, URL over a selection -> link.

import TurndownService from "turndown";
import {gfm} from "turndown-plugin-gfm";
import {EditorView} from "@codemirror/view";
import {native, post} from "./bridge.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
  hr: "---",
});
turndown.use(gfm);
turndown.escape = s => s; // backslash-escaping every "1." and "*" does more harm than good here
turndown.remove(["style", "script", "meta", "title", "head", "link"]);
// "- item" instead of turndown's "-   item"
turndown.addRule("listItem", {
  filter: "li",
  replacement(content, node, options) {
    const parent = node.parentNode;
    let prefix = options.bulletListMarker + " ";
    if (parent.nodeName === "OL") {
      const start = parent.getAttribute("start");
      prefix = (start ? Number(start) : 1) + Array.prototype.indexOf.call(parent.children, node) + ". ";
    }
    content = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n" + " ".repeat(prefix.length));
    return prefix + content + (node.nextSibling && !/\n$/.test(content) ? "\n" : "");
  },
});

function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Google Docs wraps the whole selection in <b style="font-weight:normal">
  doc.querySelectorAll('b[id^="docs-internal-guid"]').forEach(b => b.replaceWith(...b.childNodes));
  // ...and marks real bold/italic with inline styles on spans
  doc.querySelectorAll("span[style]").forEach(span => {
    const st = span.getAttribute("style");
    const bold = /font-weight:\s*(bold|[6-9]00)/i.test(st);
    const italic = /font-style:\s*italic/i.test(st);
    if (!bold && !italic) return;
    let el = span;
    if (italic) { const em = doc.createElement("em"); em.append(...el.childNodes); el.replaceWith(em); el = em; }
    if (bold) { const strong = doc.createElement("strong"); el.replaceWith(strong); strong.appendChild(el); }
  });
  return turndown.turndown(doc.body.innerHTML).replace(/\n{3,}/g, "\n\n").trim();
}

function isRichHTML(html) {
  if (/white-space:\s*pre/i.test(html)) return false; // code editors: keep their plain text
  return /<(h[1-6]|strong|b|em|i|a\s|ul|ol|table|pre|blockquote|img)\b/i.test(html) || /font-weight:\s*(bold|[6-9]00)/i.test(html);
}

function htmlHasText(html) {
  return new DOMParser().parseFromString(html, "text/html").body.textContent.trim().length > 0;
}

function imageFiles(dt) {
  const files = [...(dt.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) return files;
  return [...(dt.items || [])].filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter(Boolean);
}

function saveImages(files) {
  for (const file of files) {
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(",")[1] || "";
      post({type: "saveImage", data, name: file.name || "", mime: file.type});
    };
    reader.readAsDataURL(file);
  }
}

export const smartPaste = EditorView.domEventHandlers({
  paste(e, view) {
    const dt = e.clipboardData;
    if (!dt) return false;
    const html = dt.getData("text/html");
    const text = dt.getData("text/plain");

    const images = imageFiles(dt);
    if (images.length && native && !(html && htmlHasText(html))) {
      e.preventDefault();
      saveImages(images);
      return true;
    }

    const sel = view.state.selection.main;
    const url = text.trim();
    if (!sel.empty && /^https?:\/\/\S+$/.test(url) && !/\n/.test(view.state.sliceDoc(sel.from, sel.to))) {
      e.preventDefault();
      const label = view.state.sliceDoc(sel.from, sel.to);
      view.dispatch({changes: {from: sel.from, to: sel.to, insert: `[${label}](${url})`}, selection: {anchor: sel.from + label.length + url.length + 4}, userEvent: "input.paste"});
      return true;
    }

    if (html && isRichHTML(html)) {
      const md = htmlToMarkdown(html);
      if (md) {
        e.preventDefault();
        // multi-line blocks get their own paragraph instead of gluing onto the current line
        const line = view.state.doc.lineAt(sel.from), endLine = view.state.doc.lineAt(sel.to);
        const multi = md.includes("\n");
        const before = multi && line.text.slice(0, sel.from - line.from).trim() ? "\n\n" : "";
        const after = multi && endLine.text.slice(sel.to - endLine.from).trim() ? "\n\n" : "";
        view.dispatch(view.state.replaceSelection(before + md + after), {userEvent: "input.paste", scrollIntoView: true});
        return true;
      }
    }
    return false;
  },

  drop(e, view) {
    const dt = e.dataTransfer;
    if (!dt || !native) return false;
    const images = imageFiles(dt);
    if (!images.length) return false;
    e.preventDefault();
    const pos = view.posAtCoords({x: e.clientX, y: e.clientY});
    if (pos != null) view.dispatch({selection: {anchor: pos}});
    saveImages(images);
    return true;
  },
});

export {htmlToMarkdown, isRichHTML};
