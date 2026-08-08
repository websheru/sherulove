
(function () {
  'use strict';

  if (window.__SheruDevTools) {
    window.__SheruDevTools.toggle();
    return;
  }

  const MAX_ITEMS = 200;
  const state = {
    open: true,
    activeTab: 'network',
    network: [],
    console: [],
    errors: [],
    logs: [],
    storage: { local: [], session: [], cookies: [] },
    perf: { fps: 0, domNodes: 0, memory: null, since: Date.now() },
    filter: { q: '', method: 'all', status: 'all' },
    selectedNetworkId: null,
    selectedConsoleId: null,
    selectedErrorId: null,
    pickerOn: false,
    startedAt: performance.now(),
  };

  const original = {
    fetch: window.fetch ? window.fetch.bind(window) : null,
    console: {},
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    xhrSetHeader: XMLHttpRequest.prototype.setRequestHeader,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
  };

  const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
  methods.forEach((m) => { original.console[m] = console[m].bind(console); });

  function now() {
    try { return new Date().toLocaleTimeString(); } catch (_) { return ''; }
  }

  function uid(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
  }

  function clamp(text, max = 6000) {
    text = String(text == null ? '' : text);
    return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more chars)` : text;
  }

  function safeText(v) {
    try {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`.trim();
      if (v instanceof URLSearchParams) return v.toString();
      if (v instanceof FormData) {
        const arr = [];
        v.forEach((value, key) => arr.push(`${key}=${typeof value === 'string' ? value : '[file]'}`));
        return arr.join('&');
      }
      if (v instanceof Blob) return `[Blob ${v.type || 'unknown'} ${v.size || 0} bytes]`;
      if (v instanceof ArrayBuffer) return `[ArrayBuffer ${v.byteLength} bytes]`;
      if (ArrayBuffer.isView(v)) return `[TypedArray ${v.byteLength} bytes]`;
      if (v instanceof Request) return `[Request ${v.method} ${v.url}]`;
      if (v instanceof Response) return `[Response ${v.status} ${v.url || ''}]`;
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    } catch (e) {
      try { return String(v); } catch (_) { return '[Unserializable]'; }
    }
  }

  function safeJSON(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
      return null;
    }
  }

  function toPlainHeaders(headers) {
    const out = {};
    try {
      if (!headers) return out;
      if (headers instanceof Headers) {
        headers.forEach((v, k) => { out[k] = v; });
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => { out[String(k)] = String(v); });
      } else if (typeof headers === 'object') {
        Object.keys(headers).forEach((k) => { out[String(k)] = String(headers[k]); });
      }
    } catch (_) {}
    return out;
  }

  function normalizeBody(body) {
    try {
      if (body == null) return '';
      if (typeof body === 'string') return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) {
        const arr = [];
        body.forEach((value, key) => arr.push(`${key}=${typeof value === 'string' ? value : '[file]'}`));
        return arr.join('&');
      }
      if (body instanceof Blob) return `[Blob ${body.type || ''} ${body.size || 0} bytes]`;
      if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength} bytes]`;
      if (ArrayBuffer.isView(body)) return `[TypedArray ${body.byteLength} bytes]`;
      if (typeof body === 'object') return JSON.stringify(body);
      return String(body);
    } catch (e) {
      return String(body);
    }
  }

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function absURL(u) {
    try { return new URL(String(u), location.href).href; } catch (_) { return String(u); }
  }

  function jsonPretty(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return null; }
  }

  function shellQuote(s) {
    return `'${String(s == null ? '' : s).replace(/'/g, `'\"'\"'`)}'`;
  }

  function buildCurl(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = absURL(req.url);
    const parts = [`curl --compressed -X ${method} ${shellQuote(url)}`];

    const headers = req.reqHeaders || {};
    Object.keys(headers).forEach((k) => {
      if (!k) return;
      const v = headers[k];
      if (v == null) return;
      parts.push(`-H ${shellQuote(`${k}: ${String(v)}`)}`);
    });

    const body = normalizeBody(req.requestBody);
    if (body && !/^(GET|HEAD)$/i.test(method)) {
      parts.push(`--data-raw ${shellQuote(body)}`);
    }

    return parts.join(' \\\n  ');
  }

  function copyText(text) {
    const value = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).catch(() => fallbackCopy(value));
    }
    return fallbackCopy(value);
  }

  function fallbackCopy(value) {
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        ok ? resolve() : reject(new Error('Copy failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  function fmtBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '-';
    const n = Number(bytes);
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function truncateUrl(url) {
    const s = String(url || '');
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  }

  function addNetwork(entry) {
    state.network.unshift(Object.assign({
      id: uid('net'),
      expanded: false,
      copied: false,
    }, entry));
    if (state.network.length > MAX_ITEMS) state.network.length = MAX_ITEMS;
    render();
  }

  function addConsole(level, args) {
    state.console.unshift({
      id: uid('con'),
      level,
      time: now(),
      args: args.map(safeText),
    });
    if (state.console.length > MAX_ITEMS) state.console.length = MAX_ITEMS;
    render();
  }

  function addError(type, data) {
    state.errors.unshift(Object.assign({
      id: uid('err'),
      time: now(),
      type,
    }, data));
    if (state.errors.length > MAX_ITEMS) state.errors.length = MAX_ITEMS;
    render();
  }

  function captureResponseMeta(res, meta) {
    try {
      res.clone().text().then((text) => {
        const bytes = text ? new Blob([text]).size : 0;
        addNetwork({
          url: meta.url,
          method: meta.method,
          reqHeaders: meta.reqHeaders,
          requestBody: meta.requestBody,
          responseHeaders: toPlainHeaders(res.headers),
          status: res.status,
          statusText: res.statusText || (res.ok ? 'OK' : 'ERR'),
          ok: res.ok,
          duration: Math.round(performance.now() - meta.start),
          time: now(),
          responseText: text,
          responsePretty: jsonPretty(text),
          responseSize: bytes,
        });
      }).catch((err) => {
        addNetwork({
          url: meta.url,
          method: meta.method,
          reqHeaders: meta.reqHeaders,
          requestBody: meta.requestBody,
          responseHeaders: toPlainHeaders(res.headers),
          status: res.status,
          statusText: res.statusText || 'ERR',
          ok: res.ok,
          duration: Math.round(performance.now() - meta.start),
          time: now(),
          responseText: `[read error] ${err}`,
          responsePretty: null,
          responseSize: null,
        });
      });
    } catch (err) {
      addNetwork({
        url: meta.url,
        method: meta.method,
        reqHeaders: meta.reqHeaders,
        requestBody: meta.requestBody,
        status: res.status,
        statusText: 'ERR',
        ok: false,
        duration: Math.round(performance.now() - meta.start),
        time: now(),
        responseText: `[clone error] ${err}`,
        responsePretty: null,
        responseSize: null,
      });
    }
  }

  function injectStyles(root) {
    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing: border-box; }
      .sd-root {
        position: fixed; inset: auto 12px 12px auto; z-index: 2147483647;
        width: min(96vw, 980px); height: min(82vh, 760px);
        background: rgba(10,12,18,.98); color: #E8EEF8;
        border: 1px solid rgba(116,134,166,.24);
        border-radius: 22px; overflow: hidden;
        box-shadow: 0 28px 90px rgba(0,0,0,.55);
        display: flex; flex-direction: column;
        backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      }
      .sd-topbar {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 14px;
        border-bottom: 1px solid rgba(116,134,166,.15);
        background: linear-gradient(180deg, rgba(17,21,32,.96), rgba(12,14,21,.96));
      }
      .sd-brand {
        display: flex; flex-direction: column; gap: 2px; min-width: 0;
      }
      .sd-title {
        display: flex; align-items: center; gap: 8px; min-width: 0;
        font-size: 14px; font-weight: 800; letter-spacing: .2px;
      }
      .sd-badge {
        font-size: 11px; font-weight: 700;
        color: #A7F3D0; background: rgba(34,197,94,.12);
        border: 1px solid rgba(34,197,94,.22);
        border-radius: 999px; padding: 2px 8px;
      }
      .sd-subtitle {
        font-size: 11px; color: rgba(232,238,248,.65); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .sd-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
      .sd-btn, .sd-tab, .sd-chip, .sd-input, .sd-select, .sd-mini {
        appearance: none; border: 1px solid rgba(116,134,166,.18);
        background: rgba(255,255,255,.04); color: #E8EEF8;
        border-radius: 14px; font: inherit;
      }
      .sd-btn, .sd-mini {
        padding: 9px 12px; cursor: pointer; line-height: 1;
        transition: transform .12s ease, background .12s ease, border-color .12s ease;
      }
      .sd-btn:hover, .sd-mini:hover, .sd-tab:hover { background: rgba(255,255,255,.08); }
      .sd-btn:active, .sd-mini:active, .sd-tab:active { transform: translateY(1px); }
      .sd-body { display: grid; grid-template-columns: 240px 1fr; min-height: 0; flex: 1; }
      .sd-side {
        padding: 14px; border-right: 1px solid rgba(116,134,166,.12);
        overflow: auto; background: rgba(255,255,255,.015);
      }
      .sd-main { min-width: 0; display: flex; flex-direction: column; min-height: 0; }
      .sd-tabs {
        display: grid; grid-template-columns: repeat(5, 1fr);
        gap: 8px; padding: 12px; border-bottom: 1px solid rgba(116,134,166,.12);
        background: rgba(255,255,255,.01);
      }
      .sd-tab {
        padding: 10px 8px; cursor: pointer;
        font-weight: 700; font-size: 12px;
        display: flex; align-items: center; justify-content: center;
      }
      .sd-tab.active {
        background: linear-gradient(180deg, rgba(59,130,246,.22), rgba(59,130,246,.12));
        border-color: rgba(96,165,250,.36);
        color: #DDEBFF;
      }
      .sd-content { min-height: 0; flex: 1; overflow: auto; padding: 14px; }
      .sd-card {
        border: 1px solid rgba(116,134,166,.16);
        background: rgba(255,255,255,.03);
        border-radius: 18px;
        padding: 14px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.04);
      }
      .sd-section { display: flex; flex-direction: column; gap: 12px; }
      .sd-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
      .sd-row.tight { gap: 8px; }
      .sd-input, .sd-select {
        padding: 10px 12px; outline: none; min-width: 0;
        background: rgba(255,255,255,.035);
      }
      .sd-input::placeholder { color: rgba(232,238,248,.45); }
      .sd-kpi-grid {
        display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px;
      }
      .sd-kpi {
        border-radius: 18px; padding: 14px;
        background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.025));
        border: 1px solid rgba(116,134,166,.14);
      }
      .sd-kpi-label { color: rgba(232,238,248,.6); font-size: 11px; margin-bottom: 8px; }
      .sd-kpi-value { font-size: 18px; font-weight: 800; letter-spacing: .2px; }
      .sd-list { display: flex; flex-direction: column; gap: 10px; }
      .sd-item {
        border: 1px solid rgba(116,134,166,.16); border-radius: 18px;
        background: rgba(255,255,255,.03);
        overflow: hidden;
      }
      .sd-item-head {
        padding: 12px 12px 10px; display: flex; gap: 10px; align-items: flex-start; justify-content: space-between;
      }
      .sd-status {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 999px;
      }
      .sd-ok { color: #A7F3D0; background: rgba(34,197,94,.12); border: 1px solid rgba(34,197,94,.2); }
      .sd-bad { color: #FCA5A5; background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.2); }
      .sd-warn { color: #FDE68A; background: rgba(245,158,11,.12); border: 1px solid rgba(245,158,11,.2); }
      .sd-meta { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      .sd-meta-top { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .sd-method { font-weight: 800; }
      .sd-url { color: rgba(232,238,248,.92); word-break: break-all; }
      .sd-muted { color: rgba(232,238,248,.62); font-size: 11px; }
      .sd-item-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .sd-pills { display: flex; gap: 6px; flex-wrap: wrap; }
      .sd-pill {
        font-size: 11px; color: rgba(232,238,248,.72);
        border: 1px solid rgba(116,134,166,.15);
        background: rgba(255,255,255,.03);
        padding: 5px 8px; border-radius: 999px;
      }
      .sd-details {
        border-top: 1px solid rgba(116,134,166,.12);
        padding: 12px;
        display: grid; gap: 12px;
      }
      .sd-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .sd-pre {
        margin: 0; white-space: pre-wrap; word-break: break-word;
        max-height: 320px; overflow: auto; font-size: 12px;
        padding: 12px; border-radius: 14px;
        background: rgba(0,0,0,.18); border: 1px solid rgba(116,134,166,.10);
      }
      .sd-toolbar {
        display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
        padding: 12px; border-bottom: 1px solid rgba(116,134,166,.12);
      }
      .sd-spacer { flex: 1; }
      .sd-split {
        display: grid; grid-template-columns: 1.2fr .8fr; gap: 12px; min-height: 0;
      }
      .sd-console-line {
        border-bottom: 1px dashed rgba(116,134,166,.12); padding: 10px 0;
      }
      .sd-console-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
      .sd-dot { width: 8px; height: 8px; border-radius: 999px; background: #93C5FD; display: inline-block; }
      .sd-dot.warn { background: #FBBF24; } .sd-dot.error { background: #FB7185; } .sd-dot.debug { background: #A78BFA; }
      .sd-empty {
        color: rgba(232,238,248,.6); text-align: center; padding: 24px 12px;
        border: 1px dashed rgba(116,134,166,.18); border-radius: 18px;
      }
      .sd-keyval { display: grid; grid-template-columns: 160px 1fr; gap: 8px; padding: 8px 0; border-bottom: 1px solid rgba(116,134,166,.08); }
      .sd-key { color: rgba(232,238,248,.65); }
      .sd-val { word-break: break-word; }
      .sd-highlight {
        position: fixed; pointer-events: none; z-index: 2147483646;
        border: 2px solid rgba(59,130,246,.92);
        background: rgba(59,130,246,.12);
        border-radius: 8px; display: none;
      }
      .sd-picker-hint {
        position: fixed; inset: auto 12px 12px 12px; z-index: 2147483647;
        padding: 10px 12px; border-radius: 14px;
        background: rgba(8,10,14,.95); border: 1px solid rgba(116,134,166,.18);
        color: #E8EEF8; display: none;
      }
      .sd-mini-panel {
        border: 1px solid rgba(116,134,166,.14); border-radius: 18px;
        padding: 12px; background: rgba(255,255,255,.025);
      }
      @media (max-width: 860px) {
        .sd-root {
          inset: 0; width: 100vw; height: 100vh; border-radius: 0;
        }
        .sd-body { grid-template-columns: 1fr; }
        .sd-side { display: none; }
        .sd-tabs { grid-template-columns: repeat(3, 1fr); }
        .sd-kpi-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
        .sd-split, .sd-grid2 { grid-template-columns: 1fr; }
      }
      @media (max-width: 480px) {
        .sd-topbar { padding: 10px 10px; gap: 8px; }
        .sd-actions { gap: 6px; }
        .sd-btn, .sd-mini, .sd-input, .sd-select { border-radius: 12px; }
        .sd-tabs { padding: 10px; gap: 6px; }
        .sd-content { padding: 10px; }
        .sd-item-head { flex-direction: column; }
        .sd-item-actions { justify-content: flex-start; }
      }
    `;
    root.appendChild(style);
  }

  function createUI() {
    const host = document.createElement('div');
    host.id = '__sheru_devtools_host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    injectStyles(shadow);

    shadow.innerHTML = `
      <div class="sd-root" role="dialog" aria-label="Sheru DevTools">
        <div class="sd-topbar">
          <div class="sd-brand">
            <div class="sd-title">🐺 Sheru DevTools <span class="sd-badge">mobile first</span></div>
            <div class="sd-subtitle">Network • Console • Storage • DOM • Errors • Performance</div>
          </div>
          <div class="sd-actions">
            <button class="sd-btn" data-act="reload">Reload</button>
            <button class="sd-btn" data-act="hide">Hide</button>
            <button class="sd-btn" data-act="close">Close</button>
          </div>
        </div>
        <div class="sd-body">
          <aside class="sd-side">
            <div class="sd-section">
              <div class="sd-card">
                <div class="sd-row tight">
                  <input class="sd-input" data-q="search" type="search" placeholder="Search requests / logs / errors" style="flex:1; min-width: 0;">
                </div>
                <div class="sd-row tight" style="margin-top:8px">
                  <select class="sd-select" data-q="method" style="flex:1">
                    <option value="all">All methods</option>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                    <option value="DELETE">DELETE</option>
                    <option value="OPTIONS">OPTIONS</option>
                  </select>
                  <select class="sd-select" data-q="status" style="flex:1">
                    <option value="all">All status</option>
                    <option value="2xx">2xx</option>
                    <option value="4xx">4xx</option>
                    <option value="5xx">5xx</option>
                    <option value="err">Errors</option>
                  </select>
                </div>
                <div class="sd-row tight" style="margin-top:8px">
                  <button class="sd-mini" data-act="copyAllCurl">Copy all cURL</button>
                  <button class="sd-mini" data-act="refreshStorage">Refresh storage</button>
                </div>
              </div>

              <div class="sd-card">
                <div class="sd-muted" style="margin-bottom:8px">Quick stats</div>
                <div class="sd-kpi-grid">
                  <div class="sd-kpi"><div class="sd-kpi-label">Network</div><div class="sd-kpi-value" data-metric="network">0</div></div>
                  <div class="sd-kpi"><div class="sd-kpi-label">Console</div><div class="sd-kpi-value" data-metric="console">0</div></div>
                  <div class="sd-kpi"><div class="sd-kpi-label">Errors</div><div class="sd-kpi-value" data-metric="errors">0</div></div>
                  <div class="sd-kpi"><div class="sd-kpi-label">DOM Nodes</div><div class="sd-kpi-value" data-metric="nodes">0</div></div>
                </div>
              </div>

              <div class="sd-card">
                <div class="sd-muted" style="margin-bottom:8px">Tabs</div>
                <div class="sd-list" style="gap:8px">
                  <button class="sd-btn" data-tab="network">🌐 Network</button>
                  <button class="sd-btn" data-tab="console">🖥️ Console</button>
                  <button class="sd-btn" data-tab="storage">💾 Storage</button>
                  <button class="sd-btn" data-tab="dom">🧩 DOM</button>
                  <button class="sd-btn" data-tab="errors">🐛 Errors</button>
                  <button class="sd-btn" data-tab="perf">⚡ Performance</button>
                </div>
              </div>
            </div>
          </aside>

          <main class="sd-main">
            <div class="sd-tabs">
              <button class="sd-tab" data-tab="network">Network</button>
              <button class="sd-tab" data-tab="console">Console</button>
              <button class="sd-tab" data-tab="storage">Storage</button>
              <button class="sd-tab" data-tab="dom">DOM</button>
              <button class="sd-tab" data-tab="errors">Errors</button>
              <button class="sd-tab" data-tab="perf">Performance</button>
            </div>
            <div class="sd-content" data-view="content"></div>
          </main>
        </div>
        <div class="sd-highlight" data-layer="highlight"></div>
        <div class="sd-picker-hint" data-layer="hint"></div>
      </div>
    `;

    return { host, shadow };
  }

  const ui = createUI();
  const root = ui.shadow;
  const els = {
    content: root.querySelector('[data-view="content"]'),
    highlight: root.querySelector('[data-layer="highlight"]'),
    hint: root.querySelector('[data-layer="hint"]'),
  };

  function q(sel) { return root.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }

  function updateStats() {
    const nodes = document.getElementsByTagName('*').length;
    state.perf.domNodes = nodes;
    const mem = performance.memory ? {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize,
      limit: performance.memory.jsHeapSizeLimit
    } : null;
    state.perf.memory = mem;

    const metrics = {
      network: state.network.length,
      console: state.console.length,
      errors: state.errors.length,
      nodes: nodes,
    };
    Object.keys(metrics).forEach((k) => {
      const el = q(`[data-metric="${k}"]`);
      if (el) el.textContent = String(metrics[k]);
    });
  }

  function copyAllCurl() {
    const text = state.network.map(buildCurl).join('\n\n');
    return copyText(text);
  }

  function setTab(name) {
    state.activeTab = name;
    qa('[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === name);
    });
    render();
  }

  function getFilteredNetwork() {
    const qx = String(state.filter.q || '').trim().toLowerCase();
    return state.network.filter((item) => {
      const hay = [
        item.url, item.method, item.status, item.statusText,
        item.responseText, item.requestBody,
        JSON.stringify(item.reqHeaders || {}),
        JSON.stringify(item.responseHeaders || {}),
      ].join(' ').toLowerCase();

      if (qx && hay.indexOf(qx) === -1) return false;

      if (state.filter.method !== 'all' && String(item.method || '').toUpperCase() !== state.filter.method) {
        return false;
      }

      if (state.filter.status !== 'all') {
        if (state.filter.status === 'err' && item.status !== 'ERR') return false;
        const status = Number(item.status);
        if (state.filter.status === '2xx' && !(status >= 200 && status < 300)) return false;
        if (state.filter.status === '4xx' && !(status >= 400 && status < 500)) return false;
        if (state.filter.status === '5xx' && !(status >= 500 && status < 600)) return false;
      }

      return true;
    });
  }

  function currentSelection() {
    if (state.activeTab === 'network') return state.network.find((x) => x.id === state.selectedNetworkId) || null;
    if (state.activeTab === 'console') return state.console.find((x) => x.id === state.selectedConsoleId) || null;
    if (state.activeTab === 'errors') return state.errors.find((x) => x.id === state.selectedErrorId) || null;
    return null;
  }

  function renderNetwork() {
    const items = getFilteredNetwork();
    if (!items.length) {
      return `<div class="sd-empty">No network requests captured yet. Trigger a fetch/XHR after loading this tool.</div>`;
    }

    return `
      <div class="sd-section">
        ${items.map((item) => {
          const selected = state.selectedNetworkId === item.id;
          const statusClass = item.status === 'ERR' ? 'sd-bad' : (item.ok ? 'sd-ok' : ((Number(item.status) >= 400 || Number(item.status) === 0) ? 'sd-bad' : 'sd-warn'));
          const showSize = item.responseSize != null ? fmtBytes(item.responseSize) : '-';
          return `
            <div class="sd-item" style="${selected ? 'border-color: rgba(96,165,250,.42); box-shadow: 0 0 0 1px rgba(96,165,250,.15) inset;' : ''}">
              <div class="sd-item-head">
                <div class="sd-meta">
                  <div class="sd-meta-top">
                    <span class="sd-status ${statusClass}">${esc(String(item.statusText || ''))}</span>
                    <span class="sd-pill sd-method">${esc(String(item.method || 'GET').toUpperCase())}</span>
                    <span class="sd-pill">${esc(String(item.status))}</span>
                    <span class="sd-pill">${esc(String(item.duration || 0))} ms</span>
                    <span class="sd-pill">${esc(showSize)}</span>
                  </div>
                  <div class="sd-url">${esc(truncateUrl(item.url))}</div>
                  <div class="sd-muted">${esc(item.time || '')}</div>
                </div>
                <div class="sd-item-actions">
                  <button class="sd-mini" data-act="selNet" data-id="${esc(item.id)}">${selected ? 'Open' : 'Inspect'}</button>
                  <button class="sd-mini" data-act="copyUrl" data-id="${esc(item.id)}">Copy URL</button>
                  <button class="sd-mini" data-act="copyResp" data-id="${esc(item.id)}">Copy Response</button>
                  <button class="sd-mini" data-act="copyCurl" data-id="${esc(item.id)}">Copy cURL</button>
                  <button class="sd-mini" data-act="replay" data-id="${esc(item.id)}">Replay</button>
                </div>
              </div>
              ${selected ? renderNetworkDetails(item) : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderNetworkDetails(item) {
    const reqHeaders = item.reqHeaders || {};
    const resHeaders = item.responseHeaders || {};
    const body = item.responsePretty || item.responseText || '';
    const requestBody = normalizeBody(item.requestBody);

    return `
      <div class="sd-details">
        <div class="sd-grid2">
          <div class="sd-mini-panel">
            <div class="sd-muted" style="margin-bottom:8px">Request</div>
            <div class="sd-keyval"><div class="sd-key">Method</div><div class="sd-val">${esc(item.method)}</div></div>
            <div class="sd-keyval"><div class="sd-key">URL</div><div class="sd-val">${esc(item.url)}</div></div>
            <div class="sd-keyval"><div class="sd-key">Headers</div><div class="sd-val"><pre class="sd-pre">${esc(JSON.stringify(reqHeaders, null, 2))}</pre></div></div>
            <div class="sd-keyval"><div class="sd-key">Body</div><div class="sd-val"><pre class="sd-pre">${esc(clamp(requestBody, 5000))}</pre></div></div>
          </div>
          <div class="sd-mini-panel">
            <div class="sd-muted" style="margin-bottom:8px">Response</div>
            <div class="sd-keyval"><div class="sd-key">Status</div><div class="sd-val">${esc(String(item.status))} ${esc(String(item.statusText || ''))}</div></div>
            <div class="sd-keyval"><div class="sd-key">Duration</div><div class="sd-val">${esc(String(item.duration || 0))} ms</div></div>
            <div class="sd-keyval"><div class="sd-key">Headers</div><div class="sd-val"><pre class="sd-pre">${esc(JSON.stringify(resHeaders, null, 2))}</pre></div></div>
            <div class="sd-keyval"><div class="sd-key">Body</div><div class="sd-val"><pre class="sd-pre">${esc(clamp(body, 8000))}</pre></div></div>
          </div>
        </div>
        <div class="sd-row">
          <button class="sd-mini" data-act="toggleNet" data-id="${esc(item.id)}">${item.expanded ? 'Show less' : 'Show more'}</button>
          <button class="sd-mini" data-act="copyNetCurl" data-id="${esc(item.id)}">Copy cURL</button>
          <button class="sd-mini" data-act="copyNetResp" data-id="${esc(item.id)}">Copy response</button>
        </div>
        ${item.expanded ? `<div class="sd-mini-panel"><pre class="sd-pre">${esc(clamp(item.responseText || '', 20000))}</pre></div>` : ''}
      </div>
    `;
  }

  function renderConsole() {
    if (!state.console.length) {
      return `<div class="sd-empty">No console output captured yet.</div>`;
    }
    return `
      <div class="sd-section">
        ${state.console.map((item) => {
          const dotClass = item.level === 'error' ? 'error' : (item.level === 'warn' ? 'warn' : (item.level === 'debug' ? 'debug' : ''));
          const selected = state.selectedConsoleId === item.id;
          return `
            <div class="sd-item" style="${selected ? 'border-color: rgba(96,165,250,.42);' : ''}">
              <div class="sd-item-head">
                <div class="sd-meta">
                  <div class="sd-meta-top">
                    <span class="sd-pill"><span class="sd-dot ${dotClass}"></span> ${esc(item.level.toUpperCase())}</span>
                    <span class="sd-pill">${esc(item.time)}</span>
                  </div>
                  <div class="sd-muted">${esc(item.args.join(' '))}</div>
                </div>
                <div class="sd-item-actions">
                  <button class="sd-mini" data-act="selCon" data-id="${esc(item.id)}">Inspect</button>
                  <button class="sd-mini" data-act="copyCon" data-id="${esc(item.id)}">Copy</button>
                </div>
              </div>
              ${selected ? `<div class="sd-details"><pre class="sd-pre">${esc(item.args.join('\n'))}</pre></div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderStorage() {
    const refresh = () => syncStorage();
    const local = state.storage.local;
    const session = state.storage.session;
    const cookies = state.storage.cookies;

    function renderPairs(list, type) {
      if (!list.length) return `<div class="sd-empty">No ${type} items.</div>`;
      return list.map(([k, v]) => `
        <div class="sd-keyval">
          <div class="sd-key">${esc(k)}</div>
          <div class="sd-val"><pre class="sd-pre">${esc(clamp(v, 5000))}</pre></div>
        </div>
      `).join('');
    }

    return `
      <div class="sd-section">
        <div class="sd-row">
          <button class="sd-mini" data-act="refreshStorage">Refresh</button>
          <button class="sd-mini" data-act="copyStorage">Copy JSON</button>
        </div>
        <div class="sd-split">
          <div class="sd-mini-panel">
            <div class="sd-muted" style="margin-bottom:8px">Local Storage</div>
            ${renderPairs(local, 'local storage')}
          </div>
          <div class="sd-mini-panel">
            <div class="sd-muted" style="margin-bottom:8px">Session Storage</div>
            ${renderPairs(session, 'session storage')}
          </div>
        </div>
        <div class="sd-mini-panel">
          <div class="sd-muted" style="margin-bottom:8px">Cookies</div>
          ${renderPairs(cookies, 'cookies')}
        </div>
      </div>
    `;
  }

  function renderDOM() {
    return `
      <div class="sd-section">
        <div class="sd-row">
          <button class="sd-mini" data-act="pickElement">${state.pickerOn ? 'Cancel picker' : 'Pick element'}</button>
          <button class="sd-mini" data-act="copyDom">Copy selected info</button>
        </div>
        <div class="sd-mini-panel">
          <div class="sd-muted" style="margin-bottom:8px">Selected element</div>
          ${state.selectedElement ? renderSelectedElement(state.selectedElement) : '<div class="sd-empty">Tap “Pick element” then tap any element on the page.</div>'}
        </div>
      </div>
    `;
  }

  function getElementPath(el) {
    if (!el || !el.tagName) return '-';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      if (node.id) part += `#${node.id}`;
      if (node.className && typeof node.className === 'string') {
        const cls = node.className.trim().split(/\s+/).slice(0, 3).filter(Boolean).join('.');
        if (cls) part += `.${cls}`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function renderSelectedElement(el) {
    const attrs = Array.from(el.attributes || []).map(a => [a.name, a.value]);
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const computed = window.getComputedStyle ? getComputedStyle(el) : null;

    const kv = [
      ['Tag', el.tagName ? el.tagName.toLowerCase() : '-'],
      ['Path', getElementPath(el)],
      ['Text', clamp((el.innerText || el.textContent || '').trim(), 1500)],
      ['Size', `${Math.round(rect.width)} × ${Math.round(rect.height)}`],
      ['Position', `${Math.round(rect.left)}, ${Math.round(rect.top)}`],
      ['Classes', el.className || '-'],
      ['ID', el.id || '-'],
    ];

    return `
      <div class="sd-section">
        ${kv.map(([k, v]) => `<div class="sd-keyval"><div class="sd-key">${esc(k)}</div><div class="sd-val">${esc(v)}</div></div>`).join('')}
        <div class="sd-grid2">
          <div>
            <div class="sd-muted" style="margin:8px 0">Attributes</div>
            <pre class="sd-pre">${esc(JSON.stringify(Object.fromEntries(attrs), null, 2))}</pre>
          </div>
          <div>
            <div class="sd-muted" style="margin:8px 0">Computed (top)</div>
            <pre class="sd-pre">${esc(computed ? [
              `display: ${computed.display}`,
              `position: ${computed.position}`,
              `width: ${computed.width}`,
              `height: ${computed.height}`,
              `padding: ${computed.padding}`,
              `margin: ${computed.margin}`,
              `color: ${computed.color}`,
              `background: ${computed.backgroundColor}`,
              `font: ${computed.font}`,
            ].join('\n') : 'n/a')}</pre>
          </div>
        </div>
      </div>
    `;
  }

  function renderErrors() {
    if (!state.errors.length) {
      return `<div class="sd-empty">No errors captured yet.</div>`;
    }
    return `
      <div class="sd-section">
        ${state.errors.map((item) => {
          const selected = state.selectedErrorId === item.id;
          return `
            <div class="sd-item" style="${selected ? 'border-color: rgba(96,165,250,.42);' : ''}">
              <div class="sd-item-head">
                <div class="sd-meta">
                  <div class="sd-meta-top">
                    <span class="sd-status sd-bad">${esc(item.type)}</span>
                    <span class="sd-pill">${esc(item.time)}</span>
                  </div>
                  <div class="sd-muted">${esc(item.message || '')}</div>
                </div>
                <div class="sd-item-actions">
                  <button class="sd-mini" data-act="selErr" data-id="${esc(item.id)}">Inspect</button>
                  <button class="sd-mini" data-act="copyErr" data-id="${esc(item.id)}">Copy</button>
                </div>
              </div>
              ${selected ? `<div class="sd-details"><pre class="sd-pre">${esc(item.stack || item.reason || item.message || '')}</pre></div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderPerf() {
    const mem = state.perf.memory;
    return `
      <div class="sd-section">
        <div class="sd-kpi-grid">
          <div class="sd-kpi"><div class="sd-kpi-label">FPS</div><div class="sd-kpi-value">${esc(String(state.perf.fps || 0))}</div></div>
          <div class="sd-kpi"><div class="sd-kpi-label">Network</div><div class="sd-kpi-value">${esc(String(state.network.length))}</div></div>
          <div class="sd-kpi"><div class="sd-kpi-label">DOM Nodes</div><div class="sd-kpi-value">${esc(String(state.perf.domNodes || 0))}</div></div>
          <div class="sd-kpi"><div class="sd-kpi-label">Memory</div><div class="sd-kpi-value">${esc(mem ? fmtBytes(mem.used) : 'n/a')}</div></div>
        </div>
        <div class="sd-mini-panel">
          <div class="sd-muted" style="margin-bottom:8px">Session</div>
          <div class="sd-keyval"><div class="sd-key">Uptime</div><div class="sd-val">${esc(String(Math.round((Date.now() - state.perf.since) / 1000)))} s</div></div>
          <div class="sd-keyval"><div class="sd-key">Memory used</div><div class="sd-val">${esc(mem ? fmtBytes(mem.used) : 'n/a')}</div></div>
          <div class="sd-keyval"><div class="sd-key">Memory total</div><div class="sd-val">${esc(mem ? fmtBytes(mem.total) : 'n/a')}</div></div>
          <div class="sd-keyval"><div class="sd-key">Memory limit</div><div class="sd-val">${esc(mem ? fmtBytes(mem.limit) : 'n/a')}</div></div>
        </div>
      </div>
    `;
  }

  function renderContent() {
    if (state.activeTab === 'network') return renderNetwork();
    if (state.activeTab === 'console') return renderConsole();
    if (state.activeTab === 'storage') return renderStorage();
    if (state.activeTab === 'dom') return renderDOM();
    if (state.activeTab === 'errors') return renderErrors();
    if (state.activeTab === 'perf') return renderPerf();
    return '<div class="sd-empty">Unknown tab.</div>';
  }

  function render() {
    qa('.sd-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === state.activeTab);
    });
    els.content.innerHTML = renderContent();
    updateStats();
    bindTabActions();
  }

  function bindTabActions() {
    qa('[data-act="selNet"]').forEach((btn) => {
      btn.onclick = () => { state.selectedNetworkId = btn.getAttribute('data-id'); render(); };
    });
    qa('[data-act="toggleNet"]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.getAttribute('data-id');
        const item = state.network.find((x) => x.id === id);
        if (item) item.expanded = !item.expanded;
        render();
      };
    });
    qa('[data-act="copyNetCurl"]').forEach((btn) => {
      btn.onclick = () => {
        const item = state.network.find((x) => x.id === btn.getAttribute('data-id'));
        if (item) copyText(buildCurl(item)).then(() => toast('cURL copied'));
      };
    });
    qa('[data-act="copyNetResp"]').forEach((btn) => {
      btn.onclick = () => {
        const item = state.network.find((x) => x.id === btn.getAttribute('data-id'));
        if (item) copyText(item.responseText || '').then(() => toast('Response copied'));
      };
    });
    qa('[data-act="copyUrl"]').forEach((btn) => {
      btn.onclick = () => {
        const item = state.network.find((x) => x.id === btn.getAttribute('data-id'));
        if (item) copyText(item.url || '').then(() => toast('URL copied'));
      };
    });
    qa('[data-act="copyResp"]').forEach((btn) => {
      btn.onclick = () => {
        const item = state.network.find((x) => x.id === btn.getAttribute('data-id'));
        if (item) copyText(item.responseText || '').then(() => toast('Response copied'));
      };
    });
    qa('[data-act="copyCurl"]').forEach((btn) => {
      btn.onclick = () => {
        const item = state.network.find((x) => x.id === btn.getAttribute('data-id'));
        if (item) copyText(buildCurl(item)).then(() => toast('cURL copied'));
      };
    });
    qa('[data-act="replay"]').forEach((btn) => {
      btn.onclick = () => {
        const item = state.network.find((x) => x.id === btn.getAttribute('data-id'));
        if (!item) return;
        replayRequest(item);
      };
    });
    qa('[data-act="selCon"]').forEach((btn) => {
      btn.onclick = () => { state.selectedConsoleId = btn.getAttribute('data-id'); render(); };
    });
    qa('[data-act="copyCon"]').forEach((btn) => {
      btn.onclick = () => {
        const item = state.console.find((x) => x.id === btn.getAttribute('data-id'));
        if (item) copyText(item.args.join('\n')).then(() => toast('Copied'));
      };
    });
    qa('[data-act="selErr"]').forEach((btn) => {
      btn.onclick = () => { state.selectedErrorId = btn.getAttribute('data-id'); render(); };
    });
    qa('[data-act="copyErr"]').forEach((btn) => {
      btn.onclick = () => {
        const item = state.errors.find((x) => x.id === btn.getAttribute('data-id'));
        if (item) copyText([item.type, item.message, item.stack, item.reason].filter(Boolean).join('\n\n')).then(() => toast('Copied'));
      };
    });
  }

  function toast(msg) {
    let el = root.querySelector('.sd-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'sd-toast';
      el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;background:rgba(8,10,14,.95);border:1px solid rgba(116,134,166,.18);padding:10px 14px;border-radius:999px;color:#E8EEF8;box-shadow:0 14px 40px rgba(0,0,0,.35)';
      root.appendChild(el);
    }
    el.textContent = msg;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { try { el.remove(); } catch (_) {} }, 1200);
  }

  function syncStorage() {
    state.storage.local = [];
    state.storage.session = [];
    state.storage.cookies = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        state.storage.local.push([k, localStorage.getItem(k)]);
      }
    } catch (e) {}
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        state.storage.session.push([k, sessionStorage.getItem(k)]);
      }
    } catch (e) {}
    try {
      const cookies = document.cookie ? document.cookie.split('; ') : [];
      cookies.forEach((pair) => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        state.storage.cookies.push([decodeURIComponent(pair.slice(0, idx)), decodeURIComponent(pair.slice(idx + 1))]);
      });
    } catch (e) {}
    if (state.activeTab === 'storage') render();
  }

  function replayRequest(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = absURL(req.url);
    const headers = Object.assign({}, req.reqHeaders || {});
    const body = normalizeBody(req.requestBody);
    if (!original.fetch) {
      toast('fetch not available');
      return;
    }

    const init = { method, headers };
    if (!/^(GET|HEAD)$/i.test(method)) init.body = body;

    original.fetch(url, init).then(() => toast('Replayed')).catch((e) => toast(`Replay failed: ${e.message || e}`));
  }

  function startPicker() {
    state.pickerOn = true;
    els.hint.style.display = 'block';
    els.hint.textContent = 'Tap any element on the page to inspect it. Tap “Pick element” again to cancel.';
    document.documentElement.style.cursor = 'crosshair';

    const highlight = (el) => {
      if (!el || !el.getBoundingClientRect) {
        els.highlight.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      els.highlight.style.display = 'block';
      els.highlight.style.left = `${Math.max(0, r.left)}px`;
      els.highlight.style.top = `${Math.max(0, r.top)}px`;
      els.highlight.style.width = `${Math.max(0, r.width)}px`;
      els.highlight.style.height = `${Math.max(0, r.height)}px`;
    };

    const onMove = (e) => {
      if (!state.pickerOn) return;
      let el = e.target;
      if (el === ui.host || el === root) return;
      highlight(el);
    };

    const onClick = (e) => {
      if (!state.pickerOn) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation && e.stopImmediatePropagation();
      state.pickerOn = false;
      document.documentElement.style.cursor = '';
      els.highlight.style.display = 'none';
      els.hint.style.display = 'none';
      state.selectedElement = e.target;
      state.activeTab = 'dom';
      render();
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('touchstart', onClick, true);
      document.removeEventListener('pointermove', onMove, true);
    };

    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('touchstart', onClick, true);
  }

  function stopPicker() {
    state.pickerOn = false;
    els.hint.style.display = 'none';
    els.highlight.style.display = 'none';
    document.documentElement.style.cursor = '';
    render();
  }

  function patchConsole() {
    methods.forEach((level) => {
      console[level] = function () {
        try {
          addConsole(level, Array.prototype.slice.call(arguments));
        } catch (e) {}
        return original.console[level].apply(console, arguments);
      };
    });
  }

  let errorHandlerRef = null;
  let rejectionHandlerRef = null;

  function patchErrors() {
    errorHandlerRef = function (e) {
      addError('error', {
        message: e.message || 'Error',
        stack: (e.error && e.error.stack) || ((e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || '')),
        reason: null,
      });
    };
    rejectionHandlerRef = function (e) {
      const reason = e.reason;
      addError('unhandledrejection', {
        message: safeText(reason instanceof Error ? reason.message : reason),
        stack: reason && reason.stack ? reason.stack : '',
        reason: safeText(reason),
      });
    };

    window.addEventListener('error', errorHandlerRef, true);
    window.addEventListener('unhandledrejection', rejectionHandlerRef, true);
  }

  function patchFetch() {
    if (!original.fetch) return;
    window.fetch = function (input, init) {
      const start = performance.now();
      const req = input instanceof Request ? input : null;
      const url = typeof input === 'string' ? input : ((input && input.url) ? input.url : String(input));
      const method = (init && init.method) || (req && req.method) || 'GET';
      const reqHeaders = {};

      try {
        if (req && req.headers) req.headers.forEach((v, k) => { reqHeaders[k] = v; });
      } catch (_) {}
      try {
        if (init && init.headers) new Headers(init.headers).forEach((v, k) => { reqHeaders[k] = v; });
      } catch (_) {}

      const requestBody = (init && Object.prototype.hasOwnProperty.call(init, 'body')) ? init.body : null;

      return original.fetch(input, init).then((res) => {
        captureResponseMeta(res, {
          url: absURL(url),
          method,
          reqHeaders,
          requestBody,
          start,
        });
        return res;
      }).catch((err) => {
        addNetwork({
          url: absURL(url),
          method,
          reqHeaders,
          requestBody,
          status: 'ERR',
          statusText: String(err),
          ok: false,
          duration: Math.round(performance.now() - start),
          time: now(),
          responseText: String(err),
          responsePretty: null,
          responseSize: null,
        });
        throw err;
      });
    };
  }

  function patchXHR() {
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__sd = { method, url, headers: {}, start: performance.now() };
      return original.xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      this.__sd = this.__sd || { headers: {} };
      this.__sd.headers[k] = v;
      return original.xhrSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const xhr = this;
      xhr.__sd = xhr.__sd || { headers: {} };
      xhr.__sd.body = body;
      xhr.addEventListener('loadend', function () {
        const text = xhr.responseText || '';
        const statusOk = xhr.status >= 200 && xhr.status < 300;
        addNetwork({
          url: absURL(xhr.__sd.url),
          method: String(xhr.__sd.method || 'GET'),
          reqHeaders: xhr.__sd.headers || {},
          requestBody: xhr.__sd.body,
          responseHeaders: parseXHRHeaders(xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : ''),
          status: xhr.status,
          statusText: xhr.statusText || (statusOk ? 'OK' : 'ERR'),
          ok: statusOk,
          duration: Math.round(performance.now() - (xhr.__sd.start || performance.now())),
          time: now(),
          responseText: text,
          responsePretty: jsonPretty(text),
          responseSize: text ? new Blob([text]).size : 0,
        });
      }, { once: true });
      return original.xhrSend.apply(this, arguments);
    };
  }

  function parseXHRHeaders(raw) {
    const out = {};
    String(raw || '').trim().split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  }

  function hookActions() {
    q('[data-act="reload"]').onclick = () => location.reload();
    q('[data-act="hide"]').onclick = () => {
      state.open = !state.open;
      ui.host.style.display = state.open ? '' : 'none';
    };
    q('[data-act="close"]').onclick = destroy;
    q('[data-act="copyAllCurl"]').onclick = () => copyAllCurl().then(() => toast('All cURL copied')).catch(() => toast('Copy failed'));
    q('[data-act="refreshStorage"]').onclick = () => { syncStorage(); toast('Storage refreshed'); };
    q('[data-act="pickElement"]').onclick = () => {
      if (state.pickerOn) stopPicker();
      else startPicker();
      setTab('dom');
    };
    q('[data-act="copyStorage"]').onclick = () => {
      copyText(JSON.stringify(state.storage, null, 2)).then(() => toast('Storage copied'));
    };
    q('[data-act="copyDom"]').onclick = () => {
      if (!state.selectedElement) return toast('No element selected');
      const el = state.selectedElement;
      const data = {
        path: getElementPath(el),
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        id: el.id || '',
        className: el.className || '',
        text: (el.innerText || el.textContent || '').trim(),
        html: el.outerHTML || '',
      };
      copyText(JSON.stringify(data, null, 2)).then(() => toast('DOM info copied'));
    };

    qa('[data-tab]').forEach((btn) => {
      btn.onclick = () => setTab(btn.getAttribute('data-tab'));
    });

    q('[data-q="search"]').addEventListener('input', (e) => {
      state.filter.q = e.target.value;
      render();
    });
    q('[data-q="method"]').addEventListener('change', (e) => {
      state.filter.method = e.target.value;
      render();
    });
    q('[data-q="status"]').addEventListener('change', (e) => {
      state.filter.status = e.target.value;
      render();
    });
  }

  function destroy() {
    try {
      if (original.fetch) window.fetch = original.fetch;
      console.log = original.console.log;
      console.info = original.console.info;
      console.warn = original.console.warn;
      console.error = original.console.error;
      console.debug = original.console.debug;
      console.trace = original.console.trace;
      XMLHttpRequest.prototype.open = original.xhrOpen;
      XMLHttpRequest.prototype.send = original.xhrSend;
      XMLHttpRequest.prototype.setRequestHeader = original.xhrSetHeader;
    } catch (_) {}
    try {
      ui.host.remove();
    } catch (_) {}
    if (errorHandlerRef) window.removeEventListener('error', errorHandlerRef, true);
    if (rejectionHandlerRef) window.removeEventListener('unhandledrejection', rejectionHandlerRef, true);
    window.__SheruDevTools = null;
  }


  function animateFPS() {
    let frames = 0;
    let last = performance.now();
    function tick(nowTs) {
      frames++;
      if (nowTs - last >= 1000) {
        state.perf.fps = frames;
        frames = 0;
        last = nowTs;
        updateStats();
        if (state.activeTab === 'perf') render();
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function init() {
    patchConsole();
    patchErrors();
    patchFetch();
    patchXHR();
    syncStorage();
    updateStats();
    animateFPS();
    render();
    hookActions();
    setTab('network');
    window.__SheruDevTools = {
      toggle: () => { q('[data-act="hide"]').click(); },
      close: destroy,
      setTab,
      refreshStorage: syncStorage,
      copyAllCurl,
    };
    toast('Sheru DevTools loaded');
  }

  init();
})();
