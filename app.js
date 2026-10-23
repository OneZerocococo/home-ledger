/* 家用帳本 LIFF 前端 */
(function () {
  'use strict';

  const CFG = window.LEDGER_CONFIG || {};
  const $ = (sel) => document.querySelector(sel);

  const state = {
    user: null,
    users: [],
    categories: [],
    month: '',
    type: '支出',
    editingId: null,
    listCache: {},
  };

  /* ---------- API ---------- */

  async function api(action, payload) {
    const body = Object.assign({ action, idToken: liff.getIDToken() }, payload || {});
    let res;
    try {
      // 不設 Content-Type,避免 Apps Script 無法處理的 CORS preflight
      res = await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      throw { code: 'NETWORK', message: '無法連線到伺服器,請檢查網路' };
    }
    let data;
    try { data = await res.json(); } catch (e) { throw { code: 'BAD_RESPONSE', message: '伺服器回應格式錯誤' }; }
    if (!data.ok) throw data;
    return data.data;
  }

  /* ---------- 工具 ---------- */

  function money(n) {
    return Number(n).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function currentMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function todayStr() {
    const d = new Date();
    return currentMonth() + '-' + String(d.getDate()).padStart(2, '0');
  }

  function shiftMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  let toastTimer;
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isErr);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function confirmBox(text) {
    return new Promise((resolve) => {
      const box = $('#confirm');
      $('#confirm-text').textContent = text;
      box.hidden = false;
      const done = (v) => { box.hidden = true; yes.onclick = no.onclick = null; resolve(v); };
      const yes = $('#confirm-yes'), no = $('#confirm-no');
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
    });
  }

  function isEditor() { return state.user && state.user.role === 'editor'; }

  // 登入 token 被後端拒絕時只重試一次,避免無限循環
  function relogin() {
    let tried = false;
    try { tried = sessionStorage.getItem('ledger_relogin') === '1'; } catch (e) { /* ignore */ }
    if (tried) {
      showError('LINE 登入憑證被後端拒絕。請檢查 Apps Script 指令碼屬性 LOGIN_CHANNEL_ID 是否為 LINE Login channel 的 Channel ID(即 LIFF ID 橫線前的數字)。');
      try { sessionStorage.removeItem('ledger_relogin'); } catch (e) { /* ignore */ }
      return;
    }
    try { sessionStorage.setItem('ledger_relogin', '1'); } catch (e) { /* ignore */ }
    liff.logout();
    setTimeout(() => liff.login(), 300);
  }

  function handleApiError(err) {
    if (err && err.code === 'BAD_TOKEN') {
      toast('登入已過期,重新登入中…', true);
      relogin();
      return;
    }
    toast((err && err.message) || '發生錯誤', true);
  }

  /* ---------- 畫面切換 ---------- */

  function showTab(name) {
    if (name === 'add' && !isEditor()) name = 'list';
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + name; });
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    if (name === 'list') loadList();
    if (name === 'pending') loadPending();
    window.scrollTo(0, 0);
  }

  function renderHeader() {
    $('#who').innerHTML = esc(state.user.name) +
      '<span class="role">' + (isEditor() ? '可編輯' : '唯讀') + '</span>';
    if (!isEditor()) $('#tabs button[data-tab=add]').hidden = true;
  }

  /* ---------- 表單 ---------- */

  function fillCategories() {
    const sel = $('#f-category');
    const prev = sel.value;
    sel.innerHTML = '';
    state.categories
      .filter((c) => c.type === state.type)
      .forEach((c) => {
        const o = document.createElement('option');
        o.value = o.textContent = c.name;
        sel.appendChild(o);
      });
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    $('#f-reimburse-box').hidden = state.type !== '支出';
  }

  function fillPayers() {
    const sel = $('#f-payer');
    sel.innerHTML = '';
    state.users.forEach((u) => {
      const o = document.createElement('option');
      o.value = o.textContent = u.name;
      sel.appendChild(o);
    });
    sel.value = state.user.name;
  }

  function setType(t) {
    state.type = t;
    document.querySelectorAll('#f-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
    fillCategories();
  }

  function resetForm() {
    state.editingId = null;
    $('#form-title').textContent = '記一筆';
    $('#f-submit').textContent = '送出';
    $('#f-cancel').hidden = true;
    $('#f-id').value = '';
    $('#f-amount').value = '';
    $('#f-note').value = '';
    $('#f-date').value = todayStr();
    $('#f-reimburse').checked = false;
    $('#f-payer-row').hidden = true;
    $('#f-payer').value = state.user.name;
    setType('支出');
  }

  function startEdit(r) {
    state.editingId = r.id;
    $('#form-title').textContent = '編輯 #' + r.id;
    $('#f-submit').textContent = '儲存修改';
    $('#f-cancel').hidden = false;
    setType(r.type);
    $('#f-amount').value = r.amount;
    $('#f-category').value = r.category;
    $('#f-note').value = r.note;
    $('#f-date').value = r.date;
    $('#f-reimburse').checked = r.reimburse;
    $('#f-payer-row').hidden = !r.reimburse;
    if (r.reimburse) $('#f-payer').value = r.payer;
    showTab('add');
  }

  function initForm() {
    $('#f-type').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-type]');
      if (b) setType(b.dataset.type);
    });
    $('#f-reimburse').addEventListener('change', (e) => {
      $('#f-payer-row').hidden = !e.target.checked;
    });
    $('#f-cancel').addEventListener('click', resetForm);

    $('#form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const record = {
        type: state.type,
        amount: $('#f-amount').value,
        category: $('#f-category').value,
        note: $('#f-note').value,
        date: $('#f-date').value,
        reimburse: state.type === '支出' && $('#f-reimburse').checked,
        payer: $('#f-payer').value,
      };
      if (!(Number(record.amount) > 0)) { toast('請輸入金額', true); return; }

      const btn = $('#f-submit');
      btn.disabled = true;
      try {
        let res;
        if (state.editingId) {
          res = await api('update', { id: state.editingId, record });
          toast('已更新 #' + res.record.id);
        } else {
          res = await api('add', { record });
          toast('已記錄 #' + res.record.id + ' ' + res.record.category + ' ' + money(res.record.amount));
        }
        state.listCache = {};
        const wasEditing = !!state.editingId;
        resetForm();
        if (wasEditing) showTab('list');
      } catch (err) {
        handleApiError(err);
      } finally {
        btn.disabled = false;
      }
    });

    fillPayers();
    resetForm();
  }

  /* ---------- 清單 ---------- */

  async function loadList(force) {
    const month = state.month;
    $('#m-month').value = month;
    const box = $('#list');
    if (!force && state.listCache[month]) { renderList(state.listCache[month]); return; }
    box.innerHTML = '<p class="empty">載入中…</p>';
    try {
      const res = await api('list', { month });
      state.listCache[month] = res;
      if (state.month === month) renderList(res);
    } catch (err) {
      handleApiError(err);
      box.innerHTML = '<p class="empty">載入失敗</p>';
    }
  }

  function renderList(res) {
    const records = res.records;
    let income = 0, expense = 0;
    records.forEach((r) => { if (r.type === '收入') income += r.amount; else expense += r.amount; });
    $('#t-income').textContent = money(income);
    $('#t-expense').textContent = money(expense);
    $('#t-balance').textContent = money(income - expense);
    const cum = Number(res.balanceToMonth || 0);
    $('#t-cum').textContent = money(cum);
    $('#t-cum').classList.toggle('neg', cum < 0);

    const box = $('#list');
    if (!records.length) { box.innerHTML = '<p class="empty">這個月還沒有記錄</p>'; return; }

    let html = '', lastDate = '';
    records.forEach((r) => {
      if (r.date !== lastDate) { html += '<div class="day">' + esc(r.date) + '</div>'; lastDate = r.date; }
      html += itemHtml(r, 'list');
    });
    box.innerHTML = html;
    bindItemOps(box, records);
  }

  function itemHtml(r, mode) {
    const isIn = r.type === '收入';
    let badge = '';
    if (r.reimburse) {
      badge = r.status === '已撥款'
        ? '<span class="badge done">已撥款</span>'
        : '<span class="badge pending">待撥款</span>';
    }
    let ops = '';
    if (isEditor()) {
      if (mode === 'pending') {
        ops = '<button type="button" class="settle" data-op="settle" data-id="' + r.id + '">已撥款</button>';
      } else {
        ops = '<button type="button" data-op="edit" data-id="' + r.id + '">編輯</button>' +
              '<button type="button" data-op="del" data-id="' + r.id + '">刪除</button>';
        if (r.reimburse && r.status === '已撥款') {
          ops += '<button type="button" data-op="unsettle" data-id="' + r.id + '">退回待撥</button>';
        }
      }
    }
    const sub = [r.note, mode === 'pending' ? r.date : '', r.reimburse ? '墊付:' + r.payer : '', '記錄:' + r.recorder]
      .filter(Boolean).join(' · ');
    return '<div class="item">' +
      '<div class="main"><div class="cat">#' + r.id + ' ' + esc(r.category) + badge + '</div>' +
      '<div class="note">' + esc(sub) + '</div></div>' +
      '<div class="amt ' + (isIn ? 'in' : 'out') + '">' + (isIn ? '+' : '-') + money(r.amount) + '</div>' +
      (ops ? '<div class="ops">' + ops + '</div>' : '') +
      '</div>';
  }

  function bindItemOps(box, records) {
    box.onclick = async (e) => {
      const b = e.target.closest('button[data-op]');
      if (!b) return;
      const id = Number(b.dataset.id);
      const r = records.find((x) => x.id === id);
      if (!r) return;

      if (b.dataset.op === 'edit') { startEdit(r); return; }

      if (b.dataset.op === 'del') {
        if (!(await confirmBox('確定刪除 #' + id + ' ' + r.category + ' ' + money(r.amount) + '?'))) return;
        b.disabled = true;
        try {
          await api('delete', { id });
          toast('已刪除 #' + id);
          state.listCache = {};
          loadList(true);
        } catch (err) { handleApiError(err); b.disabled = false; }
        return;
      }

      if (b.dataset.op === 'settle' || b.dataset.op === 'unsettle') {
        const settle = b.dataset.op === 'settle';
        if (settle && !(await confirmBox('確認 #' + id + ' ' + money(r.amount) + ' 已撥款給 ' + r.payer + '?'))) return;
        b.disabled = true;
        try {
          await api(settle ? 'settle' : 'unsettle', { id });
          toast(settle ? '#' + id + ' 已核銷' : '#' + id + ' 已退回待撥款');
          state.listCache = {};
          if (settle) loadPending(); else loadList(true);
        } catch (err) { handleApiError(err); b.disabled = false; }
      }
    };
  }

  function initList() {
    state.month = currentMonth();
    $('#m-month').addEventListener('change', (e) => { if (e.target.value) { state.month = e.target.value; loadList(); } });
    $('#m-prev').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); loadList(); });
    $('#m-next').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); loadList(); });
  }

  /* ---------- 請款 ---------- */

  async function loadPending() {
    const box = $('#pending');
    box.innerHTML = '<p class="empty">載入中…</p>';
    $('#p-summary').textContent = '';
    try {
      const res = await api('pending');
      renderPending(res.records);
    } catch (err) {
      handleApiError(err);
      box.innerHTML = '<p class="empty">載入失敗</p>';
    }
  }

  function renderPending(records) {
    const box = $('#pending');
    if (!records.length) {
      box.innerHTML = '<p class="empty">目前沒有待撥款的項目 🎉</p>';
      return;
    }
    const groups = {};
    let total = 0;
    records.forEach((r) => {
      (groups[r.payer] = groups[r.payer] || []).push(r);
      total += r.amount;
    });
    $('#p-summary').textContent = '共 ' + records.length + ' 筆,合計 ' + money(total);

    let html = '';
    Object.keys(groups).forEach((p) => {
      const sum = groups[p].reduce((s, r) => s + r.amount, 0);
      html += '<div class="payer-group"><h3><span>撥款給 ' + esc(p) + '</span><span>' + money(sum) + '</span></h3>';
      groups[p].forEach((r) => { html += itemHtml(r, 'pending'); });
      html += '</div>';
    });
    box.innerHTML = html;
    bindItemOps(box, records);
  }

  /* ---------- 啟動 ---------- */

  function showScreen(id) {
    ['screen-loading', 'screen-blocked', 'screen-error'].forEach((s) => { $('#' + s).hidden = s !== id; });
  }

  function showError(msg) {
    $('#error-text').textContent = msg;
    showScreen('screen-error');
  }

  async function main() {
    if (!CFG.LIFF_ID || !CFG.API_URL) {
      showError('尚未設定 config.js 的 LIFF_ID 與 API_URL');
      return;
    }
    try {
      await liff.init({ liffId: CFG.LIFF_ID });
    } catch (e) {
      showError('LIFF 初始化失敗:' + (e.message || e));
      return;
    }
    if (!liff.isLoggedIn()) {
      liff.login();
      return;
    }

    let me;
    try {
      me = await api('me');
    } catch (err) {
      if (err.code === 'NOT_ALLOWED') {
        $('#blocked-userid').textContent = err.userId || '';
        showScreen('screen-blocked');
      } else if (err.code === 'BAD_TOKEN') {
        relogin();
      } else {
        showError(err.message || '載入失敗');
      }
      return;
    }

    try { sessionStorage.removeItem('ledger_relogin'); } catch (e) { /* ignore */ }
    state.user = me.user;
    state.users = me.users;
    state.categories = me.categories;

    renderHeader();
    initForm();
    initList();
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

    $('#screen-loading').hidden = true;
    $('#app').hidden = false;
    $('#tabs').hidden = false;

    const page = new URLSearchParams(location.search).get('page') || 'add';
    showTab(['add', 'list', 'pending'].includes(page) ? page : 'add');
  }

  main();
})();
