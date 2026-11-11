// Delivery timeline for a pact, built on Bryntum Gantt.
// Each milestone is a bar coloured by where its money is (held on PayPal, captured, partially settled,
// refunded). Bars are linked finish-to-start, PayPal events are drawn as time ranges, and the forecast
// comes from the server's scheduler: every arbiter-requested revision pushes later milestones out.
const BASE = "/vendor/bryntum";
let lib; // the @bryntum/gantt module, loaded on first use
let gantt = null;
let ganttPactId = null;
let info = new Map(); // task id -> { amount, state, sched, milestone }

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  document.head.appendChild(l);
}

async function loadLib() {
  if (lib) return lib;
  // Bryntum needs three CSS layers: structural, exactly one theme, and FontAwesome.
  loadCss(`${BASE}/gantt.css`);
  loadCss(`${BASE}/svalbard-light.css`);
  loadCss(`${BASE}/fontawesome/css/fontawesome.css`);
  loadCss(`${BASE}/fontawesome/css/solid.css`);
  lib = await import(`${BASE}/gantt.module.js`);
  return lib;
}

const STATE = {
  awaiting: { label: "Not funded", color: "gray" },
  held: { label: "Held on PayPal", color: "orange" },
  reviewing: { label: "Arbiter reviewing", color: "blue" },
  released: { label: "Captured", color: "green" },
  settled: { label: "Partially captured", color: "violet" },
  refunded: { label: "Refunded", color: "red" },
  voided: { label: "Voided", color: "light-gray" },
};

function moneyState(p, m) {
  if (p.status === "awaiting_funding") return "awaiting";
  if (m.status === "reviewing") return "reviewing";
  if (m.status === "released") return m.settlement?.refunded ? "settled" : "released";
  if (["settled", "refunded", "voided"].includes(m.status)) return m.status;
  return "held";
}

const fmt = (n, cur) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(Number(n) || 0);

function buildData(p) {
  info = new Map();
  const tasksData = p.milestones.map((m, i) => {
    const sched = p.schedule.find((s) => s.milestoneId === m.id);
    const state = moneyState(p, m);
    const id = `t${i + 1}`;
    info.set(id, { amount: m.amount, state, sched, milestone: m, currency: p.currency });
    const done = m.settlement ? m.settlement.percent : m.status === "reviewing" ? 50 : m.submissions.length ? 25 : 0;
    return {
      id,
      name: `M${i + 1} · ${m.title}`,
      startDate: sched.start,
      endDate: sched.end,
      manuallyScheduled: true, // the server's scheduler owns the dates
      deadlineDate: sched.deadline,
      percentDone: done,
      eventColor: STATE[state].color,
      cls: sched.atRisk ? "clause-at-risk" : "",
    };
  });
  const dependenciesData = tasksData.slice(1).map((t, i) => ({ id: `d${i + 1}`, from: tasksData[i].id, to: t.id }));

  // PayPal money movements as markers on the timeline
  const label = { hold: "Hold placed", capture: "Captured", refund: "Refunded", void: "Hold voided", reauthorize: "Reauthorized" };
  const timeRangesData = p.ledger.map((l, i) => ({
    id: `r${i + 1}`,
    name: `${label[l.kind] || l.kind}${l.amount ? ` ${fmt(l.amount, p.currency)}` : ""}`,
    startDate: l.at,
    cls: `clause-range-${l.kind}`,
  }));
  return { tasksData, dependenciesData, timeRangesData };
}

function viewRange(p) {
  const starts = p.schedule.map((s) => new Date(s.start).getTime());
  const ends = p.schedule.flatMap((s) => [new Date(s.end).getTime(), new Date(s.deadline).getTime()]);
  const day = 86_400_000;
  return { startDate: new Date(Math.min(...starts) - day), endDate: new Date(Math.max(...ends, Date.now()) + 2 * day) };
}

