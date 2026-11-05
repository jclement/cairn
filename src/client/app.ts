// Loaded on every signed-in /app page: the Ctrl/Cmd-K command palette (jump to a note, search,
// new note, graph) and small progressive enhancements. An ARIA combobox over a listbox.

import { currentProject, fuzzyScore, h, loadTitles, type TitleEntry } from "./lib";

interface Item {
  id: string;
  label: string;
  hint: string;
  href: string;
}

let dialog: HTMLDialogElement | null = null;
let input: HTMLInputElement;
let list: HTMLUListElement;
let items: Item[] = [];
let active = 0;
let titles: TitleEntry[] = [];

function project(): string {
  return currentProject();
}

function build(): HTMLDialogElement {
  input = h("input", {
    type: "text",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "palette-list",
    "aria-autocomplete": "list",
    "aria-label": "Jump to a note or search",
    placeholder: "Jump to a note, or search…",
    autocomplete: "off",
    spellcheck: "false",
  });
  list = h("ul", { id: "palette-list", role: "listbox", "aria-label": "Notes and actions", class: "palette-list" });
  const d = h(
    "dialog",
    { class: "palette", "aria-label": "Command palette" },
    input,
    list,
    h("p", { class: "palette-help muted small" }, "↑↓ to move · Enter to open · Esc to close"),
  );
  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  input.addEventListener("keydown", onKey);
  list.addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>("li[data-i]");
    if (li) go(Number(li.dataset.i));
  });
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close(); // backdrop
  });
  document.body.append(d);
  return d;
}

function compute(q: string): Item[] {
  const p = project();
  const qs = q.trim();
  const pq = p ? `project=${encodeURIComponent(p)}&` : "";
  const notes = qs
    ? titles
        .map((t) => ({ t, s: Math.max(fuzzyScore(t.title, qs), fuzzyScore(t.permalink, qs) - 50) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 8)
        .map((x) => x.t)
    : titles.slice(0, 0);
  const out: Item[] = notes.map((t, i) => ({ id: `pal-${i}`, label: t.title, hint: t.folder ? `${t.folder} · ${t.type}` : t.type, href: t.href }));
  if (qs) {
    out.push({ id: "pal-search", label: `Search for “${qs}”`, hint: "full-text + meaning", href: `/app/search?${pq}q=${encodeURIComponent(qs)}` });
    out.push({ id: "pal-new", label: `New note “${qs}”`, hint: "create", href: `/app/new?${pq}title=${encodeURIComponent(qs)}` });
  } else {
    out.push({ id: "pal-search", label: "Search", hint: "open the search page", href: `/app/search${p ? `?project=${encodeURIComponent(p)}` : ""}` });
    out.push({ id: "pal-new", label: "New note", hint: "create", href: `/app/new${p ? `?project=${encodeURIComponent(p)}` : ""}` });
  }
  out.push({ id: "pal-graph", label: "Graph view", hint: p || "default project", href: `/app/graph${p ? `?project=${encodeURIComponent(p)}` : ""}` });
  out.push({ id: "pal-home", label: "Home", hint: "", href: "/app" });
  return out;
}

function render() {
  items = compute(input.value);
  if (active >= items.length) active = items.length - 1;
  list.replaceChildren(
    ...items.map((it, i) =>
      h(
        "li",
        { id: it.id, role: "option", "aria-selected": i === active ? "true" : "false", "data-i": i, class: i === active ? "active" : "" },
        h("span", { class: "palette-label" }, it.label),
        it.hint ? h("span", { class: "palette-hint muted small" }, it.hint) : null,
      ),
    ),
  );
  input.setAttribute("aria-activedescendant", items[active]?.id ?? "");
  list.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
}

function go(i: number) {
  const it = items[i];
  if (it) window.location.href = it.href;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
    e.preventDefault();
    active = (active + 1) % items.length;
    render();
  } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
    e.preventDefault();
    active = (active - 1 + items.length) % items.length;
    render();
  } else if (e.key === "Enter") {
    e.preventDefault();
    go(active);
  }
}

async function open() {
  if (!dialog) dialog = build();
  if (dialog.open) {
    input.select();
    return;
  }
  const header = document.querySelector<HTMLInputElement>('header form.search input[name="q"]');
  input.value = header && document.activeElement === header ? header.value : "";
  active = 0;
  render();
  dialog.showModal();
  input.focus();
  titles = await loadTitles(project());
  render();
}

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    void open();
  }
});

// Selects marked data-autosubmit submit their form on change (with a <noscript> button fallback).
for (const sel of document.querySelectorAll<HTMLSelectElement>("select[data-autosubmit]")) {
  sel.addEventListener("change", () => sel.form?.requestSubmit());
}

// Click an image in a note to see it full size.
const zoom = document.getElementById("img-zoom") as HTMLDialogElement | null;
if (zoom) {
  const big = zoom.querySelector("img") as HTMLImageElement;
  document.addEventListener("click", (e) => {
    const img = (e.target as HTMLElement).closest<HTMLImageElement>(".note-body img");
    if (!img || img.closest("a")) return;
    big.src = img.currentSrc || img.src;
    big.alt = img.alt;
    zoom.showModal();
  });
  zoom.addEventListener("click", (e) => {
    if (e.target === zoom || e.target === big) zoom.close();
  });
}

// "Close window" on the clipper's saved page (it runs in a popup opened by the bookmarklet).
for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-close-window]")) {
  b.addEventListener("click", () => window.close());
}

// Exposed for the header's palette hint (and tests).
(window as unknown as { cairnPalette?: () => void }).cairnPalette = () => void open();
