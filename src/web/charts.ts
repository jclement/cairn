// Server-rendered, accessible SVG bar charts (no script, CSP-safe). The SVG stretches to the card
// (preserveAspectRatio="none"), so it holds only bars and grid lines; axis labels are HTML so the
// text never stretches. Colours come from app.css (figure.chart …).
import { html } from "hono/html";

export interface Point {
  label: string;
  value: number;
}

/** A short label for an axis tick: "2026-11-04" → "Nov 4", anything else unchanged. */
function tickLabel(label: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(label);
  if (!m) return label;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1] ?? m[2];
  return m[3] ? `${month} ${Number(m[3])}` : `${month} ${m[1].slice(2)}`;
}

export function barChart(id: string, title: string, points: Point[], unit = "") {
  const W = 640;
  const H = 180;
  const max = Math.max(1, ...points.map((p) => p.value));
  const bw = points.length ? W / points.length : 0;
  const gap = Math.min(6, bw * 0.24);
  const y = (v: number) => H * (1 - v / max);
  const every = Math.max(1, Math.ceil(points.length / 7));
  const total = points.reduce((s, p) => s + p.value, 0);
  const desc = `${points.length} periods, total ${total}${unit ? ` ${unit}` : ""}, peak ${max}.`;
  return html`<figure class="chart">
  <div class="chart-plot">
    <span class="chart-y chart-y-max" aria-hidden="true">${max}</span><span class="chart-y chart-y-mid" aria-hidden="true">${max >= 2 ? Math.round(max / 2) : ""}</span><span class="chart-y chart-y-zero" aria-hidden="true">0</span>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-t ${id}-d" preserveAspectRatio="none">
    <title id="${id}-t">${title}</title>
    <desc id="${id}-d">${desc}</desc>
    <line class="grid" x1="0" y1="0.5" x2="${W}" y2="0.5"></line>
    <line class="grid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"></line>
    <line class="axis" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"></line>
    ${points.map(
      (p, i) =>
        html`<rect class="bar" x="${(i * bw + gap / 2).toFixed(1)}" y="${y(p.value).toFixed(1)}" width="${Math.max(1, bw - gap).toFixed(1)}" height="${(H - y(p.value)).toFixed(1)}"><title>${p.label}: ${p.value}${unit ? ` ${unit}` : ""}</title></rect>`,
    )}
    </svg>
  </div>
  <div class="chart-x" aria-hidden="true">${points.map((p, i) => html`<span>${i % every === 0 ? tickLabel(p.label) : ""}</span>`)}</div>
  <figcaption>${title}</figcaption>
  <details><summary>Data</summary><table><tr><th>Period</th><th>${unit || "Count"}</th></tr>${points.map((p) => html`<tr><td>${p.label}</td><td>${p.value}</td></tr>`)}</table></details>
</figure>`;
}

/** A ranked list with a bar per row (top tags, kinds, tools…). */
export function rankList(rows: { label: unknown; value: number }[], empty = "Nothing yet."): ReturnType<typeof html> {
  if (!rows.length) return html`<p class="m-0 text-sm text-muted">${empty}</p>`;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`<ul class="rank">${rows.map(
    (r) => html`<li><span class="rank-label">${r.label}</span><span class="rank-n">${r.value}</span>
      <svg class="rank-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="4" class="rank-track"></rect><rect width="${Math.max(2, (100 * r.value) / max).toFixed(1)}" height="4" class="rank-fill"></rect></svg></li>`,
  )}</ul>`;
}
