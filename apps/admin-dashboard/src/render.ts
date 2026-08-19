import type { DashboardSnapshotState } from "./contracts.ts";
import { createDashboardView } from "./view.ts";

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function toneClass(tone: string): string {
  return `tone-${tone}`;
}

function shell(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Agent Feed operations</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.45; }
    body { margin: 0; background: #f5f7fa; color: #17202a; }
    main { max-width: 1120px; margin: 0 auto; padding: 2rem 1rem 4rem; }
    header { display: flex; justify-content: space-between; gap: 1rem; align-items: start; flex-wrap: wrap; }
    h1 { margin: 0; font-size: 1.75rem; }
    .muted { color: #52606d; }
    .status { border: 1px solid #cbd5e1; border-radius: .5rem; padding: .6rem .8rem; font-weight: 700; }
    .tone-good { color: #166534; background: #f0fdf4; border-color: #86efac; }
    .tone-warning { color: #854d0e; background: #fefce8; border-color: #fde047; }
    .tone-critical { color: #991b1b; background: #fef2f2; border-color: #fca5a5; }
    .tone-neutral { color: #334155; background: #f8fafc; border-color: #cbd5e1; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-top: 1.5rem; }
    .card { background: white; border: 1px solid #dbe2ea; border-radius: .6rem; padding: 1rem; min-height: 7rem; }
    .card h2 { font-size: 1rem; margin: 0 0 .5rem; }
    .value { font-size: 1.8rem; font-variant-numeric: tabular-nums; font-weight: 700; }
    .card p { margin: .5rem 0 0; font-size: .9rem; }
    .notice { border-radius: .5rem; border: 1px solid; padding: 1rem; margin-top: 1.5rem; }
    a { color: #075985; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #f8fafc; }
      .muted { color: #cbd5e1; }
      .card { background: #1f2937; border-color: #475569; }
      a { color: #7dd3fc; }
    }
  </style>
</head>
<body>
  <main>${content}</main>
</body>
</html>`;
}

function readyContent(state: Extract<DashboardSnapshotState, { kind: "ready" }>): string {
  const view = createDashboardView(state);
  if (!view) return emptyContent();
  const cards = view.cards.map((card) => `<article class="card ${toneClass(card.tone)}">
    <h2>${escapeHtml(card.label)}</h2>
    <div class="value" aria-label="${escapeHtml(`${card.label}: ${card.value}`)}">${escapeHtml(card.value)}</div>
    <p class="muted">${escapeHtml(card.help)}</p>
  </article>`).join("\n");
  const staleNotice = view.stale
    ? `<div class="notice tone-warning" role="status"><strong>Snapshot is stale.</strong> The dashboard is showing the last accepted aggregate.</div>`
    : "";
  return `<header>
    <div>
      <h1>Agent Feed operations</h1>
      <p class="muted">Read-only delivery health from a sanitized metric snapshot.</p>
    </div>
    <div class="status ${toneClass(view.statusTone)}" role="status">${escapeHtml(view.statusLabel)}</div>
  </header>
  <p class="muted">Updated ${escapeHtml(view.ageLabel)} · ${escapeHtml(view.generatedAt)} · <a href="/">Refresh</a> · <a href="/api/snapshot">Snapshot API</a></p>
  ${staleNotice}
  <section class="grid" aria-label="Delivery metrics">${cards}</section>`;
}

function emptyContent(): string {
  return `<header><div><h1>Agent Feed operations</h1><p class="muted">Read-only delivery health.</p></div></header>
  <div class="notice tone-neutral" role="status"><strong>No snapshot yet.</strong> The configured metrics source has not published an aggregate.</div>`;
}

function errorContent(error: Extract<DashboardSnapshotState, { kind: "error" }>["error"]): string {
  const message = error === "snapshot_invalid"
    ? "The metrics source returned an invalid snapshot. No raw source details are displayed."
    : "The metrics source is unavailable. Retry after checking the source adapter.";
  return `<header><div><h1>Agent Feed operations</h1><p class="muted">Read-only delivery health.</p></div></header>
  <div class="notice tone-critical" role="alert"><strong>Dashboard unavailable.</strong> ${escapeHtml(message)} <a href="/">Retry</a></div>`;
}

export function renderDashboardPage(state: DashboardSnapshotState): string {
  if (state.kind === "ready") return shell(readyContent(state));
  if (state.kind === "empty") return shell(emptyContent());
  return shell(errorContent(state.error));
}

export { escapeHtml };
