// Obsidian-style graph: the whole project (/app/graph) or a note's neighbourhood (note pages).
// force-graph (canvas, d3-force) draws it; data comes from /app/api/graph (ETag-revalidated).

import { forceCollide, forceX, forceY } from "d3-force-3d";
import ForceGraph from "force-graph";
import { noteUrl } from "../web/viewer/shared";
import { h, prefersReducedMotion } from "./lib";

interface GNode {
  id: string;
  title: string;
  type: string;
  folder: string;
  tags: string[];
  updated_at: string;
  ghost?: boolean;
  // filled in here / by force-graph
  deg: number;
  x?: number;
  y?: number;
}
interface GEdge {
  source: string;
  target: string;
  type: string;
}
interface GLink {
  source: string | GNode;
  target: string | GNode;
  type: string;
}

const PALETTE_VARS = ["--owg-accent", "--owg-purple", "--owg-amber", "--owg-cyan", "--owg-green", "--owg-blue", "--owg-red"];

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function themeColors() {
  return {
    palette: PALETTE_VARS.map((v) => cssVar(v, "#38bdf8")),
    text: cssVar("--owg-text", "#222"),
    muted: cssVar("--owg-muted", "#777"),
    faint: cssVar("--owg-faint", "#bbb"),
    edge: cssVar("--owg-border-strong", "#ccc"),
    accent: cssVar("--owg-accent", "#0ea5e9"),
    bg: cssVar("--owg-bg", "#fff"),
  };
}

const endId = (e: string | GNode) => (typeof e === "string" ? e : e.id);

for (const section of document.querySelectorAll<HTMLElement>("section[data-graph]")) void mount(section);

