import { AsyncLocalStorage } from "node:async_hooks";

// Transport-only updates: never become a requirement, plan or audit approval.
export const progressContext = new AsyncLocalStorage();

export function reportProgress(message, preview = "", stage = "working") {
  progressContext.getStore()?.({ message, preview, stage });
}

export function publicPreview(text) {
  const sections = [];
  // Only user-facing structured fields; never thinking blocks, tools or raw JSON.
  const fields = /(?<!\\)"(reply|summary|approach)"\s*:\s*"/g;
  for (const match of text.matchAll(fields)) {
    let value = "";
    for (let i = match.index + match[0].length; i < text.length && value.length < 4000; i++) {
      if (text[i] === '"') break;
      if (text[i] !== "\\") { value += text[i]; continue; }
      const escape = text[++i];
      if (escape === undefined) break;
      if (escape === "u") {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[a-fA-F0-9]{4}$/.test(hex)) break;
        value += String.fromCharCode(parseInt(hex, 16)); i += 4;
      } else {
        const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!Object.hasOwn(escapes, escape)) break;
        value += escapes[escape];
      }
    }
    if (value.trim()) sections.push(value);
    if (sections.join("\n\n").length >= 4000) break;
  }
  return sections.join("\n\n").slice(0, 4000);
}
