// HTML cards recorded with Playwright at 1920×1080. The bottom 150 px stay calm for captions.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BASE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:1920px;height:1080px;overflow:hidden}
  body{font-family:"Segoe UI",system-ui,sans-serif;color:#0f172a;background:radial-gradient(circle at 50% 35%,#f8fafc,#e2e8f0)}
  .in{opacity:0;transform:translateY(18px);animation:in .7s ease-out forwards}
  @keyframes in{to{opacity:1;transform:none}}
  .d1{animation-delay:.3s}.d2{animation-delay:.9s}.d3{animation-delay:1.6s}.d4{animation-delay:2.4s}.d5{animation-delay:3.2s}.d6{animation-delay:4s}.d7{animation-delay:5s}
  .accent{color:#0f766e}
`;

const page = (body: string, css = "") => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;

export function titleCard(): string {
  return page(
    `<div class="wrap">
      <div class="logo in"><svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="#0f766e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/><circle cx="17.5" cy="6.5" r="3.2" fill="#ecfeff"/><path d="m19.8 8.8 1.8 1.8"/></svg></div>
      <h1 class="in d1">SiteSight</h1>
      <p class="in d2">AI site-progress auditor for small contractors</p>
    </div>`,
    `.wrap{height:930px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
     h1{font-size:132px;font-weight:800;letter-spacing:-3px}
     p{font-size:46px;color:#334155}`,
  );
}

export function problemCard(photos: string[]): string {
  const bubbles = photos
    .slice(0, 3)
    .map(
      (src, i) => `<div class="bubble in d${i + 1}"><img src="${src}"/><span class="meta">${["10:42", "10:43", "16:05"][i]} ✓✓</span></div>`,
    )
    .join("");
  const rows = [
    ["1.1", "RCC footings F1/F2", "nos", "10", "?"],
    ["1.2", "RCC columns, GF", "nos", "12", "8 or 10?"],
    ["1.3", "Plinth beams", "lot", "1", "done?"],
    ["1.4", "GF roof slab, 125 mm", "m³", "—", "60%? 100%?"],
    ["1.5", "Brickwork, GF", "m²", "120", "\"most of it\""],
  ]
    .map((r, i) => `<tr class="in d${i + 2}">${r.map((c, j) => `<td class="${j === 4 ? "q" : ""}">${c}</td>`).join("")}</tr>`)
    .join("");
  return page(
    `<div class="wrap">
      <div class="phone in">
        <div class="chat-head"><span class="av"></span><div><b>Site – Ground floor</b><small>site engineer</small></div></div>
        <div class="chat">${bubbles}<div class="bubble text in d5">slab done today 👍</div></div>
      </div>
      <div class="sheet in d2">
        <div class="bar"><span>Running bill #3.xlsx</span></div>
        <table><thead><tr><th>Item</th><th>Description</th><th>Unit</th><th>Qty</th><th>Done?</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>
    <h2 class="in d6">Running bills, argued line by line.</h2>`,
    `.wrap{display:flex;gap:90px;justify-content:center;align-items:flex-start;padding-top:70px}
     .phone{width:470px;height:690px;border-radius:44px;background:#efeae2;border:12px solid #1f2328;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.18)}
     .chat-head{background:#075e54;color:#fff;display:flex;gap:14px;align-items:center;padding:16px 18px;font-size:22px}
     .chat-head small{display:block;font-size:16px;opacity:.8}
     .av{width:46px;height:46px;border-radius:50%;background:#cbd5e1}
     .chat{padding:16px;display:flex;flex-direction:column;gap:14px;align-items:flex-end}
     .bubble{background:#d9fdd3;border-radius:14px;padding:6px;position:relative;box-shadow:0 1px 1px rgba(0,0,0,.12)}
     .bubble img{display:block;width:240px;height:128px;object-fit:cover;border-radius:10px}
     .bubble .meta{position:absolute;right:14px;bottom:10px;color:#fff;font-size:15px;text-shadow:0 1px 2px #000}
     .bubble.text{padding:12px 16px;font-size:22px}
     .sheet{width:860px;background:#fff;border:1px solid #cbd5e1;box-shadow:0 20px 50px rgba(0,0,0,.12)}
     .bar{background:#107c41;color:#fff;font-size:22px;padding:12px 18px;font-weight:600}
     table{border-collapse:collapse;width:100%;font-size:25px}
     th,td{border:1px solid #d4d4d8;padding:12px 14px;text-align:left}
     th{background:#f4f4f5;font-weight:600;color:#3f3f46}
     td.q{color:#b91c1c;font-weight:700;background:#fef2f2}
     h2{position:absolute;left:0;right:0;top:810px;text-align:center;font-size:62px;font-weight:800;letter-spacing:-1px}`,
  );
}

export interface EvalHeadline {
  file: string;
  cases: number;
  runs: number;
  rows: [string, string][];
}

const pct = (r?: { pass: number; total: number }) => (r && r.total ? `${Math.round((r.pass / r.total) * 100)}%` : null);

/** The newest report.json with human-labelled headline numbers, or null. Never invents numbers. */
export function newestHumanReport(evalDir: string): EvalHeadline | null {
  if (!existsSync(evalDir)) return null;
  const reports: { file: string; mtime: number }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f === "report.json") reports.push({ file: p, mtime: st.mtimeMs });
    }
  };
  walk(evalDir);
  for (const r of reports.sort((a, b) => b.mtime - a.mtime)) {
    try {
      const j = JSON.parse(readFileSync(r.file, "utf8")) as {
        meta?: { humanCases?: number; runsPerCase?: number };
        headline?: Record<string, { pass: number; total: number } | null> | null;
      };
      const h = j.headline;
      if (!h || !j.meta?.humanCases) continue;
      const rows: [string, string | null][] = [
        ["Stage, exact match", pct(h.stage ?? undefined)],
        ["Count within tolerance", pct(h.count ?? undefined)],
        ["Evidence basis correct", pct(h.basis ?? undefined)],
        ["False detections caught", pct(h.rejectNotes ?? undefined)],
        ["Same answer across runs", pct(h.consistency ?? undefined)],
      ];
      return { file: r.file, cases: j.meta.humanCases, runs: j.meta.runsPerCase ?? 1, rows: rows.filter((x): x is [string, string] => x[1] != null) };
    } catch {
      // unreadable report: try the next one
    }
  }
  return null;
}

