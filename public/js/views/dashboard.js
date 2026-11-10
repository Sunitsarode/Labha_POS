// Owner dashboard: today's figures, 14-day sales trend, payment split, best sellers, low stock.
import { api } from '../api.js';
import { app } from '../app.js';
import { fmtINR } from '../gst.js';
import { date, html, icon, money, qty, render, toast } from '../ui.js';

/** Indian compact notation for axis ticks: 25K, 1.5L, 2Cr. */
function compact(v) {
  const t = (x) => String(Math.round(x * 10) / 10);
  if (v >= 1e7) return `${t(v / 1e7)}Cr`;
  if (v >= 1e5) return `${t(v / 1e5)}L`;
  if (v >= 1e3) return `${t(v / 1e3)}K`;
  return String(v);
}

function niceScale(max) {
  if (max <= 0) return { top: 1000, step: 250 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { top: Math.ceil(max / step) * step, step };
}

const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLong = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Single-series column chart (net sales per day). Bars ≤ 24px, 4px rounded tops, per-bar hover/focus tooltip. */
function columnChart(box, data) {
  const NS = 'http://www.w3.org/2000/svg';
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  function draw() {
    const W = Math.max(300, box.clientWidth);
    const H = 230;
    const m = { t: 24, r: 6, b: 26, l: 46 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const values = data.map((d) => Math.max(0, d.net));
    const { top, step } = niceScale(Math.max(...values));
    const y = (v) => m.t + ph - (v / top) * ph;
    const band = pw / data.length;
    const bw = Math.min(24, band * 0.6);
    const every = band < 38 ? 2 : 1;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Net sales per day for the last 14 days');
    const add = (tag, attrs, parent = svg) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      parent.append(e);
      return e;
    };
    for (let v = 0; v <= top + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      add('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: 'grid-line' });
      add('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis-text' }).textContent = compact(v);
    }
    const peak = values.indexOf(Math.max(...values));
    const bars = data.map((d, i) => {
      const v = values[i];
      const x = m.l + i * band + (band - bw) / 2;
      const yTop = y(v);
      const h = m.t + ph - yTop;
      const r = Math.min(4, h, bw / 2);
      const base = m.t + ph;
      const path = h > 0
        ? `M${x},${base}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + bw - r}Q${x + bw},${yTop} ${x + bw},${yTop + r}V${base}Z`
        : '';
      const bar = add('path', { d: path, class: 'bar' });
      if (i % every === (data.length - 1) % every) {
        add('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'axis-text' }).textContent = i === data.length - 1 ? 'Today' : dayLabel(d.date);
      }
      if (i === peak && v > 0) {
        add('text', { x: x + bw / 2, y: yTop - 6, 'text-anchor': 'middle', class: 'value-label' }).textContent = compact(Math.round(v));
      }
      return bar;
    });
    // Hit targets: the full day band (bigger than the bar), keyboard-focusable.
    data.forEach((d, i) => {
      const hit = add('rect', { x: m.l + i * band, y: m.t, width: band, height: ph, class: 'hit', tabindex: '0', role: 'img',
        'aria-label': `${dayLong(d.date)}: ${fmtINR(d.net)}, ${d.bills} bills` });
      const show = () => {
        bars.forEach((b, j) => b.classList.toggle('dim', j !== i));
        tip.replaceChildren();
        const strong = document.createElement('strong');
        strong.textContent = fmtINR(d.net);
        const span = document.createElement('span');
        span.textContent = `${dayLong(d.date)} · ${d.bills} bill${d.bills === 1 ? '' : 's'}`;
        tip.append(strong, span);
        tip.hidden = false;
        tip.style.left = `${((m.l + i * band + band / 2) / W) * 100}%`;
        tip.style.top = `${y(values[i])}px`;
      };
      const hide = () => { bars.forEach((b) => b.classList.remove('dim')); tip.hidden = true; };
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('blur', hide);
    });
    box.replaceChildren(svg, tip);
  }

  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(box);
  return () => ro.disconnect();
}

export async function mount(el) {
  let d;
  try {
    d = await api.get('/api/reports/dashboard');
  } catch (e) {
    toast(e.message, 'error');
    render(el, html`<div class="page"><div class="empty"><h3>Could not load the dashboard</h3><p>${e.message}</p></div></div>`);
    return undefined;
  }
  const avg = d.today.bills ? d.today.net / d.today.bills : 0;
  const maxPay = Math.max(1, ...d.payments.map((p) => Math.abs(p.amount)));
  render(el, html`<div class="page">
    <div class="page-head"><div><h1>Dashboard</h1><div class="muted">${app.settings.company_name} · ${date(d.today.date)}</div></div>
      <a class="btn btn-primary" href="#/pos">${icon('cart')} Open POS</a></div>
    <div class="tiles">
      <div class="card tile"><div class="lbl">Net sales today</div><div class="val">${money(d.today.net)}</div><div class="sub">${d.today.bills} bills · ${d.today.returns} returns</div></div>
      <div class="card tile"><div class="lbl">Average bill today</div><div class="val">${money(avg)}</div><div class="sub">GST collected ${money(d.today.tax)}</div></div>
      <div class="card tile"><div class="lbl">Net sales this month</div><div class="val">${money(d.month.net)}</div><div class="sub">${d.month.bills} bills since ${date(d.month.from)}</div></div>
      <div class="card tile"><div class="lbl">GST this month</div><div class="val">${money(d.month.tax)}</div><div class="sub">on taxable value ${money(d.month.taxable)}</div></div>
      <div class="card tile"><div class="lbl">Receivable (credit sales)</div><div class="val">${money(d.receivables.amount)}</div><div class="sub">${d.receivables.count} invoices due</div></div>
    </div>
    <div class="grid-3">
      <div class="card span-2c"><div class="card-head"><h2>Net sales, last 14 days</h2></div>
        <div class="card-body"><div class="chart" id="trend"></div>
          <details class="table-view"><summary>Show as table</summary><table class="table mt"><thead><tr><th>Date</th><th class="num">Bills</th><th class="num">Net sales</th></tr></thead><tbody>
            ${d.trend.map((t) => html`<tr><td>${date(t.date)}</td><td class="num">${t.bills}</td><td class="num">${money(t.net)}</td></tr>`)}</tbody></table></details></div></div>
      <div class="card"><div class="card-head"><h2>Collections today</h2></div><div class="card-body stack">
        ${d.payments.length ? d.payments.map((p) => html`<div><div class="row-between"><span>${p.mode}</span><b class="num">${money(p.amount)}</b></div>
          <div class="meter" style="margin-top:6px"><i style="width:${Math.max(2, (Math.abs(p.amount) / maxPay) * 100).toFixed(1)}%"></i></div></div>`)
          : html`<p class="muted">No payments yet today.</p>`}</div></div>
    </div>
    <div class="grid-2 mt">
      <div class="card"><div class="card-head"><h2>Best sellers this month</h2></div>
        ${d.top_items.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Sales</th></tr></thead><tbody>
          ${d.top_items.map((t) => html`<tr><td>${t.name}</td><td class="num">${qty(t.qty)}</td><td class="num">${money(t.amount)}</td></tr>`)}</tbody></table></div>`
          : html`<div class="card-body muted">No sales this month yet.</div>`}</div>
      <div class="card"><div class="card-head"><h2>Low stock</h2><a class="small" href="#/items">All items →</a></div>
        ${d.low_stock.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th class="num">In stock</th><th class="num">Re-order at</th></tr></thead><tbody>
          ${d.low_stock.map((t) => html`<tr><td>${t.name}</td><td class="num">${t.stock_qty <= 0 ? html`<span class="badge badge-bad">${qty(t.stock_qty)}</span>` : html`<span class="badge badge-warn">${qty(t.stock_qty)}</span>`} ${t.uom}</td><td class="num">${qty(t.reorder_level)}</td></tr>`)}</tbody></table></div>`
          : html`<div class="card-body muted">All tracked items are above their re-order level.</div>`}</div>
    </div>
  </div>`);
  return columnChart(el.querySelector('#trend'), d.trend);
}