/** Mount (or update in place) the timeline inside `el` for pact `p`. */
export async function renderTimeline(el, p) {
  const { Gantt, StringHelper } = await loadLib();
  const enc = (s) => StringHelper.encodeHtml(String(s ?? ""));
  const data = buildData(p);

  if (gantt && ganttPactId === p.id && !gantt.isDestroyed) {
    if (gantt.element.parentElement !== el) el.appendChild(gantt.element);
    await gantt.project.loadInlineData(data);
    gantt.setTimeSpan(viewRange(p).startDate, viewRange(p).endDate);
    return;
  }
  gantt?.destroy();
  ganttPactId = p.id;

  gantt = new Gantt({
    appendTo: el,
    height: 60 + p.milestones.length * 46 + 6,
    rowHeight: 46,
    barMargin: 9,
    readOnly: true, // dates are owned by the escrow scheduler, not dragged by hand
    viewPreset: "weekAndDayLetter",
    ...viewRange(p),
    project: data,
    columns: [
      { type: "name", text: "Milestone", width: 220 },
      {
        text: "Amount",
        width: 92,
        align: "right",
        renderer: ({ record }) => fmt(info.get(record.id)?.amount, info.get(record.id)?.currency || "USD"),
      },
      {
        text: "Money",
        width: 150,
        htmlEncode: false,
        renderer: ({ record }) => {
          const i = info.get(record.id);
          if (!i) return "";
          return `<span class="clause-money clause-money-${i.state}">${enc(STATE[i.state].label)}</span>`;
        },
      },
      {
        text: "Forecast",
        width: 128,
        htmlEncode: false,
        renderer: ({ record }) => {
          const s = info.get(record.id)?.sched;
          if (!s) return "";
          const d = new Date(s.end).toLocaleDateString(undefined, { month: "short", day: "numeric" });
          return s.atRisk ? `<span class="clause-risk">${enc(d)} · +${enc(s.slipDays)}d</span>` : enc(d);
        },
      },
    ],
    features: {
      taskEdit: false,
      taskMenu: false,
      cellEdit: false,
      taskDrag: false,
      taskResize: false,
      taskDragCreate: false,
      dependencies: true,
      percentBar: true,
      projectLines: false,
      timeRanges: { showCurrentTimeLine: { name: "Now" }, showHeaderElements: true },
      taskTooltip: {
        template: ({ taskRecord }) => {
          const i = info.get(taskRecord.id);
          if (!i) return enc(taskRecord.name);
          const s = i.sched;
          const v = i.milestone.submissions.at(-1)?.verdict;
          const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
          return `<div class="clause-tip">
            <b>${enc(taskRecord.name)}</b>
            <div>${enc(fmt(i.amount, i.currency))} · ${enc(STATE[i.state].label)}</div>
            <div>${s.projected ? "Projected" : "Forecast"}: ${enc(day(s.start))} → ${enc(day(s.end))}</div>
            <div>Contract deadline: ${enc(day(s.deadline))}${s.atRisk ? ` <span class="clause-risk">at risk (+${enc(s.slipDays)}d)</span>` : ""}</div>
            ${s.revisions ? `<div>${enc(s.revisions)} revision(s) requested by the arbiter (+${enc(s.revisions * 2)}d buffer)</div>` : ""}
            ${v ? `<div>Last verdict: ${enc(v.decision.replace("_", " "))}, ${enc(Math.round(v.confidence * 100))}% confidence</div>` : ""}
          </div>`;
        },
      },
    },
    taskRenderer: ({ taskRecord }) => {
      const i = info.get(taskRecord.id);
      return i ? `${fmt(i.amount, i.currency)} · ${STATE[i.state].label}` : "";
    },
  });
}

export function destroyTimeline() {
  gantt?.destroy();
  gantt = null;
  ganttPactId = null;
}

/** Keep the live Gantt element across a full page re-render. */
export function detachTimeline() {
  const node = gantt && !gantt.isDestroyed ? gantt.element : null;
  node?.remove();
  return node;
}