export function resultsCard(evalHeadline: EvalHeadline | null, costPerVisit: number | null): string {
  const evalBlock = evalHeadline
    ? `<div class="metrics">${evalHeadline.rows
        .map(([k, v], i) => `<div class="m in d${i + 1}"><b>${v}</b><span>${k}</span></div>`)
        .join("")}</div>
       <p class="note in d6">${evalHeadline.cases} human-labelled case${evalHeadline.cases === 1 ? "" : "s"} × ${evalHeadline.runs} run${evalHeadline.runs === 1 ? "" : "s"}</p>`
    : `<div class="pending in d1">Evaluation: pending</div>`;
  return page(
    `<div class="wrap">
      <h2 class="in">Results</h2>
      ${evalBlock}
      <div class="row in d4">
        <div class="cost"><b>${costPerVisit != null ? `$${costPerVisit.toFixed(2)}` : "—"}</b><span>Meta cost per visit<br/>(this demo's runs)</span></div>
        <div class="stack"><span>Muse Spark</span><span>SAM 3.1</span><span>Muse voice</span></div>
      </div>
    </div>`,
    `.wrap{height:930px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px}
     h2{font-size:72px;font-weight:800}
     .metrics{display:flex;gap:28px}
     .m{background:#fff;border-radius:24px;padding:26px 30px;width:300px;box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center}
     .m b{display:block;font-size:68px;color:#0f766e}.m span{font-size:24px;color:#334155}
     .note{font-size:28px;color:#475569}
     .pending{font-size:64px;font-weight:700;color:#64748b;background:#fff;border-radius:24px;padding:30px 60px}
     .row{display:flex;gap:40px;align-items:center}
     .cost{background:#0f766e;color:#fff;border-radius:24px;padding:22px 34px;display:flex;gap:22px;align-items:center}
     .cost b{font-size:64px}.cost span{font-size:24px;line-height:1.3}
     .stack{display:flex;gap:16px}.stack span{background:#fff;border:2px solid #0f766e;color:#0f766e;font-weight:700;font-size:30px;border-radius:999px;padding:14px 28px}`,
  );
}

export function endCard(app: string, repo: string): string {
  return page(
    `<div class="wrap">
      <h1 class="in">SiteSight</h1>
      <p class="in d1"><span>Try it</span><b>${app}</b></p>
      <p class="in d2"><span>Code</span><b>${repo}</b></p>
    </div>`,
    `.wrap{height:930px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px}
     h1{font-size:110px;font-weight:800;letter-spacing:-2px;margin-bottom:20px}
     p{font-size:40px;display:flex;gap:24px;align-items:baseline}
     p span{color:#64748b;width:120px;text-align:right;font-size:32px}
     p b{color:#0f766e;font-weight:700}`,
  );
}
