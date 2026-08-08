(function () {
  'use strict';

  if (window.__SheruDevTools) {
    window.__SheruDevTools.toggle();
    return;
  }

  const MAX_ITEMS = 200;
  const MAX_PULSE = 28;

  const state = {
    open: true,
    activeTab: 'network',
    network: [],
    console: [],
    errors: [],
    pulse: [],
    storage: { local: [], session: [], cookies: [] },
    perf: { fps: 0, domNodes: 0, memory: null, since: Date.now() },
    filter: { q: '', method: 'all', status: 'all' },
    selectedNetworkId: null,
    selectedConsoleId: null,
    selectedErrorId: null,
    selectedElement: null,
    pickerOn: false,
    startedAt: performance.now(),
  };

  const original = {
    fetch: window.fetch ? window.fetch.bind(window) : null,
    console: {},
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    xhrSetHeader: XMLHttpRequest.prototype.setRequestHeader,
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

  function isErrItem(item) {
    return item.status === 'ERR' || Number(item.status) === 0;
  }

  function pushPulse(ok) {
    state.pulse.push(ok ? 1 : 0);
    if (state.pulse.length > MAX_PULSE) state.pulse.shift();
  }

  function addNetwork(entry) {
    state.network.unshift(Object.assign({ id: uid('net'), expanded: false }, entry));
    if (state.network.length > MAX_ITEMS) state.network.length = MAX_ITEMS;
    pushPulse(entry.ok !== false && entry.status !== 'ERR');
    scheduleRender();
  }

  function addConsole(level, args) {
    state.console.unshift({ id: uid('con'), level, time: now(), args: args.map(safeText) });
    if (state.console.length > MAX_ITEMS) state.console.length = MAX_ITEMS;
    scheduleRender();
  }

  function addError(type, data) {
    state.errors.unshift(Object.assign({ id: uid('err'), time: now(), type }, data));
    if (state.errors.length > MAX_ITEMS) state.errors.length = MAX_ITEMS;
    scheduleRender();
  }

  function captureResponseMeta(res, meta) {
    try {
      res.clone().text().then((text) => {
        const bytes = text ? new Blob([text]).size : 0;
        addNetwork({
          url: meta.url, method: meta.method, reqHeaders: meta.reqHeaders, requestBody: meta.requestBody,
          responseHeaders: toPlainHeaders(res.headers), status: res.status,
          statusText: res.statusText || (res.ok ? 'OK' : 'ERR'), ok: res.ok,
          duration: Math.round(performance.now() - meta.start), time: now(),
          responseText: text, responsePretty: jsonPretty(text), responseSize: bytes,
        });
      }).catch((err) => {
        addNetwork({
          url: meta.url, method: meta.method, reqHeaders: meta.reqHeaders, requestBody: meta.requestBody,
          responseHeaders: toPlainHeaders(res.headers), status: res.status, statusText: res.statusText || 'ERR',
          ok: res.ok, duration: Math.round(performance.now() - meta.start), time: now(),
          responseText: `[read error] ${err}`, responsePretty: null, responseSize: null,
        });
      });
    } catch (err) {
      addNetwork({
        url: meta.url, method: meta.method, reqHeaders: meta.reqHeaders, requestBody: meta.requestBody,
        status: res.status, statusText: 'ERR', ok: false, duration: Math.round(performance.now() - meta.start),
        time: now(), responseText: `[clone error] ${err}`, responsePretty: null, responseSize: null,
      });
    }
  }

  // ---------------------------------------------------------------------
  // UI shell — "instrument console" design system
  // ---------------------------------------------------------------------

  function injectStyles(root) {
    const style = document.createElement('style');
    style.textContent = `
      :host, * { box-sizing: border-box; }
      .sd-root {
        --bg: #0A0C10;
        --panel: #12161C;
        --panel-2: #171C24;
        --line: rgba(148,163,184,.14);
        --line-soft: rgba(148,163,184,.08);
        --ink: #E7ECF3;
        --ink-dim: rgba(231,236,243,.58);
        --ink-dimmer: rgba(231,236,243,.38);
        --amber: #F5A524;
        --amber-dim: rgba(245,165,36,.14);
        --cyan: #57D9C7;
        --ok: #3ED598;
        --bad: #FB6B6B;
        --warn: #F5C043;
        --mono: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
        --sans: ui-sans-serif, Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        --r: 16px;

        position: fixed; inset: auto 12px 12px auto; z-index: 2147483000;
        width: min(96vw, 1000px); height: min(82vh, 760px);
        background: var(--bg); color: var(--ink);
        border: 1px solid var(--line);
        border-radius: 20px; overflow: hidden;
        box-shadow: 0 30px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.4);
        display: flex; flex-direction: column;
        font-family: var(--sans);
      }
      .sd-root.sd-dragging { user-select: none; }
      .sd-topbar {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, var(--panel-2), var(--panel));
        cursor: grab;
      }
      .sd-topbar:active { cursor: grabbing; }
      .sd-mark {
        width: 30px; height: 30px; border-radius: 9px; flex: none;
        background: radial-gradient(circle at 30% 30%, var(--amber), #B9770E 70%);
        display: flex; align-items: center; justify-content: center;
        font-size: 15px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.25);
      }
      .sd-brand { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .sd-title { display: flex; align-items: center; gap: 8px; min-width: 0; font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: .2px; }
      .sd-subtitle { font-size: 10.5px; color: var(--ink-dimmer); font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sd-pulse { display: flex; align-items: flex-end; gap: 2px; height: 16px; margin-left: 4px; }
      .sd-pulse i { width: 3px; border-radius: 1px; background: var(--ink-dimmer); display: block; }
      .sd-pulse i.on { background: var(--ok); }
      .sd-pulse i.off { background: var(--bad); }
      .sd-actions { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
      .sd-btn, .sd-tab, .sd-chip, .sd-input, .sd-select, .sd-mini {
        appearance: none; border: 1px solid var(--line);
        background: rgba(255,255,255,.03); color: var(--ink);
        border-radius: 10px; font: inherit; font-family: var(--mono);
      }
      .sd-btn, .sd-mini {
        padding: 7px 10px; cursor: pointer; line-height: 1; font-size: 11.5px;
        transition: transform .1s ease, background .12s ease, border-color .12s ease;
      }
      .sd-btn:hover, .sd-mini:hover, .sd-tab:hover { background: rgba(255,255,255,.07); border-color: rgba(148,163,184,.28); }
      .sd-btn:active, .sd-mini:active, .sd-tab:active { transform: translateY(1px); }
      .sd-mini.sd-danger:hover { border-color: rgba(251,107,107,.5); color: var(--bad); }
      .sd-body { display: grid; grid-template-columns: 220px 1fr; min-height: 0; flex: 1; }
      .sd-side { padding: 12px; border-right: 1px solid var(--line); overflow: auto; background: rgba(255,255,255,.012); }
      .sd-main { min-width: 0; display: flex; flex-direction: column; min-height: 0; }
      .sd-tabs { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; padding: 10px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.012); }
      .sd-tab { padding: 9px 4px; cursor: pointer; font-weight: 700; font-size: 10.5px; letter-spacing: .3px; text-transform: uppercase; display: flex; flex-direction: column; align-items: center; gap: 3px; }
      .sd-tab .sd-tabicon { font-size: 14px; }
      .sd-tab.active { background: var(--amber-dim); border-color: rgba(245,165,36,.4); color: #FFD48A; }
      .sd-content { min-height: 0; flex: 1; overflow: auto; padding: 12px; }
      .sd-card { border: 1px solid var(--line); background: var(--panel); border-radius: var(--r); padding: 12px; margin-bottom: 10px; }
      .sd-card:last-child { margin-bottom: 0; }
      .sd-section { display: flex; flex-direction: column; gap: 10px; }
      .sd-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .sd-row.tight { gap: 6px; }
      .sd-input, .sd-select { padding: 8px 10px; outline: none; min-width: 0; background: rgba(255,255,255,.03); font-size: 12px; }
      .sd-input:focus, .sd-select:focus { border-color: var(--amber); }
      .sd-input::placeholder { color: var(--ink-dimmer); }
      .sd-kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 8px; }
      .sd-kpi { border-radius: 12px; padding: 10px; background: var(--panel-2); border: 1px solid var(--line); }
      .sd-kpi-label { color: var(--ink-dimmer); font-size: 9.5px; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 6px; font-family: var(--mono); }
      .sd-kpi-value { font-size: 16px; font-weight: 800; font-family: var(--mono); }
      .sd-list { display: flex; flex-direction: column; gap: 8px; }
      .sd-item { border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); overflow: hidden; }
      .sd-item-head { padding: 10px 10px 9px; display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; }
      .sd-status { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 800; padding: 3px 8px; border-radius: 999px; font-family: var(--mono); }
      .sd-ok { color: var(--ok); background: rgba(62,213,152,.12); border: 1px solid rgba(62,213,152,.24); }
      .sd-bad { color: var(--bad); background: rgba(251,107,107,.12); border: 1px solid rgba(251,107,107,.24); }
      .sd-warn { color: var(--warn); background: rgba(245,192,67,.12); border: 1px solid rgba(245,192,67,.24); }
      .sd-meta { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .sd-meta-top { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .sd-method { font-weight: 800; color: var(--cyan); }
      .sd-url { color: var(--ink); word-break: break-all; font-family: var(--mono); font-size: 12px; }
      .sd-muted { color: var(--ink-dim); font-size: 10.5px; font-family: var(--mono); }
      .sd-item-actions { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
      .sd-pills { display: flex; gap: 6px; flex-wrap: wrap; }
      .sd-pill { font-size: 10.5px; color: var(--ink-dim); border: 1px solid var(--line); background: rgba(255,255,255,.02); padding: 4px 7px; border-radius: 999px; font-family: var(--mono); }
      .sd-details { border-top: 1px solid var(--line); padding: 10px; display: grid; gap: 10px; background: rgba(255,255,255,.012); }
      .sd-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .sd-pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; font-size: 11.5px; padding: 10px; border-radius: 10px; background: rgba(0,0,0,.3); border: 1px solid var(--line-soft); font-family: var(--mono); }
      .sd-split { display: grid; grid-template-columns: 1.2fr .8fr; gap: 10px; min-height: 0; }
      .sd-console-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
      .sd-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--cyan); display: inline-block; }
      .sd-dot.warn { background: var(--warn); } .sd-dot.error { background: var(--bad); } .sd-dot.debug { background: #C084FC; }
      .sd-empty { color: var(--ink-dimmer); text-align: center; padding: 26px 12px; border: 1px dashed var(--line); border-radius: var(--r); font-family: var(--mono); font-size: 12px; }
      .sd-keyval { display: grid; grid-template-columns: 130px 1fr; gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--line-soft); font-size: 12px; }
      .sd-key { color: var(--ink-dimmer); font-family: var(--mono); font-size: 11px; }
      .sd-val { word-break: break-word; font-family: var(--mono); }
      .sd-highlight { position: fixed; pointer-events: none; z-index: 2147483001; border: 2px solid var(--amber); background: rgba(245,165,36,.14); border-radius: 6px; display: none; }
      .sd-picker-hint { position: fixed; inset: auto 12px 12px 12px; z-index: 2147483002; padding: 10px 12px; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); color: var(--ink); display: none; font-family: var(--mono); font-size: 12px; }
      .sd-mini-panel { border: 1px solid var(--line); border-radius: 14px; padding: 10px; background: var(--panel-2); }
      .sd-resize { position: absolute; right: 2px; bottom: 2px; width: 18px; height: 18px; cursor: nwse-resize; opacity: .5; }
      .sd-resize:hover { opacity: 1; }
      .sd-fab {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        width: 46px; height: 46px; border-radius: 14px; border: 1px solid var(--line, rgba(148,163,184,.14));
        background: #12161C; color: #F5A524; font-size: 18px; cursor: pointer;
        display: none; align-items: center; justify-content: center;
        box-shadow: 0 10px 30px rgba(0,0,0,.5);
        font-family: ui-monospace, monospace;
      }
      .sd-toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 2147483003; background: #12161C; border: 1px solid rgba(148,163,184,.18); padding: 9px 14px; border-radius: 999px; color: #E7ECF3; box-shadow: 0 14px 40px rgba(0,0,0,.4); font-family: ui-monospace, monospace; font-size: 12px; }
      @media (max-width: 860px) {
        .sd-root { inset: 0; width: 100vw; height: 100vh; border-radius: 0; }
        .sd-body { grid-template-columns: 1fr; }
        .sd-side { display: none; }
        .sd-kpi-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
        .sd-split, .sd-grid2 { grid-template-columns: 1fr; }
        .sd-resize { display: none; }
        .sd-topbar { cursor: default; }
      }
      @media (max-width: 480px) {
        .sd-topbar { padding: 9px 10px; gap: 8px; }
        .sd-actions { gap: 5px; }
        .sd-subtitle { display: none; }
        .sd-content { padding: 9px; }
        .sd-item-head { flex-direction: column; }
        .sd-item-actions { justify-content: flex-start; }
        .sd-tab .sd-tabicon { font-size: 13px; }
        .sd-tab { font-size: 9px; padding: 8px 2px; }
      }
    `;
    root.appendChild(style);
  }

  function createUI() {
    const host = document.createElement('div');
    host.id = '__sheru_devtools_host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    shadow.innerHTML = `
      <div class="sd-root" data-el="root">
        <div class="sd-topbar" data-el="drag">
          <div class="sd-mark">🐺</div>
          <div class="sd-brand">
            <div class="sd-title">SHERU DEVTOOLS <span class="sd-pulse" data-el="pulse"></span></div>
            <div class="sd-subtitle">network · console · storage · dom · errors · perf</div>
          </div>
          <div class="sd-actions">
            <button class="sd-btn" data-act="reload">↻ reload</button>
            <button class="sd-btn" data-act="hide">— hide</button>
            <button class="sd-btn" data-act="close">✕ close</button>
          </div>
        </div>
        <div class="sd-body">
          <aside class="sd-side">
            <div class="sd-section">
              <div class="sd-card">
                <div class="sd-row tight">
                  <input class="sd-input" data-q="search" type="search" placeholder="search…" style="flex:1; min-width: 0;">
                </div>
                <div class="sd-row tight" style="margin-top:8px">
                  <select class="sd-select" data-q="method" style="flex:1">
                    <option value="all">method</option>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                    <option value="DELETE">DELETE</option>
                    <option value="OPTIONS">OPTIONS</option>
                  </select>
                  <select class="sd-select" data-q="status" style="flex:1">
                    <option value="all">status</option>
                    <option value="2xx">2xx</option>
                    <option value="4xx">4xx</option>
                    <option value="5xx">5xx</option>
                    <option value="err">errors</option>
                  </select>
                </div>
                <div class="sd-row tight" style="margin-top:8px">
                  <button class="sd-mini" data-act="copyAllCurl">copy all curl</button>
                </div>
              </div>
              <div class="sd-card">
                <div class="sd-muted" style="margin-bottom:8px">quick stats</div>
                <div class="sd-kpi-grid">
                  <div class="sd-kpi"><div class="sd-kpi-label">net</div><div class="sd-kpi-value" data-metric="network">0</div></div>
                  <div class="sd-kpi"><div class="sd-kpi-label">log</div><div class="sd-kpi-value" data-metric="console">0</div></div>
                  <div class="sd-kpi"><div class="sd-kpi-label">err</div><div class="sd-kpi-value" data-metric="errors">0</div></div>
                  <div class="sd-kpi"><div class="sd-kpi-label">dom</div><div class="sd-kpi-value" data-metric="nodes">0</div></div>
                </div>
              </div>
            </div>
          </aside>
          <main class="sd-main">
            <div class="sd-tabs">
              <button class="sd-tab" data-tab="network"><span class="sd-tabicon">🌐</span>net</button>
              <button class="sd-tab" data-tab="console"><span class="sd-tabicon">🖥️</span>console</button>
              <button class="sd-tab" data-tab="storage"><span class="sd-tabicon">💾</span>storage</button>
              <button class="sd-tab" data-tab="dom"><span class="sd-tabicon">🧩</span>dom</button>
              <button class="sd-tab" data-tab="errors"><span class="sd-tabicon">🐛</span>errors</button>
              <button class="sd-tab" data-tab="perf"><span class="sd-tabicon">⚡</span>perf</button>
            </div>
            <div class="sd-content" data-view="content"></div>
          </main>
        </div>
        <div class="sd-resize" data-el="resize" title="resize">↘</div>
        <div class="sd-highlight" data-layer="highlight"></div>
        <div class="sd-picker-hint" data-layer="hint"></div>
      </div>
    `;

    injectStyles(shadow);

    const fab = document.createElement('button');
    fab.className = 'sd-fab';
    fab.setAttribute('data-el', 'fab');
    fab.textContent = '🐺';
    shadow.appendChild(fab);

    return { host, shadow };
  }

  const ui = createUI();
  const root = ui.shadow;
  const els = {
    root: root.querySelector('[data-el="root"]'),
    content: root.querySelector('[data-view="content"]'),
    highlight: root.querySelector('[data-layer="highlight"]'),
    hint: root.querySelector('[data-layer="hint"]'),
    fab: root.querySelector('[data-el="fab"]'),
    pulse: root.querySelector('[data-el="pulse"]'),
    drag: root.querySelector('[data-el="drag"]'),
    resize: root.querySelector('[data-el="resize"]'),
  };

  function q(sel) { return root.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); }

  // ---------------------------------------------------------------------
  // Render scheduling — coalesce bursts of network/console/error events
  // into a single paint via requestAnimationFrame instead of re-rendering
  // synchronously on every single event.
  // ---------------------------------------------------------------------
  let renderQueued = false;
  function scheduleRender() {
    updatePulseUI();
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function updatePulseUI() {
    if (!els.pulse) return;
    const bars = state.pulse.slice(-MAX_PULSE);
    els.pulse.innerHTML = bars.map((v, i) => {
      const h = 5 + (i % 5) * 2;
      return `<i class="${v ? 'on' : 'off'}" style="height:${h}px"></i>`;
    }).join('');
  }

  function updateStats() {
    const nodes = document.getElementsByTagName('*').length;
    state.perf.domNodes = nodes;
    const mem = performance.memory ? {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize,
      limit: performance.memory.jsHeapSizeLimit
    } : null;
    state.perf.memory = mem;

    const metrics = { network: state.network.length, console: state.console.length, errors: state.errors.length, nodes };
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
    qa('[data-tab]').forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === name));
    render();
  }

  function getFilteredNetwork() {
    const qx = String(state.filter.q || '').trim().toLowerCase();
    return state.network.filter((item) => {
      const hay = [
        item.url, item.method, item.status, item.statusText, item.responseText, item.requestBody,
        JSON.stringify(item.reqHeaders || {}), JSON.stringify(item.responseHeaders || {}),
      ].join(' ').toLowerCase();

      if (qx && hay.indexOf(qx) === -1) return false;
      if (state.filter.method !== 'all' && String(item.method || '').toUpperCase() !== state.filter.method) return false;

      if (state.filter.status !== 'all') {
        if (state.filter.status === 'err' && !isErrItem(item)) return false;
        const status = Number(item.status);
        if (state.filter.status === '2xx' && !(status >= 200 && status < 300)) return false;
        if (state.filter.status === '4xx' && !(status >= 400 && status < 500)) return false;
        if (state.filter.status === '5xx' && !(status >= 500 && status < 600)) return false;
      }
      return true;
    });
  }

  function renderNetwork() {
    const items = getFilteredNetwork();
    const header = `<div class="sd-row" style="margin-bottom:10px"><button class="sd-mini sd-danger" data-act="clearNet">clear network</button></div>`;
    if (!items.length) return header + `<div class="sd-empty">no network requests captured yet — trigger a fetch/XHR after loading this tool</div>`;

    return header + `
      <div class="sd-section">
        ${items.map((item) => {
          const selected = state.selectedNetworkId === item.id;
          const statusClass = isErrItem(item) ? 'sd-bad' : (item.ok ? 'sd-ok' : ((Number(item.status) >= 400) ? 'sd-bad' : 'sd-warn'));
          const showSize = item.responseSize != null ? fmtBytes(item.responseSize) : '-';
          return `
            <div class="sd-item" style="${selected ? 'border-color: rgba(245,165,36,.4); box-shadow: 0 0 0 1px rgba(245,165,36,.12) inset;' : ''}">
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
                  <button class="sd-mini" data-act="selNet" data-id="${esc(item.id)}">${selected ? 'close' : 'inspect'}</button>
                  <button class="sd-mini" data-act="copyUrl" data-id="${esc(item.id)}">url</button>
                  <button class="sd-mini" data-act="copyResp" data-id="${esc(item.id)}">response</button>
                  <button class="sd-mini" data-act="copyCurl" data-id="${esc(item.id)}">curl</button>
                  <button class="sd-mini" data-act="replay" data-id="${esc(item.id)}">replay</button>
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
            <div class="sd-muted" style="margin-bottom:8px">request</div>
            <div class="sd-keyval"><div class="sd-key">method</div><div class="sd-val">${esc(item.method)}</div></div>
            <div class="sd-keyval"><div class="sd-key">url</div><div class="sd-val">${esc(item.url)}</div></div>
            <div class="sd-keyval"><div class="sd-key">headers</div><div class="sd-val"><pre class="sd-pre">${esc(JSON.stringify(reqHeaders, null, 2))}</pre></div></div>
            <div class="sd-keyval"><div class="sd-key">body</div><div class="sd-val"><pre class="sd-pre">${esc(clamp(requestBody, 5000))}</pre></div></div>
          </div>
          <div class="sd-mini-panel">
            <div class="sd-muted" style="margin-bottom:8px">response</div>
            <div class="sd-keyval"><div class="sd-key">status</div><div class="sd-val">${esc(String(item.status))} ${esc(String(item.statusText || ''))}</div></div>
            <div class="sd-keyval"><div class="sd-key">duration</div><div class="sd-val">${esc(String(item.duration || 0))} ms</div></div>
            <div class="sd-keyval"><div class="sd-key">headers</div><div class="sd-val"><pre class="sd-pre">${esc(JSON.stringify(resHeaders, null, 2))}</pre></div></div>
            <div class="sd-keyval"><div class="sd-key">body</div><div class="sd-val"><pre class="sd-pre">${esc(clamp(body, 8000))}</pre></div></div>
          </div>
        </div>
        <div class="sd-row">
          <button class="sd-mini" data-act="toggleNet" data-id="${esc(item.id)}">${item.expanded ? 'show less' : 'show more'}</button>
          <button class="sd-mini" data-act="copyNetCurl" data-id="${esc(item.id)}">copy curl</button>
          <button class="sd-mini" data-act="copyNetResp" data-id="${esc(item.id)}">copy response</button>
        </div>
        ${item.expanded ? `<div class="sd-mini-panel"><pre class="sd-pre">${esc(clamp(item.responseText || '', 20000))}</pre></div>` : ''}
      </div>
    `;
  }

  function renderConsole() {
    const header = `<div class="sd-row" style="margin-bottom:10px"><button class="sd-mini sd-danger" data-act="clearConsole">clear console</button></div>`;
    if (!state.console.length) return header + `<div class="sd-empty">no console output captured yet</div>`;
    return header + `
      <div class="sd-section">
        ${state.console.map((item) => {
          const dotClass = item.level === 'error' ? 'error' : (item.level === 'warn' ? 'warn' : (item.level === 'debug' ? 'debug' : ''));
          const selected = state.selectedConsoleId === item.id;
          return `
            <div class="sd-item" style="${selected ? 'border-color: rgba(245,165,36,.4);' : ''}">
              <div class="sd-item-head">
                <div class="sd-meta">
                  <div class="sd-meta-top">
                    <span class="sd-pill"><span class="sd-dot ${dotClass}"></span> ${esc(item.level.toUpperCase())}</span>
                    <span class="sd-pill">${esc(item.time)}</span>
                  </div>
                  <div class="sd-muted">${esc(item.args.join(' '))}</div>
                </div>
                <div class="sd-item-actions">
                  <button class="sd-mini" data-act="selCon" data-id="${esc(item.id)}">${selected ? 'close' : 'inspect'}</button>
                  <button class="sd-mini" data-act="copyCon" data-id="${esc(item.id)}">copy</button>
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
    const local = state.storage.local;
    const session = state.storage.session;
    const cookies = state.storage.cookies;

    function renderPairs(list, type) {
      if (!list.length) return `<div class="sd-empty">no ${type} items</div>`;
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
          <button class="sd-mini" data-act="refreshStorage">refresh</button>
          <button class="sd-mini" data-act="copyStorage">copy json</button>
        </div>
        <div class="sd-split">
          <div class="sd-mini-panel"><div class="sd-muted" style="margin-bottom:8px">local storage</div>${renderPairs(local, 'local storage')}</div>
          <div class="sd-mini-panel"><div class="sd-muted" style="margin-bottom:8px">session storage</div>${renderPairs(session, 'session storage')}</div>
        </div>
        <div class="sd-mini-panel"><div class="sd-muted" style="margin-bottom:8px">cookies</div>${renderPairs(cookies, 'cookies')}</div>
      </div>
    `;
  }

  function renderDOM() {
    return `
      <div class="sd-section">
        <div class="sd-row">
          <button class="sd-mini" data-act="pickElement">${state.pickerOn ? 'cancel picker' : 'pick element'}</button>
          <button class="sd-mini" data-act="copyDom">copy selected info</button>
        </div>
        <div class="sd-mini-panel">
          <div class="sd-muted" style="margin-bottom:8px">selected element</div>
          ${state.selectedElement ? renderSelectedElement(state.selectedElement) : '<div class="sd-empty">tap “pick element” then tap any element on the page</div>'}
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
      ['tag', el.tagName ? el.tagName.toLowerCase() : '-'],
      ['path', getElementPath(el)],
      ['text', clamp((el.innerText || el.textContent || '').trim(), 1500)],
      ['size', `${Math.round(rect.width)} × ${Math.round(rect.height)}`],
      ['position', `${Math.round(rect.left)}, ${Math.round(rect.top)}`],
      ['classes', el.className || '-'],
      ['id', el.id || '-'],
    ];

    return `
      <div class="sd-section">
        ${kv.map(([k, v]) => `<div class="sd-keyval"><div class="sd-key">${esc(k)}</div><div class="sd-val">${esc(v)}</div></div>`).join('')}
        <div class="sd-grid2">
          <div>
            <div class="sd-muted" style="margin:8px 0">attributes</div>
            <pre class="sd-pre">${esc(JSON.stringify(Object.fromEntries(attrs), null, 2))}</pre>
          </div>
          <div>
            <div class="sd-muted" style="margin:8px 0">computed (top)</div>
            <pre class="sd-pre">${esc(computed ? [
              `display: ${computed.display}`, `position: ${computed.position}`, `width: ${computed.width}`,
              `height: ${computed.height}`, `padding: ${computed.padding}`, `margin: ${computed.margin}`,
              `color: ${computed.color}`, `background: ${computed.backgroundColor}`, `font: ${computed.font}`,
            ].join('\n') : 'n/a')}</pre>
          </div>
        </div>
      </div>
    `;
  }

  function renderErrors() {
    const header = `<div class="sd-row" style="margin-bottom:10px"><button class="sd-mini sd-danger" data-act="clearErrors">clear errors</button></div>`;
    if (!state.errors.length) return header + `<div class="sd-empty">no errors captured yet</div>`;
    return header + `
      <div class="sd-section">
        ${state.errors.map((item) => {
          const selected = state.selectedErrorId === item.id;
          return `
            <div class="sd-item" style="${selected ? 'border-color: rgba(245,165,36,.4);' : ''}">
              <div class="sd-item-head">
                <div class="sd-meta">
                  <div class="sd-meta-top">
                    <span class="sd-status sd-bad">${esc(item.type)}</span>
                    <span class="sd-pill">${esc(item.time)}</span>
                  </div>
                  <div class="sd-muted">${esc(item.message || '')}</div>
                </div>
                <div class="sd-item-actions">
                  <button class="sd-mini" data-act="selErr" data-id="${esc(item.id)}">${selected ? 'close' : 'inspect'}</button>
                  <button class="sd-mini" data-act="copyErr" data-id="${esc(item.id)}">copy</button>
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
          <div class="sd-kpi"><div class="sd-kpi-label">fps</div><div class="sd-kpi-value">${esc(String(state.perf.fps || 0))}</div></div>
          <div class="sd-kpi"><div class="sd-kpi-label">network</div><div class="sd-kpi-value">${esc(String(state.network.length))}</div></div>
          <div class="sd-kpi"><div class="sd-kpi-label">dom nodes</div><div class="sd-kpi-value">${esc(String(state.perf.domNodes || 0))}</div></div>
          <div class="sd-kpi"><div class="sd-kpi-label">memory</div><div class="sd-kpi-value">${esc(mem ? fmtBytes(mem.used) : 'n/a')}</div></div>
        </div>
        <div class="sd-mini-panel">
          <div class="sd-muted" style="margin-bottom:8px">session</div>
          <div class="sd-keyval"><div class="sd-key">uptime</div><div class="sd-val">${esc(String(Math.round((Date.now() - state.perf.since) / 1000)))} s</div></div>
          <div class="sd-keyval"><div class="sd-key">memory used</div><div class="sd-val">${esc(mem ? fmtBytes(mem.used) : 'n/a')}</div></div>
          <div class="sd-keyval"><div class="sd-key">memory total</div><div class="sd-val">${esc(mem ? fmtBytes(mem.total) : 'n/a')}</div></div>
          <div class="sd-keyval"><div class="sd-key">memory limit</div><div class="sd-val">${esc(mem ? fmtBytes(mem.limit) : 'n/a')}</div></div>
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
    return '<div class="sd-empty">unknown tab</div>';
  }

  function render() {
    qa('.sd-tab').forEach((btn) => btn.classList.toggle('active', btn.getAttribute('data-tab') === state.activeTab));
    els.content.innerHTML = renderContent();
    updateStats();
    updatePulseUI();
  }

  function toast(msg) {
    let el = root.querySelector('.sd-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'sd-toast';
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
    if (!original.fetch) { toast('fetch not available'); return; }
    const init = { method, headers };
    if (!/^(GET|HEAD)$/i.test(method)) init.body = body;
    original.fetch(url, init).then(() => toast('replayed')).catch((e) => toast(`replay failed: ${e.message || e}`));
  }

  // ---------------------------------------------------------------------
  // Element picker
  // ---------------------------------------------------------------------

  let pickerMove = null, pickerClick = null, pickerTouch = null;

  function startPicker() {
    state.pickerOn = true;
    els.hint.style.display = 'block';
    els.hint.textContent = 'tap any element on the page to inspect it — tap "pick element" again to cancel';
    document.documentElement.style.cursor = 'crosshair';

    const highlight = (el) => {
      if (!el || !el.getBoundingClientRect) { els.highlight.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      els.highlight.style.display = 'block';
      els.highlight.style.left = `${Math.max(0, r.left)}px`;
      els.highlight.style.top = `${Math.max(0, r.top)}px`;
      els.highlight.style.width = `${Math.max(0, r.width)}px`;
      els.highlight.style.height = `${Math.max(0, r.height)}px`;
    };

    pickerMove = (e) => {
      if (!state.pickerOn) return;
      const el = e.target;
      if (el === ui.host) return;
      highlight(el);
    };

    const pick = (e) => {
      if (!state.pickerOn) return;
      let target = e.target;
      if (e.touches && e.touches[0]) {
        target = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY) || target;
      }
      if (target === ui.host) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      stopPickerListeners();
      state.pickerOn = false;
      document.documentElement.style.cursor = '';
      els.highlight.style.display = 'none';
      els.hint.style.display = 'none';
      state.selectedElement = target;
      state.activeTab = 'dom';
      render();
    };

    pickerClick = pick;
    pickerTouch = pick;

    document.addEventListener('pointermove', pickerMove, true);
    document.addEventListener('touchmove', pickerMove, true);
    document.addEventListener('click', pickerClick, true);
    document.addEventListener('touchstart', pickerTouch, true);
  }

  function stopPickerListeners() {
    if (pickerMove) { document.removeEventListener('pointermove', pickerMove, true); document.removeEventListener('touchmove', pickerMove, true); }
    if (pickerClick) document.removeEventListener('click', pickerClick, true);
    if (pickerTouch) document.removeEventListener('touchstart', pickerTouch, true);
    pickerMove = pickerClick = pickerTouch = null;
  }

  function stopPicker() {
    stopPickerListeners();
    state.pickerOn = false;
    els.hint.style.display = 'none';
    els.highlight.style.display = 'none';
    document.documentElement.style.cursor = '';
    render();
  }

  // ---------------------------------------------------------------------
  // Patches: console, window errors, fetch, XHR
  // ---------------------------------------------------------------------

  function patchConsole() {
    methods.forEach((level) => {
      console[level] = function () {
        try { addConsole(level, Array.prototype.slice.call(arguments)); } catch (e) {}
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

      try { if (req && req.headers) req.headers.forEach((v, k) => { reqHeaders[k] = v; }); } catch (_) {}
      try { if (init && init.headers) new Headers(init.headers).forEach((v, k) => { reqHeaders[k] = v; }); } catch (_) {}

      const requestBody = (init && Object.prototype.hasOwnProperty.call(init, 'body')) ? init.body : null;

      return original.fetch(input, init).then((res) => {
        captureResponseMeta(res, { url: absURL(url), method, reqHeaders, requestBody, start });
        return res;
      }).catch((err) => {
        addNetwork({
          url: absURL(url), method, reqHeaders, requestBody, status: 'ERR', statusText: String(err),
          ok: false, duration: Math.round(performance.now() - start), time: now(),
          responseText: String(err), responsePretty: null, responseSize: null,
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
          url: absURL(xhr.__sd.url), method: String(xhr.__sd.method || 'GET'), reqHeaders: xhr.__sd.headers || {},
          requestBody: xhr.__sd.body, responseHeaders: parseXHRHeaders(xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : ''),
          status: xhr.status, statusText: xhr.statusText || (statusOk ? 'OK' : 'ERR'), ok: statusOk,
          duration: Math.round(performance.now() - (xhr.__sd.start || performance.now())), time: now(),
          responseText: text, responsePretty: jsonPretty(text), responseSize: text ? new Blob([text]).size : 0,
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

  // ---------------------------------------------------------------------
  // Drag to move / resize (desktop only — mobile stays fullscreen)
  // ---------------------------------------------------------------------

  function isDesktop() { return window.innerWidth > 860; }

  function enableDrag() {
    let dragging = false, ox = 0, oy = 0;
    els.drag.addEventListener('pointerdown', (e) => {
      if (!isDesktop()) return;
      if (e.target.closest('[data-act]')) return;
      dragging = true;
      els.root.classList.add('sd-dragging');
      const r = els.root.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      els.drag.setPointerCapture(e.pointerId);
    });
    els.drag.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      els.root.style.left = `${Math.max(0, e.clientX - ox)}px`;
      els.root.style.top = `${Math.max(0, e.clientY - oy)}px`;
      els.root.style.right = 'auto';
      els.root.style.bottom = 'auto';
    });
    const end = () => { dragging = false; els.root.classList.remove('sd-dragging'); };
    els.drag.addEventListener('pointerup', end);
    els.drag.addEventListener('pointercancel', end);
  }

  function enableResize() {
    let resizing = false, sw = 0, sh = 0, sx = 0, sy = 0;
    els.resize.addEventListener('pointerdown', (e) => {
      if (!isDesktop()) return;
      resizing = true;
      const r = els.root.getBoundingClientRect();
      sw = r.width; sh = r.height; sx = e.clientX; sy = e.clientY;
      els.resize.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    els.resize.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const w = Math.max(520, sw + (e.clientX - sx));
      const h = Math.max(360, sh + (e.clientY - sy));
      els.root.style.width = `${Math.min(w, window.innerWidth - 16)}px`;
      els.root.style.height = `${Math.min(h, window.innerHeight - 16)}px`;
    });
    const end = () => { resizing = false; };
    els.resize.addEventListener('pointerup', end);
    els.resize.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------------
  // Action delegation — one listener handles every data-act button,
  // even ones rendered dynamically inside sd-content. This is what the
  // previous version got wrong: it rebound handlers by id after every
  // render() and crashed the first time a tab hadn't been painted yet.
  // ---------------------------------------------------------------------

  function handleAction(act, btn) {
    const id = btn.getAttribute('data-id');
    switch (act) {
      case 'reload': location.reload(); break;
      case 'hide':
        state.open = false;
        els.root.style.display = 'none';
        els.fab.style.display = 'flex';
        break;
      case 'close': destroy(); break;
      case 'copyAllCurl': copyAllCurl().then(() => toast('all curl copied')).catch(() => toast('copy failed')); break;
      case 'refreshStorage': syncStorage(); toast('storage refreshed'); break;
      case 'copyStorage': copyText(JSON.stringify(state.storage, null, 2)).then(() => toast('storage copied')); break;
      case 'pickElement': state.pickerOn ? stopPicker() : startPicker(); setTab('dom'); break;
      case 'copyDom': {
        if (!state.selectedElement) { toast('no element selected'); break; }
        const el = state.selectedElement;
        const data = {
          path: getElementPath(el), tag: el.tagName ? el.tagName.toLowerCase() : '', id: el.id || '',
          className: el.className || '', text: (el.innerText || el.textContent || '').trim(), html: el.outerHTML || '',
        };
        copyText(JSON.stringify(data, null, 2)).then(() => toast('dom info copied'));
        break;
      }
      case 'clearNet': state.network = []; state.selectedNetworkId = null; render(); toast('network cleared'); break;
      case 'clearConsole': state.console = []; state.selectedConsoleId = null; render(); toast('console cleared'); break;
      case 'clearErrors': state.errors = []; state.selectedErrorId = null; render(); toast('errors cleared'); break;
      case 'selNet': state.selectedNetworkId = state.selectedNetworkId === id ? null : id; render(); break;
      case 'toggleNet': {
        const item = state.network.find((x) => x.id === id);
        if (item) item.expanded = !item.expanded;
        render();
        break;
      }
      case 'copyNetCurl':
      case 'copyCurl': {
        const item = state.network.find((x) => x.id === id);
        if (item) copyText(buildCurl(item)).then(() => toast('curl copied'));
        break;
      }
      case 'copyNetResp':
      case 'copyResp': {
        const item = state.network.find((x) => x.id === id);
        if (item) copyText(item.responseText || '').then(() => toast('response copied'));
        break;
      }
      case 'copyUrl': {
        const item = state.network.find((x) => x.id === id);
        if (item) copyText(item.url || '').then(() => toast('url copied'));
        break;
      }
      case 'replay': {
        const item = state.network.find((x) => x.id === id);
        if (item) replayRequest(item);
        break;
      }
      case 'selCon': state.selectedConsoleId = state.selectedConsoleId === id ? null : id; render(); break;
      case 'copyCon': {
        const item = state.console.find((x) => x.id === id);
        if (item) copyText(item.args.join('\n')).then(() => toast('copied'));
        break;
      }
      case 'selErr': state.selectedErrorId = state.selectedErrorId === id ? null : id; render(); break;
      case 'copyErr': {
        const item = state.errors.find((x) => x.id === id);
        if (item) copyText([item.type, item.message, item.stack, item.reason].filter(Boolean).join('\n\n')).then(() => toast('copied'));
        break;
      }
    }
  }

  function hookActions() {
    els.root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) { handleAction(btn.getAttribute('data-act'), btn); return; }
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) setTab(tabBtn.getAttribute('data-tab'));
    });

    els.fab.addEventListener('click', () => {
      state.open = true;
      els.root.style.display = 'flex';
      els.fab.style.display = 'none';
    });

    q('[data-q="search"]').addEventListener('input', (e) => { state.filter.q = e.target.value; render(); });
    q('[data-q="method"]').addEventListener('change', (e) => { state.filter.method = e.target.value; render(); });
    q('[data-q="status"]').addEventListener('change', (e) => { state.filter.status = e.target.value; render(); });

    enableDrag();
    enableResize();
  }

  function destroy() {
    try {
      if (original.fetch) window.fetch = original.fetch;
      methods.forEach((m) => { console[m] = original.console[m]; });
      XMLHttpRequest.prototype.open = original.xhrOpen;
      XMLHttpRequest.prototype.send = original.xhrSend;
      XMLHttpRequest.prototype.setRequestHeader = original.xhrSetHeader;
    } catch (_) {}
    stopPickerListeners();
    try { ui.host.remove(); } catch (_) {}
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
        if (state.activeTab === 'perf') render(); else updateStats();
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
    updatePulseUI();
    animateFPS();
    render();
    hookActions();
    setTab('network');
    window.__SheruDevTools = {
      toggle: () => { state.open ? handleAction('hide') : els.fab.click(); },
      close: destroy,
      setTab,
      refreshStorage: syncStorage,
      copyAllCurl,
    };
    toast('sheru devtools loaded');
  }

  init();
})();
