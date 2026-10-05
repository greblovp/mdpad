// Messaging with the Swift side and things shared by several modules.

export const native = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.md;

export function post(msg) {
  if (native) native.postMessage(msg);
}

export const env = {baseDir: ""};

export function resolveSrc(src) {
  if (!src || /^(https?:|data:|file:|blob:)/i.test(src)) return src;
  let path = src;
  try { path = decodeURI(src); } catch (e) {}
  if (!path.startsWith("/")) path = (env.baseDir ? env.baseDir + "/" : "") + path;
  return "file://" + encodeURI(path);
}

export const isDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

// YAML front matter at the very top of the file: ---\n ... \n---
export function frontmatterRange(doc) {
  if (doc.lines < 2) return null;
  const first = doc.line(1);
  if (!/^---\s*$/.test(first.text)) return null;
  const max = Math.min(doc.lines, 400);
  for (let i = 2; i <= max; i++) {
    const l = doc.line(i);
    if (/^(---|\.\.\.)\s*$/.test(l.text)) return {from: 0, to: l.to, bodyFrom: first.to + 1, bodyTo: Math.max(first.to + 1, l.from - 1)};
  }
  return null;
}

// Obsidian callout types -> visual family + icon
const CALLOUTS = {
  note: ["blue", "ℹ"], info: ["blue", "ℹ"], todo: ["blue", "☐"],
  abstract: ["teal", "≣"], summary: ["teal", "≣"], tldr: ["teal", "≣"],
  tip: ["teal", "✦"], hint: ["teal", "✦"], important: ["teal", "✦"],
  success: ["green", "✓"], check: ["green", "✓"], done: ["green", "✓"],
  question: ["yellow", "?"], help: ["yellow", "?"], faq: ["yellow", "?"],
  warning: ["orange", "⚠"], caution: ["orange", "⚠"], attention: ["orange", "⚠"],
  failure: ["red", "✕"], fail: ["red", "✕"], missing: ["red", "✕"],
  danger: ["red", "⚡"], error: ["red", "⚡"], bug: ["red", "✕"],
  example: ["purple", "≡"], quote: ["gray", "❝"], cite: ["gray", "❝"],
};

export function calloutStyle(type) {
  const [color, icon] = CALLOUTS[type.toLowerCase()] || CALLOUTS.note;
  return {color, icon, label: type.charAt(0).toUpperCase() + type.slice(1).toLowerCase()};
}

export const CALLOUT_RE = /^(\s*>\s?)\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/;
