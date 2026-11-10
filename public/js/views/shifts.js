// Cashier shifts: open, live summary, close with counted cash per mode (ERPNext POS opening / closing entry).
import { api } from '../api.js';
import { app, isAdmin, openDoc, printDoc } from '../app.js';
import { r2 } from '../gst.js';
import { busy, html, icon, money, openModal, render, toast } from '../ui.js';

export async function mount(el) {
  const S = app.settings;

  async function load() {
    let cur;
    let list;
    try {
      [cur, list] = await Promise.all([api.get('/api/sessions/current'), api.get('/api/sessions?limit=60')]);
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    const s = cur.session;
    const sum = cur.summary;
    const modes = s ? [...new Set([...S.payment_modes, ...Object.keys(sum.expected)])] : [];
    render(el, html`<div class="page">
      <div class="page-head"><h1>Shifts</h1>${s ? html`<div class="row"><button type="button" class="btn" data-x="${s.id}">${icon('printer')} X report</button></div>` : ''}</div>
      ${s ? html`<div class="grid-2">
        <div class="card"><div class="card-head"><h2>Your open shift #${s.id}</h2><span class="badge badge-good">Open</span></div>
          <div class="card-body stack">
            <div class="kv">
              <div><span>Opened</span><b>${s.opened_at}</b></div><div><span>Opening cash</span><b>${money(s.opening_cash)}</b></div>
              <div><span>Sales</span><b>${sum.sales.count} · ${money(sum.sales.total)}</b></div><div><span>Returns</span><b>${sum.returns.count} · ${money(sum.returns.total)}</b></div>
              <div><span>GST collected</span><b>${money(sum.sales.tax + sum.returns.tax)}</b></div><div><span>Credit given</span><b>${money(sum.sales.credit)}</b></div>
            </div>
            <a class="btn btn-primary" href="#/pos">${icon('cart')} Continue billing</a>
          </div></div>
        <form class="card" id="closeform"><div class="card-head"><h2>Close shift</h2></div>
          <div class="card-body stack">
            <p class="muted small">Count the money for each payment mode. The expected amount includes the opening cash, sales, refunds and credit payments received in this shift.</p>
            <table class="table"><thead><tr><th>Mode</th><th class="num">Expected</th><th class="num" style="width:140px">Counted</th><th class="num">Difference</th></tr></thead><tbody>
              ${modes.map((m) => html`<tr><td>${m}</td><td class="num">${money(sum.expected[m] ?? 0)}</td>
                <td><input class="input" type="number" step="0.01" name="${m}" value="${(sum.expected[m] ?? 0).toFixed(2)}" data-exp="${sum.expected[m] ?? 0}" aria-label="Counted ${m}"></td>
                <td class="num" data-diff="${m}">0.00</td></tr>`)}
            </tbody></table>
            <label class="field"><span>Notes</span><input class="input" name="__notes" maxlength="300"></label>
            <button class="btn btn-primary">Close shift</button>
          </div></form>
      </div>` : html`<div class="card card-pad row-between"><div><h2>No open shift</h2><p class="muted">Open a shift to start billing. The opening cash is used to reconcile the drawer at closing.</p></div>
        <button type="button" class="btn btn-primary" data-act="open">${icon('clock')} Open shift</button></div>`}

      <h2 class="mt-lg">${isAdmin() ? 'All shifts' : 'Your shifts'}</h2>
      <div class="card mt"><div class="table-wrap">${list.sessions.length ? html`<table class="table"><thead><tr><th>#</th><th>Cashier</th><th>Opened</th><th>Closed</th><th class="num">Bills</th><th class="num">Net sales</th><th class="num">Difference</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.sessions.map((x) => {
          const diff = x.closing ? r2(Object.values(x.closing.difference || {}).reduce((a, v) => a + v, 0)) : null;
          return html`<tr><td>${x.id}</td><td>${x.full_name || x.username}</td><td class="nowrap">${x.opened_at}</td><td class="nowrap">${x.closed_at || ''}</td>
            <td class="num">${x.bills}</td><td class="num">${money(x.net)}</td>
            <td class="num">${diff === null ? '' : diff === 0 ? html`<span class="faint">0.00</span>` : html`<span class="badge ${diff < 0 ? 'badge-bad' : 'badge-warn'}">${diff > 0 ? '+' : ''}${money(diff)}</span>`}</td>
            <td>${x.status === 'Open' ? html`<span class="badge badge-good">Open</span>` : html`<span class="badge">Closed</span>`}</td>
            <td class="right"><button type="button" class="icon-btn" data-view="${x.id}" title="Shift report" aria-label="Shift report ${x.id}">${icon('printer')}</button></td></tr>`;
        })}</tbody></table>` : html`<div class="empty">No shifts yet.</div>`}</div></div>
    </div>`);

    const form = el.querySelector('#closeform');
    if (form) {
      const recalc = () => {
        for (const inp of form.querySelectorAll('[data-exp]')) {
          const d = r2((Number(inp.value) || 0) - Number(inp.dataset.exp));
          const cell = form.querySelector(`[data-diff="${CSS.escape(inp.name)}"]`);
          cell.textContent = `${d > 0 ? '+' : ''}${d.toFixed(2)}`;
          cell.style.color = d < 0 ? 'var(--bad)' : d > 0 ? 'var(--warn)' : '';
        }
      };
      form.addEventListener('input', recalc);
      recalc();
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const counted = {};
        for (const inp of form.querySelectorAll('[data-exp]')) counted[inp.name] = Number(inp.value) || 0;
        busy(form.querySelector('.btn-primary'), async () => {
          await api.post(`/api/sessions/${s.id}/close`, { counted, notes: form.elements.__notes.value });
          toast(`Shift #${s.id} closed`, 'success');
          printDoc(`session=${s.id}`);
          load();
        });
      });
    }
  }

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-view],[data-x]');
    if (!t) return;
    if (t.dataset.view) return openDoc(`session=${t.dataset.view}`);
    if (t.dataset.x) return printDoc(`session=${t.dataset.x}`);
    if (t.dataset.act === 'open') {
      const m = openModal({
        title: 'Open shift',
        content: html`<form class="stack"><label class="field"><span>Opening cash in drawer (₹)</span><input class="input" type="number" name="opening_cash" min="0" step="0.01" value="0" autofocus></label>
          <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Open shift</button></div></form>`,
      });
      const f = m.body.querySelector('form');
      f.addEventListener('submit', (ev) => {
        ev.preventDefault();
        busy(f.querySelector('.btn-primary'), async () => {
          await api.post('/api/sessions/open', { opening_cash: f.elements.opening_cash.value });
          m.close();
          toast('Shift opened', 'success');
          load();
        });
      });
    }
    return undefined;
  });

  await load();
}
