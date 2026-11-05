// The note editor: CodeMirror 6 over the page's <textarea> (which still works without JS),
// [[ title completion, observation/relation hints, live preview, Ctrl/Cmd-S, conflict dialog.

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { renderMarkdown } from "../web/render";
import { OBS_CATEGORIES, RELATION_TYPES } from "../web/viewer/shared";
import { loadTitles, type TitleEntry } from "./lib";

const form = document.getElementById("editor-form") as HTMLFormElement | null;
const textarea = document.getElementById("editor-text") as HTMLTextAreaElement | null;

if (form && textarea) void init(form, textarea);

async function init(form: HTMLFormElement, textarea: HTMLTextAreaElement) {
  const project = form.dataset.project ?? "";
  const permalink = form.dataset.permalink ?? "";
  const status = document.getElementById("editor-status") as HTMLElement;
  const preview = document.getElementById("editor-preview") as HTMLElement;
  const panes = document.getElementById("editor-panes") as HTMLElement;
  const toggle = document.getElementById("editor-toggle") as HTMLButtonElement;
  const saveBtn = document.getElementById("editor-save") as HTMLButtonElement;
  const checksumInput = form.querySelector<HTMLInputElement>('input[name="expected_checksum"]') as HTMLInputElement;
  const titleInput = form.querySelector<HTMLInputElement>('input[name="title"]') as HTMLInputElement;
  const folderInput = form.querySelector<HTMLInputElement>('input[name="folder"]') as HTMLInputElement;
  const dialog = document.getElementById("conflict-dialog") as HTMLDialogElement;

  let titles: TitleEntry[] = [];
  let byTitle = new Map<string, string>();
  let saved = textarea.value;
  let savedMeta = `${titleInput.value}\u0000${folderInput.value}`;
  let saving = false;

  const links = new Proxy({} as Record<string, string | null>, { get: (_o, k) => byTitle.get(String(k).trim().toLowerCase()) ?? null });

  // ---- completion ----
  const wikiSource = (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[[^\]\n|]*/);
    if (!m) return null;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const options: Completion[] = titles.map((n) => ({
      label: n.title,
      detail: n.folder || undefined,
      type: "text",
      apply: after === "]]" ? n.title : `${n.title}]]`,
    }));
    return { from: m.from + 2, options, validFor: /^[^\]\n|]*$/ };
  };
  const lineHintSource = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const cat = /^(\s*[-*] \[)([\w-]*)$/.exec(before);
    if (cat) {
      return {
        from: ctx.pos - cat[2].length,
        options: OBS_CATEGORIES.map((c) => ({ label: c, type: "keyword", detail: "observation", apply: `${c}] ` })),
        validFor: /^[\w-]*$/,
      };
    }
    const rel = /^(\s*[-*] )([a-z_]+)$/.exec(before);
    if (rel && (ctx.explicit || rel[2].length >= 2)) {
      return {
        from: ctx.pos - rel[2].length,
        options: RELATION_TYPES.map((r) => ({ label: r, type: "property", detail: "relation", apply: `${r} [[` })),
        validFor: /^[a-z_]*$/,
      };
    }
    return null;
  };

  const highlight = HighlightStyle.define([
    { tag: t.heading1, fontWeight: "700", fontSize: "1.25em", color: "var(--owg-text-strong)" },
    { tag: [t.heading2, t.heading3, t.heading4], fontWeight: "700", color: "var(--owg-text-strong)" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: "var(--owg-accent)" },
    { tag: [t.monospace], color: "var(--owg-purple)" },
    { tag: [t.quote], color: "var(--owg-muted)", fontStyle: "italic" },
    { tag: [t.list], color: "var(--owg-amber)" },
    { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--owg-muted)" },
    { tag: [t.labelName, t.squareBracket], color: "var(--owg-cyan)" },
  ]);

  const theme = EditorView.theme({
    "&": { backgroundColor: "var(--owg-surface)", color: "var(--owg-text)", border: "1px solid var(--owg-border)", borderRadius: "var(--owg-radius, 6px)" },
    "&.cm-focused": { outline: "var(--owg-focus-width, 2px) solid var(--owg-focus, var(--owg-accent))", outlineOffset: "1px" },
    ".cm-content": { fontFamily: "var(--owg-font-mono, ui-monospace, monospace)", fontSize: "0.9rem", caretColor: "var(--owg-accent)", padding: "0.75rem 0" },
    ".cm-line": { padding: "0 0.75rem" },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--owg-accent) 6%, transparent)" },
    ".cm-cursor": { borderLeftColor: "var(--owg-accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in srgb, var(--owg-accent) 28%, transparent) !important",
    },
    ".cm-tooltip": { backgroundColor: "var(--owg-surface-2)", border: "1px solid var(--owg-border-strong)", color: "var(--owg-text)" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--owg-accent)", color: "var(--owg-accent-ink)" },
    ".cm-completionDetail": { color: "var(--owg-muted)", marginLeft: "0.75em" },
    ".cm-placeholder": { color: "var(--owg-faint)" },
    ".cm-scroller": { minHeight: "50vh", maxHeight: "75vh" },
  });

  // ---- preview ----
  let previewTimer = 0;
  const renderPreview = () => {
    if (preview.hidden && !wide()) return;
    preview.innerHTML = renderMarkdown(view.state.doc.toString(), { vault: project, links }); // inert renderer: raw HTML escaped
  };
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, 120);
  };

  const dirty = () => view.state.doc.toString() !== saved || `${titleInput.value}\u0000${folderInput.value}` !== savedMeta;
  const showDirty = () => {
    if (!saving) status.textContent = dirty() ? "Unsaved changes" : status.dataset.saved || "";
  };

  // CodeMirror's style-mod injects a <style> element into a document, which the CSP (style-src
  // 'self') blocks; inside a shadow root it uses a constructable stylesheet instead. owg's CSS
  // custom properties inherit through the shadow boundary, so the theme still follows owg.
  const host = document.createElement("div");
  host.className = "editor-host";
  const shadow = host.attachShadow({ mode: "open" });
  const view = new EditorView({
    root: shadow,
    parent: shadow,
    state: EditorState.create({
      doc: textarea.value,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        EditorView.lineWrapping,
        new LanguageSupport(markdownLanguage), // not markdown(): that pulls in the HTML/JS/CSS parsers for embedded blocks
        syntaxHighlighting(highlight),
        autocompletion({ override: [wikiSource, lineHintSource], activateOnTyping: true, icons: false }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void save(false);
              return true;
            },
          },
          ...markdownKeymap,
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        placeholder("Write markdown. [[ links a note; - [fact] adds an observation."),
        EditorView.contentAttributes.of({ "aria-label": "Note markdown", "aria-multiline": "true" }),
        EditorView.domEventHandlers({
          drop: (e, v) => {
            const files = [...(e.dataTransfer?.files ?? [])];
            if (!files.length) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head;
            void uploadFiles(files, pos);
            return true;
          },
          paste: (e, v) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length) return false;
            e.preventDefault();
            void uploadFiles(files, v.state.selection.main.head);
            return true;
          },
        }),
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            schedulePreview();
            showDirty();
          }
        }),
      ],
    }),
  });
  textarea.hidden = true;
  textarea.after(host);
  for (const i of [titleInput, folderInput]) i.addEventListener("input", showDirty);

  // ---- layout: side by side when wide, a toggle on phones ----
  const mq = window.matchMedia("(min-width: 960px)");
  const wide = () => mq.matches;
  const applyLayout = () => {
    panes.classList.toggle("split", wide());
    toggle.hidden = wide();
    if (wide()) {
      preview.hidden = false;
      host.hidden = false;
      renderPreview();
    } else {
      const showPreview = toggle.getAttribute("aria-pressed") === "true";
      preview.hidden = !showPreview;
      host.hidden = showPreview;
      if (showPreview) renderPreview();
    }
  };
  toggle.addEventListener("click", () => {
    const on = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = on ? "Edit" : "Preview";
    applyLayout();
    if (!on) view.focus();
  });
  mq.addEventListener("change", applyLayout);
  applyLayout();

  // ---- save ----
  async function save(overwrite: boolean): Promise<void> {
    if (saving) return;
    const content = view.state.doc.toString();
    if (!permalink && !titleInput.value.trim()) {
      status.textContent = "Give the note a title first.";
      titleInput.focus();
      return;
    }
    saving = true;
    saveBtn.disabled = true;
    status.textContent = "Saving…";
    try {
      const r = await fetch("/app/api/notes", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          permalink: permalink || undefined,
          title: titleInput.value,
          folder: folderInput.value,
          content,
          expected_checksum: checksumInput.value,
        }),
      });
      const j = (await r.json()) as {
        error?: string;
        code?: string;
        href?: string;
        content?: string | null;
        note?: { checksum: string; title: string; updated_at: string };
        unresolved?: string[];
        current?: { content: string; checksum: string; updated_by_client: string | null } | null;
      };
      if (r.status === 409 && j.code === "REVISION_CONFLICT" && j.current) {
        saving = false;
        conflict(j.current);
        return;
      }
      if (!r.ok || !j.note) {
        status.textContent = j.error ?? `Save failed (${r.status}).`;
        return;
      }
      saved = content;
      savedMeta = `${titleInput.value}\u0000${folderInput.value}`;
      if (!permalink) {
        window.removeEventListener("beforeunload", onUnload);
        window.location.href = j.href ?? "/app";
        return;
      }
      checksumInput.value = j.note.checksum;
      // Adopt the stored text (frontmatter is normalised on write) if nothing was typed meanwhile.
      if (typeof j.content === "string" && j.content !== content && view.state.doc.toString() === content) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: j.content } });
        saved = j.content;
      }
      const unresolved = j.unresolved?.length ? ` · unresolved: ${j.unresolved.slice(0, 5).join(", ")}` : "";
      status.dataset.saved = `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${unresolved}${overwrite ? " (overwrote the other version)" : ""}`;
      status.textContent = status.dataset.saved;
    } catch {
      status.textContent = "Save failed: network error. Your text is still here.";
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  }

  function conflict(current: { content: string; checksum: string; updated_by_client: string | null }) {
    status.textContent = "Conflict: this note changed elsewhere.";
    (document.getElementById("conflict-theirs") as HTMLElement).textContent = current.content;
    (document.getElementById("conflict-who") as HTMLElement).textContent = current.updated_by_client ?? "another client";
    const onClick = (e: Event) => {
      const choice = (e.target as HTMLElement).closest<HTMLElement>("[data-conflict]")?.dataset.conflict;
      if (!choice) return;
      dialog.removeEventListener("click", onClick);
      dialog.close();
      if (choice === "theirs") {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: current.content } });
        checksumInput.value = current.checksum;
        saved = current.content;
        status.textContent = "Loaded their version.";
      } else if (choice === "mine") {
        checksumInput.value = current.checksum;
        void save(true);
      } else {
        view.focus();
      }
    };
    dialog.addEventListener("click", onClick);
    dialog.showModal();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void save(false);
  });
  // Ctrl/Cmd-S outside the editor (title/folder fields) too.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !view.hasFocus) {
      e.preventDefault();
      void save(false);
    }
  });

  const onUnload = (e: BeforeUnloadEvent) => {
    if (dirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", onUnload);

  // ---- attachments: drop, paste or the Attach button; each becomes ![caption](/app/files/…) ----
  async function uploadFiles(files: File[], at: number) {
    let pos = at;
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        status.textContent = `${file.name} is larger than 10 MB.`;
        continue;
      }
      const placeholder = `![Uploading ${file.name.replace(/[[\]]/g, "")}…]()`;
      view.dispatch({ changes: { from: pos, insert: placeholder } });
      const fd = new FormData();
      fd.append("project", project);
      fd.append("file", file);
      let insert = "";
      try {
        const r = await fetch("/app/api/files", { method: "POST", body: fd, credentials: "same-origin" });
        const j = (await r.json()) as { markdown?: string; error?: string };
        if (r.ok && j.markdown) insert = j.markdown;
        else status.textContent = `${file.name}: ${j.error ?? `upload failed (${r.status})`}`;
      } catch {
        status.textContent = `${file.name}: upload failed (network).`;
      }
      const doc = view.state.doc.toString();
      const i = doc.indexOf(placeholder);
      if (i >= 0) view.dispatch({ changes: { from: i, to: i + placeholder.length, insert } });
      pos = (i >= 0 ? i : pos) + insert.length;
      if (insert && files.length > 1) {
        view.dispatch({ changes: { from: pos, insert: "\n" } });
        pos += 1;
      }
    }
  }
  const attachBtn = document.getElementById("editor-attach") as HTMLButtonElement | null;
  const fileInput = document.getElementById("editor-file") as HTMLInputElement | null;
  if (attachBtn && fileInput) {
    attachBtn.hidden = false;
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = "";
      if (files.length) void uploadFiles(files, view.state.selection.main.head);
    });
  }

  const del = document.getElementById("delete-form") as HTMLFormElement | null;
  del?.addEventListener("submit", (e) => {
    if (!window.confirm("Delete this note? It is kept in the project's history, but links to it become unresolved.")) e.preventDefault();
    else window.removeEventListener("beforeunload", onUnload);
  });

  if (!permalink && !titleInput.value) titleInput.focus();
  else view.focus();

  titles = await loadTitles(project);
  byTitle = new Map(titles.map((n) => [n.title.toLowerCase(), n.permalink]));
  const dl = document.createElement("datalist");
  dl.id = "folder-list";
  for (const f of [...new Set(titles.map((n) => n.folder).filter(Boolean))].sort()) dl.append(new Option(f, f));
  form.append(dl);
  renderPreview();
}
