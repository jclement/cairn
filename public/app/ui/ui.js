// App shell behaviour (no framework, CSP-safe). Loaded in <head> without `defer` so the sidebar's
// collapsed state is on <html> before first paint; everything else waits for the DOM.
(() => {
  const KEY = "cairn-sidebar";
  try {
    if (localStorage.getItem(KEY) === "collapsed") document.documentElement.classList.add("sb-collapsed");
  } catch {
    /* storage blocked: the sidebar just starts open */
  }

  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());

  ready(() => {
    // Collapse / expand the desktop sidebar.
    for (const b of document.querySelectorAll("[data-sidebar-toggle]")) {
      b.addEventListener("click", () => {
        const on = document.documentElement.classList.toggle("sb-collapsed");
        try {
          localStorage.setItem(KEY, on ? "collapsed" : "open");
        } catch {
          /* not remembered */
        }
      });
    }

    // <details data-menu> dropdowns: one open at a time, close on outside click or Escape.
    const menus = [...document.querySelectorAll("details[data-menu]")];
    for (const m of menus) {
      m.addEventListener("toggle", () => {
        if (m.open) for (const o of menus) if (o !== m) o.open = false;
      });
    }
    document.addEventListener("click", (e) => {
      for (const m of menus) if (m.open && !m.contains(e.target)) m.open = false;
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      for (const m of menus) {
        if (m.open) {
          m.open = false;
          m.querySelector("summary")?.focus();
        }
      }
    });

    // On phones the settings sections are a scrolling strip: bring the current one into view.
    const strip = document.querySelector('nav[aria-label="Settings sections"]');
    const cur = strip?.querySelector('[aria-current="page"]');
    if (strip && cur && strip.scrollWidth > strip.clientWidth) {
      strip.scrollLeft = cur.offsetLeft - (strip.clientWidth - cur.offsetWidth) / 2;
    }

    // The ⌘K hint in the search box opens the command palette (src/client/app.ts).
    for (const b of document.querySelectorAll("[data-palette]")) {
      b.addEventListener("click", () => window.cairnPalette?.());
    }

    // In-page tabs: links with data-tab="<panel>" switch the [data-panel] sections. Without JS
    // every panel shows, one after another.
    const panels = [...document.querySelectorAll("[data-panel]")];
    if (panels.length) {
      const tabs = [...document.querySelectorAll("a[data-tab]")];
      const show = () => {
        const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
        const panel = target?.closest("[data-panel]") ?? panels[0];
        const name = panel.getAttribute("data-panel");
        for (const p of panels) p.hidden = p !== panel;
        for (const t of tabs) {
          if (t.getAttribute("data-tab") === name) t.setAttribute("aria-current", "page");
          else t.removeAttribute("aria-current");
        }
        if (target && target !== panel) target.scrollIntoView({ block: "start" });
      };
      window.addEventListener("hashchange", show);
      show();
    }

    // Copy / download the text of an element: data-copy-from="id", data-download-from="id".
    for (const b of document.querySelectorAll("[data-copy-from]")) {
      if (!navigator.clipboard) continue;
      b.hidden = false;
      b.addEventListener("click", async () => {
        const el = document.getElementById(b.getAttribute("data-copy-from"));
        const label = b.textContent;
        try {
          await navigator.clipboard.writeText(el.textContent.trim());
          b.textContent = "Copied";
        } catch {
          b.textContent = "Copy failed";
        }
        setTimeout(() => {
          b.textContent = label;
        }, 1600);
      });
    }
    for (const b of document.querySelectorAll("[data-download-from]")) {
      b.hidden = false;
      b.addEventListener("click", () => {
        const el = document.getElementById(b.getAttribute("data-download-from"));
        const head = b.getAttribute("data-download-head") || "";
        const blob = new Blob([`${head}${el.textContent.trim()}\n`], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = b.getAttribute("data-filename") || "cairn.txt";
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
    }
  });
})();
