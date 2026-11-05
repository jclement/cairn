// /app/search: search as you type against /app/api/search, keyboard navigation over results.
// The page works without this (it is a plain GET form with server-rendered results).

import type { ApiHit, ApiSearch } from "../web/viewer/shared";
import { highlight, queryTerms } from "../web/viewer/shared";
import { h } from "./lib";

const form = document.getElementById("search-form") as HTMLFormElement | null;
const qInput = document.getElementById("search-q") as HTMLInputElement | null;
const results = document.getElementById("results");
const count = document.getElementById("search-count");

if (form && qInput && results && count) {
  let ctrl: AbortController | null = null;
  let timer = 0;
  let active = -1;
  let lastKey = "";

  const params = () => {
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === "string" && v) p.set(k, v);
    return p;
  };

  const options = () => [...results.querySelectorAll<HTMLLIElement>("li.hit")];

  const setActive = (i: number) => {
    const opts = options();
    if (!opts.length) {
      active = -1;
      qInput.removeAttribute("aria-activedescendant");
      return;
    }
    active = (i + opts.length) % opts.length;
    opts.forEach((li, j) => {
      li.setAttribute("aria-selected", j === active ? "true" : "false");
      li.classList.toggle("active", j === active);
    });
    qInput.setAttribute("aria-activedescendant", opts[active].id);
    opts[active].scrollIntoView({ block: "nearest" });
  };

  const decorate = () => {
    options().forEach((li, i) => {
      li.id = `hit-${i}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
    });
    active = -1;
  };

  const hitEl = (hit: ApiHit, terms: string[]) => {
    const li = h("li", { class: `hit${hit.strong ? "" : " weak"}`, "data-href": hit.href });
    const a = h("a", { class: "hit-title", href: hit.href });
    a.innerHTML = highlight(hit.title, terms); // highlight() escapes
    li.append(
      a,
      " ",
      h("span", { class: "muted small" }, `${hit.permalink} · ${hit.type}${hit.updated_at ? ` · ${hit.updated_at.replace("T", " ").slice(0, 16)}` : ""}`),
    );
    for (const m of hit.matches) {
      const d = h("div", { class: "hit-line small" }, h("span", { class: "faint" }, `L${m.line}`), " ");
      d.insertAdjacentHTML("beforeend", highlight(m.text, terms));
      li.append(d);
    }
    for (const o of hit.observations) {
      const d = h("div", { class: "hit-line small" }, h("span", { class: "obs-cat" }, `[${o.category}]`), " ");
      d.insertAdjacentHTML("beforeend", highlight(o.content, terms));
      li.append(d);
    }
    if (hit.tags.length) li.append(h("div", { class: "small" }, ...hit.tags.flatMap((t) => [h("span", { class: "tag" }, t), " "])));
    return li;
  };

  const render = (res: ApiSearch, p: URLSearchParams) => {
    const terms = queryTerms(res.q);
    const filtered = ["type", "tag", "folder", "since"].some((k) => p.get(k));
    count.textContent =
      res.q || res.total ? `${res.total} result${res.total === 1 ? "" : "s"}${res.modes_used.length ? ` · ${res.modes_used.join(" + ")}` : ""}` : "";
    if (res.error) {
      results.replaceChildren(h("p", { class: "error" }, res.error));
    } else if (!res.q && !filtered) {
      results.replaceChildren(
        h("p", { class: "muted", "data-state": "idle" }, `Type to search ${res.project}: titles, text and observations, by keyword and by meaning.`),
      );
    } else if (!res.hits.length) {
      const newHref = `/app/new?project=${encodeURIComponent(res.project)}${res.q ? `&title=${encodeURIComponent(res.q)}` : ""}`;
      results.replaceChildren(
        h(
          "p",
          { class: "muted", "data-state": "empty" },
          `No matches${res.q ? ` for “${res.q}”` : ""}${filtered ? " with these filters" : ""}. `,
          h("a", { href: newHref }, "Create a note"),
          "?",
        ),
      );
    } else {
      const ol = h("ol", { class: "plain hits", id: "hits", role: "listbox", "aria-label": "Results" }, ...res.hits.map((x) => hitEl(x, terms)));
      results.replaceChildren(
        ...(res.strong
          ? []
          : [h("p", { class: "card warn small", "data-state": "weak" }, "No strong match. These notes are only loosely related (by meaning).")]),
        ol,
      );
    }
    decorate();
  };

  const run = async () => {
    const p = params();
    const key = p.toString();
    if (key === lastKey) return;
    lastKey = key;
    history.replaceState(null, "", `/app/search?${key}`);
    ctrl?.abort();
    ctrl = new AbortController();
    form.setAttribute("aria-busy", "true");
    try {
      const r = await fetch(`/app/api/search?${key}`, { signal: ctrl.signal, credentials: "same-origin" });
      const j = (await r.json()) as Partial<ApiSearch>;
      const empty: ApiSearch = { project: p.get("project") ?? "", q: p.get("q") ?? "", total: 0, has_more: false, modes_used: [], strong: false, hits: [] };
      render(Object.assign(empty, j), p);
    } catch (e) {
      if ((e as Error).name !== "AbortError") count.textContent = "Search failed. Press Enter to retry.";
    } finally {
      form.removeAttribute("aria-busy");
    }
  };

  lastKey = params().toString();
  decorate();
  qInput.setAttribute("role", "combobox");
  qInput.setAttribute("aria-expanded", "true");
  qInput.setAttribute("aria-autocomplete", "list");
  // Put the caret at the end of a prefilled query.
  qInput.setSelectionRange(qInput.value.length, qInput.value.length);

  qInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 140);
  });
  for (const sel of form.querySelectorAll("select")) {
    sel.addEventListener("change", () => {
      // Another project has other types/tags/folders: reload the page for fresh filter options.
      if (sel.name === "project") {
        for (const n of ["type", "tag", "folder"]) {
          const s = form.querySelector<HTMLSelectElement>(`select[name="${n}"]`);
          if (s) s.value = "";
        }
        form.submit();
        return;
      }
      void run();
    });
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (active >= 0) {
      const href = options()[active]?.dataset.href;
      if (href) window.location.href = href;
      return;
    }
    lastKey = "";
    void run();
  });
  qInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "Escape") {
      qInput.removeAttribute("aria-activedescendant");
      options().forEach((li) => {
        li.classList.remove("active");
        li.setAttribute("aria-selected", "false");
      });
      active = -1;
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const href = options()[active]?.dataset.href;
      if (href) window.location.href = href;
    }
  });
}
