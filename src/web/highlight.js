// Code highlighting for rendered notes (server and editor preview). Plain JS with a hand-written
// highlight.d.ts on purpose: highlight.js's own typings carry `/// <reference lib="dom" />`,
// which would pull DOM globals into the Worker typecheck.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS = { bash, css, diff, go, ini, java, javascript, json, markdown, python, ruby, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);
hljs.registerAliases(["sh", "shell", "zsh", "console"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx", "mjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["html", "svg"], { languageName: "xml" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["rs"], { languageName: "rust" });

/** Highlighted, HTML-escaped code, or "" when the language is unknown (caller escapes). */
export function highlightCode(code, lang) {
  const l = (lang || "").trim().toLowerCase();
  if (!l || !hljs.getLanguage(l)) return "";
  try {
    return hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  } catch {
    return "";
  }
}
