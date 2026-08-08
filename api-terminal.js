(function () {
  if (window.__apiTerminalLoaded) return;
  window.__apiTerminalLoaded = true;

  var originalFetch = window.fetch ? window.fetch.bind(window) : null;
  var XHR = XMLHttpRequest.prototype;
  var originalOpen = XHR.open;
  var originalSend = XHR.send;
  var originalSetHeader = XHR.setRequestHeader;

  var state = {
    items: [],
    hidden: false
  };

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function safeJSON(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (e) {
      return null;
    }
  }

  function nowTime() {
    try {
      return new Date().toLocaleTimeString();
    } catch (e) {
      return '';
    }
  }

  function absURL(u) {
    try {
      return new URL(String(u), location.href).href;
    } catch (e) {
      return String(u);
    }
  }

  function toText(v) {
    try {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (v instanceof URLSearchParams) return v.toString();
      if (v instanceof FormData) {
        var arr = [];
        v.forEach(function (val, key) {
          arr.push(key + '=' + (typeof val === 'string' ? val : '[file]'));
        });
        return arr.join('&');
      }
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    } catch (e) {
      return String(v);
    }
  }

  function shellQuote(s) {
    return "'" + String(s == null ? '' : s).replace(/'/g, "'\"'\"'") + "'";
  }

  function buildCurl(method, url, headers, body) {
    var parts = ['curl --compressed -X ' + String(method || 'GET').toUpperCase() + ' ' + shellQuote(absURL(url))];
    Object.keys(headers || {}).forEach(function (k) {
      var v = headers[k];
      if (k && v != null) parts.push('-H ' + shellQuote(k + ': ' + String(v)));
    });
    var bodyText = toText(body);
    if (bodyText && !/^(GET|HEAD)$/i.test(method || 'GET')) {
      parts.push('--data-raw ' + shellQuote(bodyText));
    }
    return parts.join(' \\\n  ');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(String(text == null ? '' : text));
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = String(text == null ? '' : text);
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        ta.remove();
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  function clip(text, limit) {
    text = String(text == null ? '' : text);
    if (text.length <= limit) return text;
    return text.slice(0, limit) + '\n… (' + (text.length - limit) + ' more chars)';
  }

  var panel = document.createElement('div');
  panel.id = '__api_terminal_panel';
  panel.style.cssText = [
    'position:fixed',
    'right:12px',
    'bottom:12px',
    'z-index:2147483647',
    'width:min(96vw,820px)',
    'max-height:76vh',
    'display:flex',
    'flex-direction:column',
    'background:#0f1115',
    'color:#e9eef5',
    'border:1px solid #2d3748',
    'border-radius:14px',
    'box-shadow:0 18px 60px rgba(0,0,0,.45)',
    'overflow:hidden',
    'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
  ].join(';');

  panel.innerHTML = [
    '<div id="__api_terminal_head" style="display:flex;gap:8px;align-items:center;padding:10px 12px;background:#121824;border-bottom:1px solid #273042;user-select:none;cursor:move">',
      '<b style="letter-spacing:.2px">API Terminal</b>',
      '<span id="__api_terminal_count" style="opacity:.75">0</span>',
      '<div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">',
        '<button data-act="hide" style="background:#1b2433;color:#e8eef5;border:1px solid #334156;border-radius:8px;padding:5px 8px">Hide</button>',
        '<button data-act="clear" style="background:#1b2433;color:#e8eef5;border:1px solid #334156;border-radius:8px;padding:5px 8px">Clear</button>',
        '<button data-act="copyall" style="background:#1b2433;color:#e8eef5;border:1px solid #334156;border-radius:8px;padding:5px 8px">Copy All cURL</button>',
        '<button data-act="close" style="background:#351d24;color:#ffd9df;border:1px solid #613342;border-radius:8px;padding:5px 8px">Close</button>',
      '</div>',
    '</div>',
    '<div id="__api_terminal_body" style="padding:10px;overflow:auto;max-height:calc(76vh - 48px)"></div>',
    '<button id="__api_terminal_dock" style="display:none;position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#121824;color:#e8eef5;border:1px solid #334156;border-radius:999px;padding:10px 14px;box-shadow:0 8px 28px rgba(0,0,0,.35)">API Terminal</button>'
  ].join('');
  document.documentElement.appendChild(panel);

  var body = panel.querySelector('#__api_terminal_body');
  var count = panel.querySelector('#__api_terminal_count');
  var dock = panel.querySelector('#__api_terminal_dock');

  function toast(msg) {
    var t = panel.querySelector('#__api_terminal_toast');
    if (!t) {
      t = document.createElement('div');
      t.id = '__api_terminal_toast';
      t.style.cssText = 'position:sticky;bottom:8px;margin-top:10px;align-self:flex-end;padding:8px 10px;border-radius:10px;background:#172131;border:1px solid #334156';
      body.appendChild(t);
    }
    t.textContent = msg;
    clearTimeout(window.__api_terminal_toast_timer);
    window.__api_terminal_toast_timer = setTimeout(function () {
      if (t && t.parentNode) t.parentNode.removeChild(t);
    }, 1200);
  }

  function render() {
    count.textContent = String(state.items.length);
    body.innerHTML = state.items.length ? '' : '<div style="opacity:.7;padding:10px">No requests captured yet. Trigger a fetch/XHR after installing this tool.</div>';

    state.items.slice().reverse().forEach(function (e) {
      var pretty = e.pretty != null ? e.pretty : (e.responseText || '');
      var view = e.expanded ? pretty : clip(pretty, 800);
      var curl = buildCurl(e.method, e.url, e.reqHeaders, e.requestBody);

      var item = document.createElement('div');
      item.style.cssText = 'border:1px solid #243044;border-radius:12px;padding:10px;margin:0 0 10px 0;background:#0c1017';
      item.innerHTML = [
        '<div style="display:flex;gap:8px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap">',
          '<div style="min-width:0;flex:1">',
            '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">',
              '<span style="padding:2px 8px;border-radius:999px;background:' + (e.ok ? '#12361f' : '#3b1d21') + ';color:' + (e.ok ? '#8df0b0' : '#ffadb7') + ';border:1px solid ' + (e.ok ? '#1f6b3a' : '#7a2d3d') + '">' + escapeHTML(e.statusText || '') + '</span>',
              '<span style="opacity:.75">' + escapeHTML(e.method) + '</span>',
              '<span style="opacity:.75">' + escapeHTML(String(e.status)) + '</span>',
              '<span style="opacity:.55">' + escapeHTML(String(e.ms)) + ' ms</span>',
              '<span style="opacity:.55">' + escapeHTML(e.time) + '</span>',
            '</div>',
            '<div style="margin-top:6px;word-break:break-all">' + escapeHTML(e.url) + '</div>',
          '</div>',
          '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">',
            '<button data-b="u" style="background:#1b2433;color:#e8eef5;border:1px solid #334156;border-radius:8px;padding:5px 8px">Copy URL</button>',
            '<button data-b="r" style="background:#1b2433;color:#e8eef5;border:1px solid #334156;border-radius:8px;padding:5px 8px">Copy Response</button>',
            '<button data-b="c" style="background:#1b2433;color:#e8eef5;border:1px solid #334156;border-radius:8px;padding:5px 8px">Copy cURL</button>',
            '<button data-b="m" style="background:#1b2433;color:#e8eef5;border:1px solid #334156;border-radius:8px;padding:5px 8px">' + (e.expanded ? 'Show less' : 'Show more') + '</button>',
          '</div>',
        '</div>',
        '<div style="margin-top:10px;border-top:1px dashed #243044;padding-top:10px">',
          '<div style="opacity:.8;margin-bottom:6px">Response</div>',
          '<pre style="margin:0;white-space:pre-wrap;word-break:break-word;max-height:' + (e.expanded ? '44vh' : '150px') + ';overflow:auto">' + escapeHTML(view) + '</pre>',
        '</div>'
      ].join('');

      item.querySelector('[data-b="u"]').onclick = function () {
        copyText(e.url).then(function () { toast('URL copied'); });
      };
      item.querySelector('[data-b="r"]').onclick = function () {
        copyText(e.responseText || '').then(function () { toast('Response copied'); });
      };
      item.querySelector('[data-b="c"]').onclick = function () {
        copyText(curl).then(function () { toast('cURL copied'); });
      };
      item.querySelector('[data-b="m"]').onclick = function () {
        e.expanded = !e.expanded;
        render();
      };

      body.prepend(item);
    });
  }

  function add(entry) {
    state.items.unshift(entry);
    if (state.items.length > 100) state.items.length = 100;
    render();
  }

  function captureResponse(res, meta) {
    try {
      res.clone().text().then(function (text) {
        add({
          url: meta.url,
          method: meta.method,
          reqHeaders: meta.reqHeaders,
          requestBody: meta.requestBody,
          ms: meta.ms,
          time: meta.time,
          status: res.status,
          statusText: res.statusText || (res.ok ? 'OK' : 'ERR'),
          ok: res.ok,
          responseText: text,
          pretty: safeJSON(text),
          expanded: false
        });
      }).catch(function (err) {
        add({
          url: meta.url,
          method: meta.method,
          reqHeaders: meta.reqHeaders,
          requestBody: meta.requestBody,
          ms: meta.ms,
          time: meta.time,
          status: res.status,
          statusText: res.statusText || 'ERR',
          ok: res.ok,
          responseText: '[read error] ' + err,
          pretty: null,
          expanded: false
        });
      });
    } catch (err) {
      add({
        url: meta.url,
        method: meta.method,
        reqHeaders: meta.reqHeaders,
        requestBody: meta.requestBody,
        ms: meta.ms,
        time: meta.time,
        status: res.status,
        statusText: 'ERR',
        ok: false,
        responseText: '[clone error] ' + err,
        pretty: null,
        expanded: false
      });
    }
  }

  if (originalFetch) {
    window.fetch = function (input, init) {
      var t0 = performance.now();
      var req = input instanceof Request ? input : null;
      var url = typeof input === 'string' ? input : ((input && input.url) ? input.url : String(input));
      var method = (init && init.method) || (req && req.method) || 'GET';
      var reqHeaders = {};

      try {
        if (req && req.headers) req.headers.forEach(function (v, k) { reqHeaders[k] = v; });
      } catch (e) {}

      try {
        if (init && init.headers) {
          new Headers(init.headers).forEach(function (v, k) { reqHeaders[k] = v; });
        }
      } catch (e) {}

      var requestBody = (init && ('body' in init)) ? init.body : null;

      return originalFetch(input, init).then(function (res) {
        captureResponse(res, {
          url: absURL(url),
          method: method,
          reqHeaders: reqHeaders,
          requestBody: requestBody,
          ms: Math.round(performance.now() - t0),
          time: nowTime()
        });
        return res;
      }).catch(function (err) {
        add({
          url: absURL(url),
          method: method,
          reqHeaders: reqHeaders,
          requestBody: requestBody,
          ms: Math.round(performance.now() - t0),
          time: nowTime(),
          status: 'ERR',
          statusText: String(err),
          ok: false,
          responseText: String(err),
          pretty: null,
          expanded: false
        });
        throw err;
      });
    };
  }

  XHR.open = function (method, url) {
    this.__api = { method: method, url: url, headers: {}, t: performance.now() };
    return originalOpen.apply(this, arguments);
  };

  XHR.setRequestHeader = function (k, v) {
    this.__api = this.__api || { headers: {} };
    this.__api.headers[k] = v;
    return originalSetHeader.apply(this, arguments);
  };

  XHR.send = function (body) {
    var xhr = this;
    xhr.__api = xhr.__api || { headers: {} };
    xhr.__api.body = body;
    xhr.addEventListener('loadend', function () {
      add({
        url: absURL(xhr.__api.url),
        method: String(xhr.__api.method || 'GET'),
        reqHeaders: xhr.__api.headers || {},
        requestBody: xhr.__api.body,
        ms: Math.round(performance.now() - (xhr.__api.t || performance.now())),
        time: nowTime(),
        status: xhr.status,
        statusText: xhr.statusText || ((xhr.status >= 200 && xhr.status < 300) ? 'OK' : 'ERR'),
        ok: xhr.status >= 200 && xhr.status < 300,
        responseText: xhr.responseText || '',
        pretty: safeJSON(xhr.responseText || ''),
        expanded: false
      });
    }, { once: true });
    return originalSend.apply(this, arguments);
  };

  function copyAllCurl() {
    return state.items.map(function (e) {
      return buildCurl(e.method, e.url, e.reqHeaders, e.requestBody);
    }).join('\n\n');
  }

  panel.querySelector('[data-act="hide"]').onclick = function () {
    state.hidden = !state.hidden;
    body.style.display = state.hidden ? 'none' : 'block';
    dock.style.display = state.hidden ? 'block' : 'none';
    panel.querySelector('[data-act="hide"]').textContent = state.hidden ? 'Show' : 'Hide';
  };

  panel.querySelector('[data-act="clear"]').onclick = function () {
    state.items = [];
    render();
  };

  panel.querySelector('[data-act="copyall"]').onclick = function () {
    copyText(copyAllCurl()).then(function () { toast('All cURL copied'); });
  };

  panel.querySelector('[data-act="close"]').onclick = function () {
    try {
      if (originalFetch) window.fetch = originalFetch;
      XHR.open = originalOpen;
      XHR.send = originalSend;
      XHR.setRequestHeader = originalSetHeader;
    } catch (e) {}
    window.__apiTerminalLoaded = null;
    if (panel.parentNode) panel.parentNode.removeChild(panel);
  };

  dock.onclick = function () {
    panel.querySelector('[data-act="hide"]').click();
  };

  window.__apiTerminalLoaded = {
    toggle: function () { panel.querySelector('[data-act="hide"]').click(); },
    clear: function () { panel.querySelector('[data-act="clear"]').click(); },
    copyAll: copyAllCurl
  };

  var drag = false, dx = 0, dy = 0;
  var head = panel.querySelector('#__api_terminal_head');

  head.addEventListener('pointerdown', function (e) {
    if (e.target && e.target.tagName === 'BUTTON') return;
    drag = true;
    dx = e.clientX - panel.getBoundingClientRect().left;
    dy = e.clientY - panel.getBoundingClientRect().top;
    try { head.setPointerCapture(e.pointerId); } catch (err) {}
  });

  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    panel.style.left = Math.max(6, Math.min(window.innerWidth - panel.offsetWidth - 6, e.clientX - dx)) + 'px';
    panel.style.top = Math.max(6, Math.min(window.innerHeight - panel.offsetHeight - 6, e.clientY - dy)) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });

  window.addEventListener('pointerup', function () { drag = false; });

  render();
  toast('Installed. Reload the page, then trigger the API call.');
})();