async function mount(section: HTMLElement) {
  const local = section.dataset.graph === "local";
  const project = section.dataset.project ?? "";
  const focusId = section.dataset.permalink ?? "";

  const res = await fetch(`/app/api/graph?project=${encodeURIComponent(project)}`, { cache: "no-cache", credentials: "same-origin" });
  if (!res.ok) {
    section.append(h("p", { class: "error" }, "Could not load the graph."));
    return;
  }
  const data = (await res.json()) as { nodes: GNode[]; edges: GEdge[] };
  const nodes = new Map<string, GNode>();
  for (const n of data.nodes) nodes.set(n.id, { ...n, deg: 0 });
  const adj = new Map<string, Set<string>>();
  for (const e of data.edges) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (!s || !t) continue;
    s.deg++;
    t.deg++;
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)?.add(e.target);
    adj.get(e.target)?.add(e.source);
  }
  if (local && !adj.has(focusId) && !data.nodes.some((n) => n.id === focusId)) return;

  // ---- controls ----
  const types = [...new Set(data.nodes.filter((n) => !n.ghost).map((n) => n.type))].sort();
  const tags = [...new Set(data.nodes.flatMap((n) => n.tags))].sort();
  const folders = [...new Set(data.nodes.map((n) => n.folder.split("/")[0]).filter(Boolean))].sort();
  const sel = (name: string, label: string, opts: [string, string][], value = "") =>
    h("label", { class: "chip" }, `${label} `, h("select", { name }, ...opts.map(([v, l]) => h("option", { value: v, selected: v === value }, l))));

  const search = h("input", { type: "search", name: "find", placeholder: "Highlight notes…", "aria-label": "Highlight notes by title", autocomplete: "off" });
  const colorBy = sel("color", "colour", [
    ["type", "by type"],
    ["folder", "by folder"],
  ]);
  const typeSel = sel("type", "type", [["", "any"], ...types.map((t): [string, string] => [t, t])]);
  const tagSel = sel("tag", "tag", [["", "any"], ...tags.map((t): [string, string] => [t, `#${t}`])]);
  const folderSel = sel("folder", "folder", [["", "any"], ...folders.map((f): [string, string] => [f, f])]);
  const depthSel = local
    ? sel(
        "depth",
        "depth",
        [
          ["1", "1"],
          ["2", "2"],
          ["3", "3"],
        ],
        "1",
      )
    : null;
  const orphans = h("input", { type: "checkbox", name: "orphans", checked: !local });
  const ghosts = h("input", { type: "checkbox", name: "ghosts", checked: true });
  const toolbar = h(
    "form",
    { class: "graph-toolbar", role: "group", "aria-label": "Graph filters" },
    search,
    colorBy,
    ...(local ? [depthSel] : [typeSel, tagSel, folderSel]),
    local ? null : h("label", { class: "chip" }, orphans, " orphans"),
    h("label", { class: "chip" }, ghosts, " unresolved"),
  );
  toolbar.addEventListener("submit", (e) => e.preventDefault());
  const canvasBox = h("div", { class: "graph-canvas", tabindex: "-1" });
  const legend = h("div", { class: "graph-legend small", "aria-hidden": "true" });
  const listBody = h("tbody");
  const listSummary = h("summary", {}, "View as list");
  const list = h(
    "details",
    { class: "graph-list" },
    listSummary,
    h(
      "table",
      { class: "small" },
      h("thead", {}, h("tr", {}, h("th", {}, "Note"), h("th", {}, "Type"), h("th", {}, "Folder"), h("th", {}, "Links"))),
      listBody,
    ),
  );
  const info = h("p", { class: "muted small graph-info", "aria-live": "polite" });
  if (local) section.append(h("h2", {}, "Local graph"));
  section.append(toolbar, canvasBox, legend, info, list);

  const val = (el: HTMLElement) => (el.querySelector("select") as HTMLSelectElement).value;

  // ---- graph ----
  let colors = themeColors();
  const colorIndex = new Map<string, number>();
  const colorOf = (n: GNode) => {
    if (n.ghost) return colors.faint;
    const key = val(colorBy) === "folder" ? n.folder.split("/")[0] || "(top)" : n.type;
    if (!colorIndex.has(key)) colorIndex.set(key, colorIndex.size);
    return colors.palette[(colorIndex.get(key) ?? 0) % colors.palette.length];
  };
  const radius = (n: GNode) => (local && n.id === focusId ? 6 : 2.5 + Math.sqrt(n.deg) * 1.5);

  let hover: GNode | null = null;
  let hoverNeighbours = new Set<string>();
  let matches = new Set<string>();
  let matchList: GNode[] = [];
  let matchCursor = -1;

  // Hover emphasis eases in and out (0 = nothing hovered, 1 = fully focused on `focus`).
  let emph = 0;
  let big = false; // > 1200 visible nodes: cheaper drawing
  let animating = false;
  let focus: GNode | null = null;
  let focusSet = new Set<string>();
  const reduced = prefersReducedMotion();
  const ease = () => {
    const target = hover ? 1 : 0;
    if (reduced) emph = target;
    else emph += (target - emph) * 0.22;
    if (Math.abs(target - emph) < 0.01) emph = target;
    if (emph === 0) focus = null;
    return emph !== target;
  };
  const lit = (id: string) => !focus || id === focus.id || focusSet.has(id);
  const nodeAlpha = (g: GNode) => {
    let a = 1;
    if (focus && !lit(g.id)) a = 1 - 0.85 * emph;
    if (matches.size && !matches.has(g.id)) a = Math.min(a, 0.15);
    return a;
  };
  // Labels fade in with zoom; well-linked notes appear first. Hovered neighbourhoods always show.
  const labelAlpha = (g: GNode, scale: number) => {
    if (g === focus || matches.has(g.id)) return 1;
    if (focus && lit(g.id)) return Math.max(emph, zoomLabel(g, scale));
    return zoomLabel(g, scale) * (focus ? 1 - emph : 1);
  };
  // Relative to the zoom that frames the whole graph: at rest only hubs are labelled (local
  // graphs are small, so everything is); zooming in ~1.3x brings the rest in.
  let fitScale = 1;
  const zoomLabel = (g: GNode, scale: number) => {
    if (local) return 1;
    const rel = scale / fitScale;
    const start = 1.3 - Math.min(g.deg, 12) * 0.045; // deg 12+ -> 0.76 (shown at rest)
    return Math.max(0, Math.min(1, (rel - start) / 0.35));
  };

  const fg = new ForceGraph<GNode, GLink>(canvasBox);
  // For automation (screenshots, tests): the instance hangs off its section element.
  (section as HTMLElement & { cairnGraph?: unknown }).cairnGraph = fg;
  fg.backgroundColor("rgba(0,0,0,0)")
    .nodeId("id")
    .nodeVal((n) => radius(n as GNode))
    .nodeLabel(() => "") // labels are drawn on the canvas
    .linkLabel((l) => {
      const k = l as GLink;
      const s = nodes.get(endId(k.source));
      const t = nodes.get(endId(k.target));
      return h("span", {}, `${s?.title ?? "?"} —${k.type}→ ${t?.title ?? "?"}`);
    })
    .linkCanvasObjectMode(() => "replace")
    .linkCanvasObject((l, ctx, scale) => {
      const k = l as GLink;
      const s = k.source as GNode;
      const t = k.target as GNode;
      if (typeof s !== "object" || typeof t !== "object") return;
      const onFocus = !!focus && (s === focus || t === focus);
      let a = focus ? (onFocus ? 0.35 + 0.55 * emph : 0.35 * (1 - 0.85 * emph)) : 0.35;
      if (matches.size && !(matches.has(s.id) && matches.has(t.id))) a = Math.min(a, 0.08);
      ctx.globalAlpha = a;
      ctx.strokeStyle = onFocus ? colors.accent : colors.edge;
      ctx.lineWidth = (onFocus ? 1.6 : 0.8) / Math.max(scale, 0.6);
      ctx.beginPath();
      ctx.moveTo(s.x ?? 0, s.y ?? 0);
      ctx.lineTo(t.x ?? 0, t.y ?? 0);
      ctx.stroke();
      if (local || onFocus) {
        // a small arrowhead at the target's rim
        const dx = (t.x ?? 0) - (s.x ?? 0);
        const dy = (t.y ?? 0) - (s.y ?? 0);
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const tip = radius(t) + 1;
        const ax = (t.x ?? 0) - ux * tip;
        const ay = (t.y ?? 0) - uy * tip;
        const sz = 3.2 / Math.max(scale, 0.8);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - ux * sz * 1.6 - uy * sz, ay - uy * sz * 1.6 + ux * sz);
        ctx.lineTo(ax - ux * sz * 1.6 + uy * sz, ay - uy * sz * 1.6 - ux * sz);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    })
    .nodeCanvasObject((n, ctx, scale) => {
      const g = n as GNode;
      const r = radius(g);
      const x = g.x ?? 0;
      const y = g.y ?? 0;
      const a = nodeAlpha(g);
      const c = colorOf(g);
      const strong = g === focus || matches.has(g.id) || (local && g.id === focusId);
      if (!g.ghost && (!big || strong || (focus && lit(g.id)))) {
        // soft glow (skipped for big graphs, except around the focus): two translucent halos, brighter for the focused node
        ctx.fillStyle = c;
        ctx.globalAlpha = a * (strong ? 0.2 : 0.07);
        ctx.beginPath();
        ctx.arc(x, y, r * (strong ? 2.6 : 2), 0, 2 * Math.PI);
        ctx.fill();
        ctx.globalAlpha = a * (strong ? 0.28 : 0.13);
        ctx.beginPath();
        ctx.arc(x, y, r * 1.45, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      if (g.ghost) {
        ctx.setLineDash([2 / Math.max(scale, 0.5), 2 / Math.max(scale, 0.5)]);
        ctx.lineWidth = 1 / Math.max(scale, 0.5);
        ctx.strokeStyle = colors.muted;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        ctx.fillStyle = c;
        ctx.fill();
      }
      if (strong) {
        ctx.lineWidth = 1.5 / scale;
        ctx.strokeStyle = colors.text;
        ctx.stroke();
      }
      const la = labelAlpha(g, scale) * Math.max(a, focus && lit(g.id) ? 1 : a);
      if (la > 0.02) {
        const size = (strong ? 12.5 : 11) / scale;
        ctx.font = `${strong ? "600 " : ""}${size}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = g.title.length > 40 ? `${g.title.slice(0, 39)}…` : g.title;
        const ty = y + r + 2 / scale;
        // a background-coloured halo keeps labels legible over edges
        ctx.globalAlpha = la * 0.85;
        ctx.lineWidth = 3 / scale;
        ctx.strokeStyle = colors.bg;
        ctx.lineJoin = "round";
        ctx.strokeText(label, x, ty);
        ctx.globalAlpha = la;
        ctx.fillStyle = g.ghost ? colors.muted : colors.text;
        ctx.fillText(label, x, ty);
      }
      ctx.globalAlpha = 1;
    })
    .nodePointerAreaPaint((n, color, ctx) => {
      const g = n as GNode;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(g.x ?? 0, g.y ?? 0, radius(g) + 3, 0, 2 * Math.PI);
      ctx.fill();
    })
    .onNodeHover((n) => {
      hover = (n as GNode) ?? null;
      hoverNeighbours = hover ? (adj.get(hover.id) ?? new Set()) : new Set();
      if (hover) {
        focus = hover;
        focusSet = hoverNeighbours;
      }
      canvasBox.style.cursor = n ? "pointer" : "";
      animate();
    })
    .onNodeClick((n) => open(n as GNode))
    .onNodeDragEnd((n) => {
      // Obsidian-style: let go and the node rejoins the simulation (no pinning)
      const g = n as GNode & { fx?: number; fy?: number };
      g.fx = undefined;
      g.fy = undefined;
    })
    .onRenderFramePre(() => {
      if (!ease() && animating) {
        animating = false;
        fg.autoPauseRedraw(true);
      }
    });

  // Keep redrawing while the hover emphasis eases; force-graph pauses redraws when idle.
  function animate() {
    if (animating) return;
    animating = true;
    fg.autoPauseRedraw(false);
  }

  // Calmer physics: more damping, slower cooling, no overlaps, bounded repulsion.
  fg.d3VelocityDecay(0.45).d3AlphaDecay(0.018);
  fg.d3Force("charge")
    ?.strength(local ? -140 : -55)
    .distanceMax(local ? 400 : 260);
  fg.d3Force("link")?.distance(local ? 55 : 34);
  fg.d3Force("collide", forceCollide((n: GNode) => radius(n) + 3).strength(0.7));
  // Gentle gravity keeps disconnected components and orphans near the middle.
  fg.d3Force("x", forceX(0).strength(local ? 0.04 : 0.07));
  fg.d3Force("y", forceY(0).strength(local ? 0.04 : 0.07));
  if (reduced) fg.cooldownTicks(0);
  else fg.cooldownTime(local ? 4000 : 12000);
  let fitted = false;
  const fit = (ms: number) => {
    fg.zoomToFit(ms, 40);
    setTimeout(() => {
      fitScale = fg.zoom() || 1;
      fg.nodeRelSize(fg.nodeRelSize()); // repaint with the new label thresholds
    }, ms + 30);
  };
  fg.onEngineStop(() => {
    if (!fitted) {
      fitted = true;
      fit(reduced ? 0 : 600);
    }
  });
  // Fit early too, so the first view is framed while the layout settles.
  if (!reduced) setTimeout(() => fitted || fit(500), local ? 700 : 1600);

  function open(n: GNode) {
    window.location.href = n.ghost ? `/app/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(n.title)}` : noteUrl(project, n.id);
  }

  const size = () => {
    const w = canvasBox.clientWidth || section.clientWidth || 600;
    fg.width(w).height(local ? Math.min(360, Math.max(240, w * 0.6)) : Math.max(420, Math.min(window.innerHeight - 220, w * 0.75)));
  };
  new ResizeObserver(size).observe(canvasBox);
  size();

  // ---- filtering ----
  function visible(): { ns: GNode[]; ls: GLink[] } {
    let keep: Set<string>;
    if (local) {
      const depth = Number(depthSel ? val(depthSel) : 1);
      keep = new Set([focusId]);
      let frontier = [focusId];
      for (let d = 0; d < depth; d++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const m of adj.get(id) ?? []) {
            if (keep.has(m)) continue;
            keep.add(m);
            next.push(m);
          }
        }
        frontier = next;
      }
    } else {
      const type = val(typeSel);
      const tag = val(tagSel);
      const folder = val(folderSel);
      keep = new Set(
        [...nodes.values()]
          .filter((n) => (n.ghost ? !type && !tag && !folder : true))
          .filter((n) => n.ghost || ((!type || n.type === type) && (!tag || n.tags.includes(tag)) && (!folder || n.folder.split("/")[0] === folder)))
          .map((n) => n.id),
      );
    }
    if (!ghosts.checked) for (const id of keep) if (nodes.get(id)?.ghost) keep.delete(id);
    const ls: GLink[] = data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)).map((e) => ({ source: e.source, target: e.target, type: e.type }));
    if (!local && !orphans.checked) {
      const linked = new Set(ls.flatMap((l) => [endId(l.source), endId(l.target)]));
      for (const id of keep) if (!linked.has(id)) keep.delete(id);
    }
    return { ns: [...keep].map((id) => nodes.get(id) as GNode), ls };
  }

  function apply() {
    const { ns, ls } = visible();
    fitted = false;
    big = ns.length > 1200;
    // Reduced motion: lay out synchronously, then draw once. Fewer ticks for big graphs keeps the page responsive.
    if (reduced) fg.warmupTicks(Math.max(40, Math.min(300, Math.round(120000 / Math.max(ns.length, 1)))));
    fg.graphData({ nodes: ns, links: ls });
    const real = ns.filter((n) => !n.ghost).length;
    info.textContent = `${real} note${real === 1 ? "" : "s"}, ${ns.length - real} unresolved, ${ls.length} link${ls.length === 1 ? "" : "s"}. Drag to move, scroll to zoom, click to open.`;
    renderLegend(ns);
    renderList(ns);
    highlight();
  }

  function renderLegend(ns: GNode[]) {
    const keys = new Map<string, string>();
    for (const n of ns) if (!n.ghost) keys.set(val(colorBy) === "folder" ? n.folder.split("/")[0] || "(top)" : n.type, colorOf(n));
    legend.replaceChildren(...[...keys.entries()].slice(0, 16).map(([k]) => h("span", { class: "legend-item" }, h("i", { class: "swatch" }), ` ${k}`)));
    // The CSP forbids style attributes, but CSSOM assignment is allowed:
    legend.querySelectorAll<HTMLElement>("i.swatch").forEach((el, i) => {
      el.style.background = [...keys.values()][i];
    });
  }

  function renderList(ns: GNode[]) {
    const rows = [...ns].sort((a, b) => b.deg - a.deg || a.title.localeCompare(b.title)).slice(0, 2000);
    listSummary.textContent = `View as list (${ns.length})`;
    listBody.replaceChildren(
      ...rows.map((n) =>
        h(
          "tr",
          {},
          h(
            "td",
            {},
            n.ghost
              ? h("a", { class: "wikilink unresolved", href: `/app/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(n.title)}` }, n.title)
              : h("a", { href: noteUrl(project, n.id) }, n.title),
          ),
          h("td", {}, n.ghost ? "unresolved" : n.type),
          h("td", {}, n.folder),
          h("td", {}, String(n.deg)),
        ),
      ),
    );
  }

  function highlight() {
    const q = search.value.trim().toLowerCase();
    const shown = new Set((fg.graphData().nodes as GNode[]).map((n) => n.id));
    matchList = q ? [...nodes.values()].filter((n) => shown.has(n.id) && n.title.toLowerCase().includes(q)) : [];
    matches = new Set(matchList.map((n) => n.id));
    matchCursor = -1;
    if (q)
      info.textContent = `${matchList.length} match${matchList.length === 1 ? "" : "es"} for “${search.value.trim()}”. Enter to step through them, Shift+Enter to open.`;
    fg.nodeRelSize(fg.nodeRelSize()); // repaint
  }

  search.addEventListener("input", highlight);
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !matchList.length) return;
    e.preventDefault();
    matchCursor = (matchCursor + 1) % matchList.length;
    const n = matchList[matchCursor];
    if (e.shiftKey) return open(n);
    fg.centerAt(n.x, n.y, reduced ? 0 : 500);
    fg.zoom(3, reduced ? 0 : 500);
    hover = n;
    hoverNeighbours = adj.get(n.id) ?? new Set();
    focus = n;
    focusSet = hoverNeighbours;
    animate();
    info.textContent = `${matchCursor + 1}/${matchList.length}: ${n.title}`;
  });
  for (const el of [typeSel, tagSel, folderSel, depthSel]) el?.querySelector("select")?.addEventListener("change", apply);
  orphans.addEventListener("change", apply);
  ghosts.addEventListener("change", apply);
  colorBy.querySelector("select")?.addEventListener("change", () => {
    colorIndex.clear();
    renderLegend(fg.graphData().nodes as GNode[]);
    fg.nodeRelSize(fg.nodeRelSize());
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    colors = themeColors();
    renderLegend(fg.graphData().nodes as GNode[]);
    fg.nodeRelSize(fg.nodeRelSize());
  });

  apply();
}
