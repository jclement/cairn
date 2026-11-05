// Renders ```mermaid fences (server-rendered as <pre class="mermaid-src">) into diagrams.
// Loaded only on note pages that contain one. Mermaid itself is the prebuilt ESM copied to
// /app/dist/mermaid/ by the build (lazy chunks per diagram type), imported at runtime.
//
// CSP: script-src 'self' is satisfied (same-origin modules). style-src 'self' blocks the <style>
// element mermaid embeds in each SVG, so its rules are moved into a constructable stylesheet
// (document.adoptedStyleSheets), which the CSP does not govern. securityLevel "strict" disables
// click directives and HTML labels.

interface Mermaid {
  initialize(cfg: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

const blocks = [...document.querySelectorAll<HTMLElement>("figure.mermaid-block")];
const MERMAID_URL = "/app/dist/mermaid/mermaid.esm.min.mjs";

if (blocks.length) void run();

async function run() {
  let mermaid: Mermaid;
  try {
    mermaid = ((await import(/* webpackIgnore: true */ MERMAID_URL)) as { default: Mermaid }).default;
  } catch {
    return; // source stays visible
  }
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  let gen = 0;

  const renderAll = async () => {
    const my = ++gen;
    const isDark = document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && dark.matches);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDark ? "dark" : "neutral",
      fontFamily: "inherit",
      // SVG <text> labels: HTML labels need <foreignObject>, which is stripped below.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    const css: string[] = [];
    for (const [i, fig] of blocks.entries()) {
      const src = fig.querySelector("pre.mermaid-src");
      if (!src) continue;
      const id = `mermaid-${i}-${my}`;
      try {
        const { svg } = await mermaid.render(id, src.textContent ?? "");
        if (my !== gen) return;
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        const root = doc.documentElement;
        if (root.nodeName !== "svg") throw new Error("not svg");
        for (const st of root.querySelectorAll("style")) {
          css.push(st.textContent ?? "");
          st.remove();
        }
        // strict mode output is sanitised by mermaid (DOMPurify); belt and braces:
        for (const el of root.querySelectorAll("script, foreignObject, iframe")) el.remove();
        for (const el of root.querySelectorAll("*")) {
          for (const a of [...el.attributes]) {
            if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
          }
        }
        root.removeAttribute("style");
        root.setAttribute("role", "img");
        root.setAttribute("aria-label", "Diagram");
        let out = fig.querySelector<HTMLElement>(".mermaid-svg");
        if (!out) {
          out = document.createElement("div");
          out.className = "mermaid-svg";
          fig.prepend(out);
        }
        out.replaceChildren(document.importNode(root, true));
        fig.classList.add("rendered");
      } catch {
        fig.classList.add("failed");
        document.getElementById(`d${id}`)?.remove();
      }
    }
    sheet.replaceSync(css.join("\n"));
  };

  await renderAll();
  dark.addEventListener("change", () => void renderAll());
}
