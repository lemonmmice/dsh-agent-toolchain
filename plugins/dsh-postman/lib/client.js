/**
 * dsh-postman — client half (browser bundle, hand-built for the
 * __ModuleLoader__ format; no build step).
 *
 * Mounts the 「接口调试」 sidebar entry and a Postman-style panel in the center
 * column: a method + URL + Send bar, tabbed request editors (请求头 / 请求体 /
 * 历史), and a response view (status/time/size, response headers, pretty body).
 * The actual HTTP request runs on the host (POST /api/dsh-postman/send) so
 * there is no browser CORS wall; history comes from the same route family via
 * plain same-origin fetch. When the URL scheme is ws:// or wss://, the panel
 * switches to a WebSocket client (connect / live message log / send) that the
 * browser opens directly. Plain DOM everywhere (no React).
 */
window.__ModuleLoader__.load({
  id: '@dsh-agent-toolchain/dsh-postman',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const API = '/api/dsh-postman'
    const ENTRY_SEL = '[data-dsh-postman-entry]'
    const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']

    const CSS = `
[data-dsh-postman-view]{position:absolute;inset:0;z-index:60;display:none;flex-direction:column;
background:var(--dsw-alias-bg-base,#171a21);color:var(--dsw-alias-fg-base,#e6e6e6);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
html[data-dsh-postman-active] [data-dsh-postman-view]{display:flex}
.pm-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#2a2e37)}
.pm-title{font-weight:600;font-size:14px;margin-right:4px;white-space:nowrap}
.pm-method{background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:5px 6px;font:inherit;font-weight:600}
.pm-url{flex:1 1 auto;min-width:120px;background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:6px 10px;font:inherit}
.pm-btn{background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:5px 12px;cursor:pointer;font:inherit;white-space:nowrap}
.pm-btn:hover{background:var(--dsw-alias-bg-hover,#262b35)}
.pm-btn:disabled{opacity:.55;cursor:default}
.pm-send{background:#1e3a5f;border-color:#2a527f;color:#8ec5ff;font-weight:600}
.pm-send:hover{background:#244a75}
.pm-btn[data-active]{background:var(--dsw-alias-bg-hover,#262b35);border-color:#60a5fa;color:#8ec5ff}
.pm-fmt{margin-left:auto;padding:3px 10px}
.pm-btn-danger:hover{border-color:#c0392b;color:#e74c3c}
.pm-close{margin-left:4px;font-size:16px;line-height:1;padding:4px 9px}
.pm-body{flex:1;display:flex;flex-direction:column;overflow:hidden}
.pm-req{flex:0 0 46%;display:flex;flex-direction:column;overflow:hidden;min-height:120px}
.pm-resp{flex:1;display:flex;flex-direction:column;overflow:hidden;border-top:1px solid var(--dsw-alias-border-subtle,#2a2e37);min-height:120px}
.pm-tabs{display:flex;align-items:center;gap:4px;padding:6px 12px 0;flex-wrap:wrap}
.pm-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-fg-muted,#9aa0aa);padding:4px 10px 6px;cursor:pointer;font:inherit}
.pm-tab:hover{color:var(--dsw-alias-fg-base,#e6e6e6)}
.pm-tab[data-active]{color:var(--dsw-alias-fg-base,#e6e6e6);border-bottom-color:#60a5fa}
.pm-tab .pm-count{color:var(--dsw-alias-fg-muted,#9aa0aa);font-size:11px}
.pm-pane{flex:1;overflow:auto;padding:8px 12px}
.pm-pane[hidden]{display:none}
.pm-hint{color:var(--dsw-alias-fg-muted,#9aa0aa);font-size:12px;margin:0 0 6px}
.pm-hrow{display:flex;gap:6px;margin-bottom:6px;align-items:center}
.pm-hrow input{background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:4px 8px;font:inherit}
.pm-hkey{flex:0 0 34%;min-width:90px}
.pm-hval{flex:1 1 auto;min-width:90px}
.pm-hdel{flex:none;background:none;border:none;color:var(--dsw-alias-fg-muted,#9aa0aa);cursor:pointer;font-size:15px;padding:2px 6px;border-radius:4px}
.pm-hdel:hover{color:#e74c3c}
.pm-bodybar{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.pm-textarea{width:100%;box-sizing:border-box;min-height:120px;resize:vertical;background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:8px 10px;font:12px/1.5 Consolas,Menlo,monospace}
.pm-status{display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#23262e);flex-wrap:wrap}
.pm-status-meta{color:var(--dsw-alias-fg-muted,#9aa0aa);font-size:12px}
.pm-status-err{color:#f87171}
.pm-pre{margin:0;padding:10px 12px;font:12px/1.5 Consolas,Menlo,monospace;color:#9fe8a0;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;overflow:auto;flex:1}
.pm-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600}
.pm-m-get{background:#1b4d3a;color:#4ade80}.pm-m-post{background:#1e3a5f;color:#60a5fa}.pm-m-put{background:#4a3b14;color:#fbbf24}
.pm-m-delete{background:#4c1d1d;color:#f87171}.pm-m-other{background:#33363f;color:#cbd5e1}
.pm-s-2{background:#1b4d3a;color:#4ade80}.pm-s-3{background:#1e3a5f;color:#60a5fa}.pm-s-4{background:#4a3b14;color:#fbbf24}
.pm-s-5{background:#4c1d1d;color:#f87171}.pm-s-0{background:#33363f;color:#cbd5e1}
.pm-htable{width:100%;border-collapse:collapse;white-space:nowrap}
.pm-htable th{position:sticky;top:0;background:var(--dsw-alias-bg-elevated,#20242c);text-align:left;padding:5px 8px;font-size:12px;color:var(--dsw-alias-fg-muted,#9aa0aa);border-bottom:1px solid var(--dsw-alias-border-subtle,#2a2e37)}
.pm-htable td{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-subtle,#23262e);max-width:420px;overflow:hidden;text-overflow:ellipsis}
.pm-htable tbody tr{cursor:pointer}
.pm-htable tbody tr:hover{background:var(--dsw-alias-bg-hover,#20242c)}
.pm-empty{text-align:center;color:var(--dsw-alias-fg-muted,#9aa0aa);padding:30px 0}
.pm-entry{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;background:none;border:none;color:inherit;cursor:pointer;font:inherit;text-align:left}
.pm-entry:hover{background:var(--dsw-alias-bg-hover,#20242c)}
.pm-entry[data-active]{background:var(--dsw-alias-bg-hover,#20242c)}
.pm-entry .pm-entry-label{font-size:13px}
.pm-entry svg{flex:none}
.pm-proto{font-size:11px;font-weight:600;padding:2px 7px;border-radius:4px;background:#33363f;color:#cbd5e1;white-space:nowrap}
.pm-proto[data-proto="ws"]{background:#3a2c52;color:#c4a7f0}
.pm-proto[data-proto="tcp"]{background:#3a2c1a;color:#f0b878}
.pm-ws-proxy{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-fg-muted,#9aa0aa);white-space:nowrap;cursor:pointer}
.pm-proto[data-proto="grpc"]{background:#173a2e;color:#6ee7b7}
.pm-grpc{flex:1;display:flex;flex-direction:column;overflow:hidden}
.pm-grpc[hidden]{display:none}
.pm-grpc-body{flex:1;overflow:auto;padding:8px 12px;display:flex;flex-direction:column;gap:4px}
.pm-req[hidden],.pm-resp[hidden],.pm-ws[hidden]{display:none}
.pm-ws{flex:1;display:flex;flex-direction:column;overflow:hidden}
.pm-ws-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#2a2e37);flex-wrap:wrap}
.pm-ws-proto-in{width:170px;background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:4px 8px;font:inherit}
.pm-ws-dot{width:8px;height:8px;border-radius:50%;background:#c0392b;flex:none}
.pm-ws-dot[data-on="1"]{background:#2ecc71;box-shadow:0 0 6px #2ecc71}
.pm-ws-log{flex:1;overflow:auto;padding:6px 0;font:12px/1.6 Consolas,Menlo,monospace}
.pm-ws-msg{display:flex;gap:8px;padding:2px 12px;white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere}
.pm-ws-msg:hover{background:var(--dsw-alias-bg-hover,#20242c)}
.pm-ws-t{color:var(--dsw-alias-fg-muted,#9aa0aa);flex:none}
.pm-ws-dir{flex:none;font-weight:600;width:12px;text-align:center}
.pm-ws-txt{flex:1 1 auto}
.pm-ws-sent .pm-ws-dir{color:#4ade80}
.pm-ws-recv .pm-ws-dir{color:#60a5fa}
.pm-ws-sys .pm-ws-dir,.pm-ws-sys .pm-ws-txt{color:#9aa0aa}
.pm-ws-err .pm-ws-txt{color:#f87171}
.pm-ws-send{display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-subtle,#2a2e37)}
.pm-ws-in{flex:1;box-sizing:border-box;min-height:38px;max-height:120px;resize:vertical;background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:8px 10px;font:12px/1.4 Consolas,Menlo,monospace}
.pm-modal{position:absolute;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
.pm-modal[hidden]{display:none}
.pm-modal-box{width:min(680px,90%);max-height:80%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);border-radius:10px;overflow:hidden}
.pm-modal-title{padding:10px 14px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-subtle,#2a2e37)}
.pm-modal-ta{flex:1;min-height:200px;resize:vertical;margin:12px 14px;background:var(--dsw-alias-bg-base,#171a21);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:8px 10px;font:12px/1.5 Consolas,Menlo,monospace}
.pm-modal-bar{display:flex;justify-content:flex-end;gap:8px;padding:0 14px 12px}
.pm-save-form{padding:8px 14px;display:flex;flex-direction:column;gap:8px}
.pm-save-lbl{flex:0 0 64px;color:var(--dsw-alias-fg-muted,#9aa0aa);font-size:12px;align-self:center}
.pm-coltree{padding:2px 0}
.pm-col-row,.pm-req-row{display:flex;align-items:center;gap:8px;padding:4px 12px;cursor:pointer}
.pm-col-row:hover,.pm-req-row:hover{background:var(--dsw-alias-bg-hover,#20242c)}
.pm-col-caret{flex:none;color:var(--dsw-alias-fg-muted,#9aa0aa);width:12px}
.pm-col-name{flex:1 1 auto;font-weight:600}
.pm-req-row{padding-left:30px}
.pm-req-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

    // ---------------------------------------------------------------- helpers

    function injectStyle() {
      if (typeof document === 'undefined' || document.getElementById('dsh-postman-style') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-postman-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function apiFetch(path, init) {
      const response = await fetch(API + path, init)
      let body
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`)
      return body
    }

    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className !== undefined && className !== '') node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    function fmtTime(ts) {
      const d = new Date(ts)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    function fmtDur(ms) {
      if (typeof ms !== 'number') return '-'
      return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
    }

    function fmtSize(bytes) {
      if (typeof bytes !== 'number') return '-'
      if (bytes < 1024) return `${bytes}B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
      return `${(bytes / 1024 / 1024).toFixed(2)}MB`
    }

    function methodBadge(method) {
      const cls = { GET: 'pm-m-get', POST: 'pm-m-post', PUT: 'pm-m-put', DELETE: 'pm-m-delete' }[method] || 'pm-m-other'
      return el('span', 'pm-badge ' + cls, method)
    }

    function statusBadge(status) {
      if (!Number.isInteger(status)) return el('span', 'pm-badge pm-s-0', '-')
      return el('span', 'pm-badge pm-s-' + Math.floor(status / 100), String(status))
    }

    /** HTML void elements — opening tags that never carry children. */
    const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

    /** Lowercased tag name from a tag token, or '' if not a tag. */
    function tagName(token) {
      const m = token.match(/^<\/?\s*([a-zA-Z0-9:-]+)/)
      return m !== null ? m[1].toLowerCase() : ''
    }

    /** Heuristic XML/HTML pretty-printer: one tag/text per line, indented. */
    function formatMarkup(input) {
      const collapsed = input.replace(/\r\n/g, '\n').replace(/>\s+</g, '><')
      const tokens = collapsed.split(/(<[^>]+>)/g).filter((t) => t !== '' && t.trim() !== '')
      let indent = 0
      const out = []
      const pad = () => '  '.repeat(Math.max(indent, 0))
      for (const token of tokens) {
        if (/^<\//.test(token)) {
          indent = Math.max(indent - 1, 0)
          out.push(pad() + token)
        } else if (/^<[!?]/.test(token) || /\/>$/.test(token)) {
          out.push(pad() + token) // <!doctype>, <?xml?>, or self-closing
        } else if (/^<[a-zA-Z]/.test(token)) {
          out.push(pad() + token)
          if (!HTML_VOID.has(tagName(token))) indent += 1
        } else {
          out.push(pad() + token.trim()) // text node
        }
      }
      return out.join('\n')
    }

    /** Beautify a response body by content type: JSON, XML/HTML, else raw. Never throws. */
    function beautify(text, contentType) {
      if (typeof text !== 'string' || text.trim() === '') return text ?? ''
      const ct = (contentType || '').toLowerCase()
      try {
        if (ct.includes('json') || /^\s*[[{]/.test(text)) {
          return JSON.stringify(JSON.parse(text), null, 2)
        }
        if (ct.includes('xml') || ct.includes('html') || /^\s*<(\?xml|!doctype|[a-zA-Z])/i.test(text)) {
          return formatMarkup(text)
        }
      } catch {
        // malformed — fall through to raw
      }
      return text
    }

    function headersToText(headers) {
      if (headers === null || typeof headers !== 'object') return ''
      return Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    }

    // ---------------------------------------------- workflow helpers (pure)

    /** Substitute {{var}} using an env map; leaves unknown vars untouched. */
    function substVars(str, env) {
      if (typeof str !== 'string' || str.indexOf('{{') === -1) return str
      return str.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, k) => (env && Object.prototype.hasOwnProperty.call(env, k) ? env[k] : m))
    }

    /** Parse a KEY=VALUE-per-line env block into a map (ignores blanks / # comments). */
    function parseEnvText(text) {
      const env = {}
      for (const line of String(text ?? '').split('\n')) {
        const t = line.trim()
        if (t === '' || t.startsWith('#')) continue
        const i = t.indexOf('=')
        if (i <= 0) continue
        env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
      }
      return env
    }

    /** base64 for Basic auth (latin1-safe fallback for non-ascii). */
    function b64(s) {
      try {
        return btoa(s)
      } catch {
        return btoa(unescape(encodeURIComponent(s)))
      }
    }

    /** Authorization header value from an auth config, or '' for none. */
    function authHeaderValue(auth) {
      if (!auth || auth.type === 'none') return ''
      if (auth.type === 'bearer') return auth.token ? 'Bearer ' + auth.token : ''
      if (auth.type === 'basic') return auth.user || auth.pass ? 'Basic ' + b64((auth.user || '') + ':' + (auth.pass || '')) : ''
      return ''
    }

    /** Tokenize a shell-ish command respecting quotes and line continuations. */
    function shellTokens(text) {
      const s = String(text ?? '').replace(/\\\r?\n/g, ' ')
      const tokens = []
      const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
      let m
      while ((m = re.exec(s)) !== null) {
        if (m[1] !== undefined) tokens.push(m[1].replace(/\\(.)/g, '$1'))
        else if (m[2] !== undefined) tokens.push(m[2])
        else tokens.push(m[3])
      }
      return tokens
    }

    /** Parse a curl command into { method, url, headers, body }. Best-effort. */
    function parseCurl(text) {
      const tokens = shellTokens(text)
      const out = { method: '', url: '', headers: {}, body: '' }
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]
        if (t === 'curl') continue
        if (t === '-X' || t === '--request') {
          out.method = (tokens[++i] || '').toUpperCase()
        } else if (t === '-H' || t === '--header') {
          const h = tokens[++i] || ''
          const j = h.indexOf(':')
          if (j > 0) out.headers[h.slice(0, j).trim()] = h.slice(j + 1).trim()
        } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii' || t === '--data-urlencode') {
          out.body += (out.body ? '&' : '') + (tokens[++i] || '')
        } else if (t === '-u' || t === '--user') {
          out.headers['Authorization'] = 'Basic ' + b64(tokens[++i] || '')
        } else if (t === '-b' || t === '--cookie') {
          out.headers['Cookie'] = tokens[++i] || ''
        } else if (t === '-A' || t === '--user-agent') {
          out.headers['User-Agent'] = tokens[++i] || ''
        } else if (t === '-e' || t === '--referer') {
          out.headers['Referer'] = tokens[++i] || ''
        } else if (t === '--url') {
          out.url = tokens[++i] || ''
        } else if (t.startsWith('-')) {
          // skip other flags (best-effort)
        } else if (out.url === '') {
          out.url = t
        }
      }
      if (out.method === '') out.method = out.body !== '' ? 'POST' : 'GET'
      return out
    }

    /** Single-quote-escape for a POSIX shell. */
    function shq(s) {
      return "'" + String(s ?? '').replace(/'/g, "'\\''") + "'"
    }

    /** Build a curl command string from a { method, url, headers, body } request. */
    function toCurl(req) {
      const parts = ['curl -X ' + (req.method || 'GET') + ' ' + shq(req.url || '')]
      for (const [k, v] of Object.entries(req.headers || {})) parts.push('-H ' + shq(k + ': ' + v))
      if (req.body && req.method !== 'GET' && req.method !== 'HEAD') parts.push('--data-raw ' + shq(req.body))
      return parts.join(' \\\n  ')
    }

    // ---- URL ⇄ query-string helpers (raw passthrough, no encode/decode; WYSIWYG)

    /** Split a URL into { base, query, hash } — query without '?', hash without '#'. */
    function parseUrlParts(url) {
      let rest = String(url ?? '')
      let hash = ''
      const hi = rest.indexOf('#')
      if (hi >= 0) {
        hash = rest.slice(hi + 1)
        rest = rest.slice(0, hi)
      }
      let query = ''
      let base = rest
      const qi = rest.indexOf('?')
      if (qi >= 0) {
        query = rest.slice(qi + 1)
        base = rest.slice(0, qi)
      }
      return { base, query, hash }
    }

    /** Parse a raw query string into ordered [{ key, value }] (raw, split on first '='). */
    function splitQuery(query) {
      const out = []
      for (const part of String(query ?? '').split('&')) {
        if (part === '') continue
        const i = part.indexOf('=')
        if (i < 0) out.push({ key: part, value: '' })
        else out.push({ key: part.slice(0, i), value: part.slice(i + 1) })
      }
      return out
    }

    /** Serialize [{ key, value }] back to a raw query string (skips empty keys). */
    function buildQuery(pairs) {
      return pairs
        .filter((p) => p.key !== '')
        .map((p) => p.key + '=' + p.value)
        .join('&')
    }

    /** Reassemble a URL from base + param pairs + optional hash. */
    function buildUrlWithParams(base, pairs, hash) {
      const q = buildQuery(pairs)
      return base + (q !== '' ? '?' + q : '') + (hash !== '' ? '#' + hash : '')
    }

    // ------------------------------------------------------------ sidebar entry
    // (robust placement mirrors dsh-api-visualizer / dsh-ssh)

    function sidebarRoot() {
      const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
      if (column === null) return undefined
      const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement
      return logoOwner ?? column.firstElementChild
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]')
      if (nested !== null) return nested
      for (const child of root.children) {
        if (child.tagName === 'BUTTON') return child
      }
      return undefined
    }

    const ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 1.5L7 9M14.5 1.5l-4.5 13-2.8-5.7L1.5 5 14.5 1.5z"/></svg>`

    function createEntry(toggle) {
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.dataset.dshPostmanEntry = ''
      entry.className = 'pm-entry'
      entry.setAttribute('aria-label', '接口调试')
      entry.innerHTML = `<span>${ICON}</span><span class="pm-entry-label">接口调试</span>`
      entry.addEventListener('click', toggle)
      return entry
    }

    function placeEntry(root, entry) {
      const button = newSessionButton(root)
      if (button === undefined) return false
      if (entry.parentElement !== root) {
        const row = button.closest('[class*="logoRow"]')
        const base = row !== null && row.parentElement === root ? row : button
        const family = Array.from(root.children).filter(
          (child) =>
            child instanceof HTMLElement &&
            child.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-apiviz-entry], [data-dsh-postman-entry]'),
        )
        const anchor = family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling
        root.insertBefore(entry, anchor)
      }
      return true
    }

    function mountSidebarEntry(toggle) {
      if (typeof document !== 'undefined' && document.querySelector(ENTRY_SEL) !== null) return () => {}
      const entry = createEntry(toggle)
      let root
      let placed = false
      const tryPlace = () => {
        if (root !== undefined && !root.isConnected) {
          rootObserver.disconnect()
          root = undefined
          placed = false
        }
        if (placed) {
          if (document.body.contains(entry)) return
          rootObserver.disconnect()
          root = undefined
          placed = false
        }
        root ??= sidebarRoot()
        if (root === undefined) return
        placed = placeEntry(root, entry)
        if (placed) rootObserver.observe(root, { childList: true, subtree: true })
      }
      const waitObserver = new MutationObserver(() => {
        tryPlace()
      })
      waitObserver.observe(document.body, { childList: true, subtree: true })
      const rootObserver = new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placed = false
          tryPlace()
          return
        }
        if (!root.contains(entry)) placed = placeEntry(root, entry)
      })
      tryPlace()
      return () => {
        waitObserver.disconnect()
        rootObserver.disconnect()
        entry.remove()
      }
    }

    // ------------------------------------------------------------------ panel

    function centerColumn() {
      return document.querySelector('[data-pane="conversation"], [class*="centerCol"]') ?? document.body
    }

    /** Sibling exclusive panels — clear their active flags when we open. */
    function clearSiblings() {
      delete document.documentElement.dataset.dshTaskboardActive
      delete document.documentElement.dataset.dshSshActive
      delete document.documentElement.dataset.dshApivizActive
    }

    /** The view is a fixed overlay inside the center column (like api-visualizer). */
    function buildPanel() {
      const view = el('div')
      view.dataset.dshPostmanView = ''

      // -------- toolbar: method + url + send
      const toolbar = el('div', 'pm-toolbar')
      toolbar.appendChild(el('span', 'pm-title', '接口调试'))
      const protoBadge = el('span', 'pm-proto', 'HTTP')
      protoBadge.dataset.proto = 'http'
      protoBadge.title = 'URL 以 ws:// 或 wss:// 开头时自动切到 WebSocket'
      toolbar.appendChild(protoBadge)
      const methodSel = el('select', 'pm-method')
      METHODS.forEach((m) => {
        const opt = el('option', '', m)
        opt.value = m
        methodSel.appendChild(opt)
      })
      toolbar.appendChild(methodSel)
      const urlInput = el('input', 'pm-url')
      urlInput.placeholder = 'https:// · wss:// · tcp://host:port · grpc://host:port（按协议自动切换）'
      urlInput.spellcheck = false
      toolbar.appendChild(urlInput)
      const sendBtn = el('button', 'pm-btn pm-send', '发送')
      toolbar.appendChild(sendBtn)
      const closeBtn = el('button', 'pm-btn pm-close', '×')
      closeBtn.title = '关闭 (Esc)'
      toolbar.appendChild(closeBtn)
      view.appendChild(toolbar)

      const body = el('div', 'pm-body')

      // -------- request region: tabs (headers / body / history)
      const req = el('div', 'pm-req')
      const reqTabs = el('div', 'pm-tabs')
      const tabParams = el('button', 'pm-tab', '查询参数')
      const paramsCount = el('span', 'pm-count', '')
      tabParams.appendChild(document.createTextNode(' '))
      tabParams.appendChild(paramsCount)
      const tabHeaders = el('button', 'pm-tab', '请求头')
      const headersCount = el('span', 'pm-count', '')
      tabHeaders.appendChild(document.createTextNode(' '))
      tabHeaders.appendChild(headersCount)
      const tabBody = el('button', 'pm-tab', '请求体')
      const tabAuth = el('button', 'pm-tab', '鉴权')
      const tabCol = el('button', 'pm-tab', '集合')
      const tabHistory = el('button', 'pm-tab', '历史')
      reqTabs.appendChild(tabParams)
      reqTabs.appendChild(tabHeaders)
      reqTabs.appendChild(tabBody)
      reqTabs.appendChild(tabAuth)
      reqTabs.appendChild(tabCol)
      reqTabs.appendChild(tabHistory)
      const envBtn = el('button', 'pm-btn pm-fmt', '环境变量')
      envBtn.title = '管理 {{变量}}（发送时替换 URL / 请求头 / body）'
      const curlInBtn = el('button', 'pm-btn', '导入 cURL')
      const curlOutBtn = el('button', 'pm-btn', '复制 cURL')
      reqTabs.appendChild(envBtn)
      reqTabs.appendChild(curlInBtn)
      reqTabs.appendChild(curlOutBtn)
      req.appendChild(reqTabs)

      // query-params editor pane (two-way synced with the URL's query string)
      const paramsPane = el('div', 'pm-pane')
      paramsPane.appendChild(el('p', 'pm-hint', '查询参数与上方 URL 实时同步：改这里 URL 跟着变，改 URL 这里也跟着变；留空的行忽略。值按原样拼接（不自动转义）。'))
      const paramsList = el('div')
      paramsPane.appendChild(paramsList)
      req.appendChild(paramsPane)

      // headers editor pane
      const headersPane = el('div', 'pm-pane')
      headersPane.appendChild(el('p', 'pm-hint', '键值对形式的请求头；留空的行会被忽略。'))
      const headersList = el('div')
      headersPane.appendChild(headersList)
      req.appendChild(headersPane)

      // body pane
      const bodyPane = el('div', 'pm-pane')
      bodyPane.hidden = true
      const bodyBar = el('div', 'pm-bodybar')
      const bodyModeSel = el('select', 'pm-method')
      ;[['raw', 'Raw'], ['graphql', 'GraphQL']].forEach(([v, label]) => {
        const o = el('option', '', label)
        o.value = v
        bodyModeSel.appendChild(o)
      })
      bodyBar.appendChild(bodyModeSel)
      const jsonBtn = el('button', 'pm-btn', '美化 JSON')
      const jsonCtBtn = el('button', 'pm-btn', '设为 JSON 头')
      const gqlIntrospectBtn = el('button', 'pm-btn', '内省查询')
      gqlIntrospectBtn.hidden = true
      bodyBar.appendChild(jsonBtn)
      bodyBar.appendChild(jsonCtBtn)
      bodyBar.appendChild(gqlIntrospectBtn)
      bodyPane.appendChild(bodyBar)
      const bodyText = el('textarea', 'pm-textarea')
      bodyText.placeholder = '{\n  "key": "value"\n}'
      bodyText.spellcheck = false
      bodyPane.appendChild(bodyText)
      // graphql editors (shown when body mode = GraphQL)
      const gqlWrap = el('div', 'pm-gql')
      gqlWrap.hidden = true
      gqlWrap.appendChild(el('p', 'pm-hint', 'GraphQL：发送时 POST {query, variables} 到 URL，自动带 application/json（method 会被强制为 POST）。'))
      gqlWrap.appendChild(el('div', 'pm-hint', 'Query'))
      const gqlQuery = el('textarea', 'pm-textarea')
      gqlQuery.placeholder = 'query {\n  \n}'
      gqlQuery.spellcheck = false
      gqlWrap.appendChild(gqlQuery)
      gqlWrap.appendChild(el('div', 'pm-hint', 'Variables (JSON)'))
      const gqlVars = el('textarea', 'pm-textarea')
      gqlVars.placeholder = '{}'
      gqlVars.spellcheck = false
      gqlVars.style.minHeight = '64px'
      gqlWrap.appendChild(gqlVars)
      bodyPane.appendChild(gqlWrap)
      req.appendChild(bodyPane)

      // auth pane
      const authPane = el('div', 'pm-pane')
      authPane.hidden = true
      authPane.appendChild(el('p', 'pm-hint', '发送时自动生成 Authorization 头（不写进上面的请求头列表；若已手填 Authorization 则不覆盖）。'))
      const authRow = el('div', 'pm-bodybar')
      authRow.appendChild(el('span', 'pm-hint', '类型'))
      const authSel = el('select', 'pm-method')
      ;[['none', '无'], ['bearer', 'Bearer Token'], ['basic', 'Basic Auth']].forEach(([v, label]) => {
        const opt = el('option', '', label)
        opt.value = v
        authSel.appendChild(opt)
      })
      authRow.appendChild(authSel)
      authPane.appendChild(authRow)
      const authBearer = el('div', 'pm-hrow')
      authBearer.hidden = true
      const authToken = el('input', 'pm-hval')
      authToken.placeholder = 'Token（不含 Bearer 前缀，可用 {{变量}}）'
      authToken.spellcheck = false
      authBearer.appendChild(authToken)
      authPane.appendChild(authBearer)
      const authBasic = el('div', 'pm-hrow')
      authBasic.hidden = true
      const authUser = el('input', 'pm-hkey')
      authUser.placeholder = '用户名'
      authUser.spellcheck = false
      const authPass = el('input', 'pm-hval')
      authPass.placeholder = '密码'
      authPass.spellcheck = false
      authBasic.appendChild(authUser)
      authBasic.appendChild(authPass)
      authPane.appendChild(authBasic)
      req.appendChild(authPane)

      // collections pane
      const colPane = el('div', 'pm-pane')
      colPane.hidden = true
      const colBar = el('div', 'pm-bodybar')
      const saveReqBtn = el('button', 'pm-btn pm-send', '保存当前请求')
      colBar.appendChild(saveReqBtn)
      colBar.appendChild(el('span', 'pm-hint', '点集合名展开/收起，点请求名载入编辑器'))
      colPane.appendChild(colBar)
      const colTree = el('div', 'pm-coltree')
      colPane.appendChild(colTree)
      req.appendChild(colPane)

      // history pane
      const historyPane = el('div', 'pm-pane')
      historyPane.hidden = true
      const historyBar = el('div', 'pm-bodybar')
      const historyRefresh = el('button', 'pm-btn', '刷新')
      const historyClear = el('button', 'pm-btn pm-btn-danger', '清空')
      historyBar.appendChild(historyRefresh)
      historyBar.appendChild(historyClear)
      historyPane.appendChild(historyBar)
      const historyWrap = el('div')
      historyPane.appendChild(historyWrap)
      req.appendChild(historyPane)

      body.appendChild(req)

      // -------- response region: status line + tabs (body / headers)
      const resp = el('div', 'pm-resp')
      const statusLine = el('div', 'pm-status')
      statusLine.appendChild(el('span', 'pm-status-meta', '尚未发送请求'))
      resp.appendChild(statusLine)
      const respTabs = el('div', 'pm-tabs')
      const tabRespBody = el('button', 'pm-tab', '响应体')
      const tabRespHeaders = el('button', 'pm-tab', '响应头')
      respTabs.appendChild(tabRespBody)
      respTabs.appendChild(tabRespHeaders)
      const fmtBtn = el('button', 'pm-btn pm-fmt', '格式化')
      fmtBtn.title = '在「格式化」与「原始」之间切换响应体'
      fmtBtn.dataset.active = '' // formatted is on by default
      respTabs.appendChild(fmtBtn)
      resp.appendChild(respTabs)
      const respBodyPre = el('pre', 'pm-pre')
      const respHeadersPre = el('pre', 'pm-pre')
      respHeadersPre.hidden = true
      resp.appendChild(respBodyPre)
      resp.appendChild(respHeadersPre)
      body.appendChild(resp)

      // -------- websocket region: shown when the URL scheme is ws:// or wss://
      const wsView = el('div', 'pm-ws')
      wsView.hidden = true
      const wsBar = el('div', 'pm-ws-bar')
      const wsDot = el('span', 'pm-ws-dot')
      wsBar.appendChild(wsDot)
      const wsStatus = el('span', 'pm-status-meta', '未连接')
      wsBar.appendChild(wsStatus)
      const wsProtoIn = el('input', 'pm-ws-proto-in')
      wsProtoIn.placeholder = '子协议(可选, 逗号分隔)'
      wsProtoIn.spellcheck = false
      wsBar.appendChild(wsProtoIn)
      const wsProxyWrap = el('label', 'pm-ws-proxy')
      const wsProxyCb = el('input', '')
      wsProxyCb.type = 'checkbox'
      wsProxyWrap.appendChild(wsProxyCb)
      wsProxyWrap.appendChild(document.createTextNode(' 经宿主(带鉴权头)'))
      wsProxyWrap.title = '勾选后由宿主发起握手，把「请求头/鉴权」里的头带进 WS 握手（浏览器直连做不到）'
      wsBar.appendChild(wsProxyWrap)
      const wsClearBtn = el('button', 'pm-btn pm-fmt', '清空日志')
      wsBar.appendChild(wsClearBtn)
      wsView.appendChild(wsBar)
      const wsLog = el('div', 'pm-ws-log')
      wsView.appendChild(wsLog)
      const wsSend = el('div', 'pm-ws-send')
      const wsInput = el('textarea', 'pm-ws-in')
      wsInput.placeholder = '消息内容；Enter 发送，Shift+Enter 换行'
      wsInput.spellcheck = false
      wsSend.appendChild(wsInput)
      const wsSendBtn = el('button', 'pm-btn pm-send', '发送')
      wsSend.appendChild(wsSendBtn)
      wsView.appendChild(wsSend)
      body.appendChild(wsView)

      // -------- gRPC region: shown when the URL scheme is grpc://
      const grpcView = el('div', 'pm-grpc')
      grpcView.hidden = true
      const grpcBar = el('div', 'pm-ws-bar')
      const grpcParseBtn = el('button', 'pm-btn', '解析 proto')
      grpcBar.appendChild(grpcParseBtn)
      const grpcTlsWrap = el('label', 'pm-ws-proxy')
      const grpcTlsCb = el('input', '')
      grpcTlsCb.type = 'checkbox'
      grpcTlsWrap.appendChild(grpcTlsCb)
      grpcTlsWrap.appendChild(document.createTextNode(' TLS'))
      grpcBar.appendChild(grpcTlsWrap)
      grpcBar.appendChild(el('span', 'pm-hint', '服务'))
      const grpcSvcSel = el('select', 'pm-method')
      grpcBar.appendChild(grpcSvcSel)
      grpcBar.appendChild(el('span', 'pm-hint', '方法'))
      const grpcMethodSel = el('select', 'pm-method')
      grpcBar.appendChild(grpcMethodSel)
      const grpcStatus = el('span', 'pm-status-meta', '')
      grpcBar.appendChild(grpcStatus)
      grpcView.appendChild(grpcBar)
      const grpcBodyWrap = el('div', 'pm-grpc-body')
      grpcBodyWrap.appendChild(el('div', 'pm-hint', '.proto（可粘贴；暂不支持 import 其它文件。metadata 取自「请求头/鉴权」，在 HTTP 模式下设好）'))
      const grpcProto = el('textarea', 'pm-textarea')
      grpcProto.placeholder = 'syntax = "proto3";\npackage demo;\nservice Greeter { rpc SayHello (Req) returns (Resp); }\nmessage Req { string name = 1; }\nmessage Resp { string message = 1; }'
      grpcProto.spellcheck = false
      grpcBodyWrap.appendChild(grpcProto)
      grpcBodyWrap.appendChild(el('div', 'pm-hint', '请求 message (JSON，支持 {{env}})'))
      const grpcReq = el('textarea', 'pm-textarea')
      grpcReq.placeholder = '{\n  "name": "world"\n}'
      grpcReq.spellcheck = false
      grpcReq.style.minHeight = '80px'
      grpcBodyWrap.appendChild(grpcReq)
      grpcBodyWrap.appendChild(el('div', 'pm-hint', '响应'))
      const grpcResp = el('pre', 'pm-pre')
      grpcBodyWrap.appendChild(grpcResp)
      grpcView.appendChild(grpcBodyWrap)
      body.appendChild(grpcView)

      view.appendChild(body)

      // -------- generic modal (env editor / curl import)
      const modal = el('div', 'pm-modal')
      modal.hidden = true
      const modalBox = el('div', 'pm-modal-box')
      const modalTitle = el('div', 'pm-modal-title', '')
      const modalTa = el('textarea', 'pm-modal-ta')
      modalTa.spellcheck = false
      const modalBar = el('div', 'pm-modal-bar')
      const modalCancel = el('button', 'pm-btn', '取消')
      const modalOk = el('button', 'pm-btn pm-send', '确定')
      modalBar.appendChild(modalCancel)
      modalBar.appendChild(modalOk)
      modalBox.appendChild(modalTitle)
      modalBox.appendChild(modalTa)
      modalBox.appendChild(modalBar)
      modal.appendChild(modalBox)
      view.appendChild(modal)

      // -------- save-to-collection dialog
      const saveDlg = el('div', 'pm-modal')
      saveDlg.hidden = true
      const saveBox = el('div', 'pm-modal-box')
      saveBox.appendChild(el('div', 'pm-modal-title', '保存请求到集合'))
      const saveForm = el('div', 'pm-save-form')
      const saveNameRow = el('div', 'pm-hrow')
      saveNameRow.appendChild(el('span', 'pm-save-lbl', '名称'))
      const saveNameIn = el('input', 'pm-hval')
      saveNameIn.spellcheck = false
      saveNameRow.appendChild(saveNameIn)
      saveForm.appendChild(saveNameRow)
      const saveColRow = el('div', 'pm-hrow')
      saveColRow.appendChild(el('span', 'pm-save-lbl', '集合'))
      const saveColSel = el('select', 'pm-method')
      saveColRow.appendChild(saveColSel)
      saveForm.appendChild(saveColRow)
      const saveNewColRow = el('div', 'pm-hrow')
      saveNewColRow.hidden = true
      saveNewColRow.appendChild(el('span', 'pm-save-lbl', '新集合名'))
      const saveNewColIn = el('input', 'pm-hval')
      saveNewColIn.spellcheck = false
      saveNewColRow.appendChild(saveNewColIn)
      saveForm.appendChild(saveNewColRow)
      saveBox.appendChild(saveForm)
      const saveBar = el('div', 'pm-modal-bar')
      const saveCancel = el('button', 'pm-btn', '取消')
      const saveOk = el('button', 'pm-btn pm-send', '保存')
      saveBar.appendChild(saveCancel)
      saveBar.appendChild(saveOk)
      saveBox.appendChild(saveBar)
      saveDlg.appendChild(saveBox)
      view.appendChild(saveDlg)

      // -------------------------------------------------------------- state
      const state = {
        open: false,
        sending: false,
        formatted: true,
        respRaw: '',
        respContentType: '',
        mode: 'http',
        transport: null,
        wsConnected: false,
        auth: { type: 'none', token: '', user: '', pass: '' },
        env: {},
        envText: '',
        collections: [],
        bodyMode: 'raw',
        grpcCalling: false,
      }

      // ---- headers editor: always keep one trailing empty row
      function addHeaderRow(key, value) {
        const row = el('div', 'pm-hrow')
        const keyInput = el('input', 'pm-hkey')
        keyInput.placeholder = 'Header'
        keyInput.spellcheck = false
        if (key !== undefined) keyInput.value = key
        const valInput = el('input', 'pm-hval')
        valInput.placeholder = 'Value'
        valInput.spellcheck = false
        if (value !== undefined) valInput.value = value
        const delBtn = el('button', 'pm-hdel', '×')
        delBtn.title = '删除'
        delBtn.addEventListener('click', () => {
          row.remove()
          ensureTrailingRow()
          updateHeadersCount()
        })
        const onInput = () => {
          ensureTrailingRow()
          updateHeadersCount()
        }
        keyInput.addEventListener('input', onInput)
        valInput.addEventListener('input', onInput)
        row.appendChild(keyInput)
        row.appendChild(valInput)
        row.appendChild(delBtn)
        headersList.appendChild(row)
        return row
      }

      function ensureTrailingRow() {
        const rows = Array.from(headersList.children)
        const last = rows[rows.length - 1]
        const lastKey = last?.querySelector('.pm-hkey')?.value ?? ''
        const lastVal = last?.querySelector('.pm-hval')?.value ?? ''
        if (rows.length === 0 || lastKey.trim() !== '' || lastVal.trim() !== '') addHeaderRow()
      }

      function updateHeadersCount() {
        headersCount.textContent = `(${collectHeaders().count})`
      }

      function collectHeaders() {
        const headers = {}
        let count = 0
        for (const row of headersList.children) {
          const key = row.querySelector('.pm-hkey')?.value.trim() ?? ''
          const value = row.querySelector('.pm-hval')?.value ?? ''
          if (key === '') continue
          headers[key] = value
          count += 1
        }
        return { headers, count }
      }

      function setHeaders(map) {
        headersList.textContent = ''
        if (map !== null && typeof map === 'object') {
          for (const [k, v] of Object.entries(map)) addHeaderRow(k, String(v))
        }
        ensureTrailingRow()
        updateHeadersCount()
      }

      setHeaders({})

      // ---- query-params editor: a live, two-way-synced view of the URL's query
      // string. Editing a row rewrites the URL above; editing the URL rebuilds
      // these rows. The URL bar stays the single source of truth for sending.
      let paramSync = false // guard against URL⇄params update loops

      function addParamRow(key, value) {
        const row = el('div', 'pm-hrow')
        const keyInput = el('input', 'pm-hkey')
        keyInput.placeholder = '参数名'
        keyInput.spellcheck = false
        if (key !== undefined) keyInput.value = key
        const valInput = el('input', 'pm-hval')
        valInput.placeholder = '值'
        valInput.spellcheck = false
        if (value !== undefined) valInput.value = value
        const delBtn = el('button', 'pm-hdel', '×')
        delBtn.title = '删除'
        delBtn.addEventListener('click', () => {
          row.remove()
          ensureTrailingParamRow()
          syncUrlFromParams()
          updateParamsCount()
        })
        const onInput = () => {
          ensureTrailingParamRow()
          syncUrlFromParams()
          updateParamsCount()
        }
        keyInput.addEventListener('input', onInput)
        valInput.addEventListener('input', onInput)
        row.appendChild(keyInput)
        row.appendChild(valInput)
        row.appendChild(delBtn)
        paramsList.appendChild(row)
        return row
      }

      function ensureTrailingParamRow() {
        const rows = Array.from(paramsList.children)
        const last = rows[rows.length - 1]
        const lastKey = last?.querySelector('.pm-hkey')?.value ?? ''
        const lastVal = last?.querySelector('.pm-hval')?.value ?? ''
        if (rows.length === 0 || lastKey.trim() !== '' || lastVal.trim() !== '') addParamRow()
      }

      function collectParams() {
        const pairs = []
        for (const row of paramsList.children) {
          const key = row.querySelector('.pm-hkey')?.value.trim() ?? ''
          const value = row.querySelector('.pm-hval')?.value ?? ''
          if (key === '') continue
          pairs.push({ key, value })
        }
        return pairs
      }

      function updateParamsCount() {
        paramsCount.textContent = `(${collectParams().length})`
      }

      // URL → params rows (rebuild the table from the current URL's query string)
      function setParamsFromUrl() {
        if (paramSync) return
        paramSync = true
        try {
          const parts = parseUrlParts(urlInput.value)
          paramsList.textContent = ''
          for (const p of splitQuery(parts.query)) addParamRow(p.key, p.value)
          ensureTrailingParamRow()
          updateParamsCount()
        } finally {
          paramSync = false
        }
      }

      // params rows → URL (rewrite the query string, keep base + hash intact)
      function syncUrlFromParams() {
        if (paramSync) return
        paramSync = true
        try {
          const parts = parseUrlParts(urlInput.value)
          urlInput.value = buildUrlWithParams(parts.base, collectParams(), parts.hash)
        } finally {
          paramSync = false
        }
      }

      // Set the URL programmatically and refresh the params view in one step.
      function setUrl(value) {
        urlInput.value = value ?? ''
        setParamsFromUrl()
      }

      setParamsFromUrl()

      // ---- request tab switching
      const reqTabDefs = [
        { tab: tabParams, pane: paramsPane },
        { tab: tabHeaders, pane: headersPane },
        { tab: tabBody, pane: bodyPane },
        { tab: tabAuth, pane: authPane },
        { tab: tabCol, pane: colPane },
        { tab: tabHistory, pane: historyPane },
      ]
      function selectReqTab(target) {
        for (const { tab, pane } of reqTabDefs) {
          const active = tab === target
          pane.hidden = !active
          if (active) tab.dataset.active = ''
          else delete tab.dataset.active
        }
        if (target === tabHistory) loadHistory()
        if (target === tabCol) renderCollections()
      }
      tabParams.addEventListener('click', () => selectReqTab(tabParams))
      tabHeaders.addEventListener('click', () => selectReqTab(tabHeaders))
      tabBody.addEventListener('click', () => selectReqTab(tabBody))
      tabAuth.addEventListener('click', () => selectReqTab(tabAuth))
      tabCol.addEventListener('click', () => selectReqTab(tabCol))
      tabHistory.addEventListener('click', () => selectReqTab(tabHistory))
      selectReqTab(tabParams)

      // ---- response tab switching
      function selectRespTab(showHeaders) {
        respBodyPre.hidden = showHeaders
        respHeadersPre.hidden = !showHeaders
        if (showHeaders) {
          tabRespHeaders.dataset.active = ''
          delete tabRespBody.dataset.active
        } else {
          tabRespBody.dataset.active = ''
          delete tabRespHeaders.dataset.active
        }
      }
      tabRespBody.addEventListener('click', () => selectRespTab(false))
      tabRespHeaders.addEventListener('click', () => selectRespTab(true))
      selectRespTab(false)

      // ---- format / raw toggle for the response body
      fmtBtn.addEventListener('click', () => {
        state.formatted = !state.formatted
        if (state.formatted) fmtBtn.dataset.active = ''
        else delete fmtBtn.dataset.active
        renderRespBody()
      })

      // ---- body helpers
      jsonBtn.addEventListener('click', () => {
        try {
          bodyText.value = JSON.stringify(JSON.parse(bodyText.value), null, 2)
        } catch (error) {
          window.alert('无法解析为 JSON：' + (error instanceof Error ? error.message : String(error)))
        }
      })
      jsonCtBtn.addEventListener('click', () => {
        const { headers } = collectHeaders()
        const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
        if (!hasCt) {
          setHeaders({ ...headers, 'Content-Type': 'application/json' })
        }
      })

      // ---- body mode (raw / graphql)
      function updateBodyMode() {
        const gql = state.bodyMode === 'graphql'
        bodyText.hidden = gql
        gqlWrap.hidden = !gql
        jsonBtn.hidden = gql
        jsonCtBtn.hidden = gql
        gqlIntrospectBtn.hidden = !gql
      }
      bodyModeSel.addEventListener('change', () => {
        state.bodyMode = bodyModeSel.value
        updateBodyMode()
      })
      gqlIntrospectBtn.addEventListener('click', () => {
        gqlQuery.value = 'query IntrospectionQuery {\n  __schema {\n    queryType { name }\n    mutationType { name }\n    types { name kind description }\n  }\n}'
        if (gqlVars.value.trim() === '') gqlVars.value = '{}'
      })
      updateBodyMode()

      // ---- response rendering
      function renderRespBody() {
        respBodyPre.textContent = state.formatted ? beautify(state.respRaw, state.respContentType) : state.respRaw
      }

      function renderResponse(response) {
        statusLine.textContent = ''
        if (response && response.ok) {
          statusLine.appendChild(statusBadge(response.status))
          const meta = el(
            'span',
            'pm-status-meta',
            `${response.statusText || ''} · ${fmtDur(response.durationMs)} · ${fmtSize(response.size)}${response.truncated ? ' · 已截断' : ''}`,
          )
          statusLine.appendChild(meta)
          state.respRaw = response.body ?? ''
          state.respContentType = response.contentType || ''
          renderRespBody()
          respHeadersPre.textContent = headersToText(response.headers)
        } else {
          const badge = el('span', 'pm-badge pm-s-5', '×')
          statusLine.appendChild(badge)
          statusLine.appendChild(el('span', 'pm-status-err', (response && response.error) || '请求失败'))
          if (response && Number.isFinite(response.durationMs)) statusLine.appendChild(el('span', 'pm-status-meta', fmtDur(response.durationMs)))
          state.respRaw = (response && response.error) || ''
          state.respContentType = ''
          respBodyPre.textContent = state.respRaw
          respHeadersPre.textContent = ''
        }
        selectRespTab(false)
      }

      // ---- send
      async function send() {
        if (state.sending) return
        const url = urlInput.value.trim()
        if (url === '') {
          urlInput.focus()
          return
        }
        state.sending = true
        sendBtn.disabled = true
        sendBtn.textContent = '发送中…'
        statusLine.textContent = ''
        statusLine.appendChild(el('span', 'pm-status-meta', '请求中…'))
        try {
          const payload = { ...buildRequest(), timeoutMs: 30000 }
          const result = await apiFetch('/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          renderResponse(result.response)
        } catch (error) {
          renderResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
        } finally {
          state.sending = false
          sendBtn.disabled = false
          sendBtn.textContent = '发送'
        }
      }
      // ---- protocol mode: auto-switch between HTTP and WebSocket by URL scheme
      const WS_MAX_LOG = 500

      function detectMode(url) {
        const u = url.trim()
        if (/^wss?:\/\//i.test(u)) return 'ws'
        if (/^tcp:\/\//i.test(u)) return 'tcp'
        if (/^grpc:\/\//i.test(u)) return 'grpc'
        return 'http'
      }

      function updateActionButton() {
        if (state.mode === 'ws' || state.mode === 'tcp') {
          sendBtn.textContent = state.wsConnected ? '断开' : '连接'
          sendBtn.disabled = false
        } else if (state.mode === 'grpc') {
          sendBtn.textContent = state.grpcCalling ? '调用中…' : '调用'
          sendBtn.disabled = state.grpcCalling
        } else {
          sendBtn.textContent = state.sending ? '发送中…' : '发送'
          sendBtn.disabled = state.sending
        }
      }

      function applyMode(mode) {
        if (mode === state.mode) return
        if (state.mode === 'ws' || state.mode === 'tcp') wsDisconnect() // leaving a live mode → drop connection
        state.mode = mode
        const isConn = mode === 'ws' || mode === 'tcp'
        const isHttp = mode === 'http'
        methodSel.style.display = isHttp ? '' : 'none'
        protoBadge.textContent = mode === 'tcp' ? 'TCP' : mode === 'ws' ? 'WS' : mode === 'grpc' ? 'gRPC' : 'HTTP'
        protoBadge.dataset.proto = mode === 'tcp' ? 'tcp' : mode === 'ws' ? 'ws' : mode === 'grpc' ? 'grpc' : 'http'
        req.hidden = !isHttp
        resp.hidden = !isHttp
        wsView.hidden = !isConn
        grpcView.hidden = mode !== 'grpc'
        wsProtoIn.style.display = mode === 'ws' ? '' : 'none'
        wsProxyWrap.style.display = mode === 'ws' ? '' : 'none'
        updateActionButton()
      }

      function wsLogMsg(dir, text) {
        const atEnd = wsLog.scrollHeight - wsLog.scrollTop - wsLog.clientHeight < 40
        const row = el('div', 'pm-ws-msg pm-ws-' + dir)
        row.appendChild(el('span', 'pm-ws-t', fmtTime(Date.now())))
        const sym = dir === 'sent' ? '↑' : dir === 'recv' ? '↓' : dir === 'err' ? '⚠' : '•'
        row.appendChild(el('span', 'pm-ws-dir', sym))
        row.appendChild(el('span', 'pm-ws-txt', text))
        wsLog.appendChild(row)
        while (wsLog.childElementCount > WS_MAX_LOG) wsLog.removeChild(wsLog.firstChild)
        if (atEnd) wsLog.scrollTop = wsLog.scrollHeight
      }

      function wsSetConnected(connected) {
        state.wsConnected = connected
        wsDot.dataset.on = connected ? '1' : '0'
        wsStatus.textContent = connected ? '已连接' : '未连接'
        wsSendBtn.disabled = !connected
        wsInput.disabled = !connected
        updateActionButton()
      }

      function currentTargetUrl() {
        return substVars(urlInput.value.trim(), state.env)
      }

      // headers for a host-proxied connection: 请求头 rows + 鉴权 + {{env}} 替换
      function liveHeaders() {
        const headers = collectHeaders().headers
        const authVal = authHeaderValue(state.auth)
        if (authVal !== '' && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) headers['Authorization'] = authVal
        return substHeaders(headers)
      }

      function proxyMsgText(ev) {
        if (ev.binary === false) return ev.data ?? ''
        if (typeof ev.text === 'string') return ev.text + (ev.truncated ? '  …(截断)' : '')
        return '[二进制 ' + (ev.size ?? '?') + ' 字节] ' + String(ev.data || '').slice(0, 160)
      }

      // browser-native WebSocket (plain ws:// without custom headers)
      function connectBrowserWs(url) {
        const subs = wsProtoIn.value.split(',').map((s) => s.trim()).filter((s) => s !== '')
        let socket
        try {
          socket = subs.length > 0 ? new WebSocket(url, subs) : new WebSocket(url)
        } catch (error) {
          wsLogMsg('err', '连接失败: ' + (error instanceof Error ? error.message : String(error)))
          return
        }
        socket.binaryType = 'arraybuffer'
        const transport = {
          kind: 'browser',
          send: (t) => socket.send(t),
          close: () => {
            try {
              socket.close(1000, 'client closed')
            } catch {
              /* ignore */
            }
          },
        }
        state.transport = transport
        wsStatus.textContent = '连接中…'
        wsLogMsg('sys', '正在连接 ' + url + (subs.length > 0 ? '  [子协议: ' + subs.join(', ') + ']' : '') + '（浏览器直连）')
        socket.onopen = () => {
          if (state.transport !== transport) return
          wsSetConnected(true)
          wsLogMsg('sys', '已连接')
        }
        socket.onmessage = (event) => {
          const data = event.data
          if (typeof data === 'string') wsLogMsg('recv', data)
          else if (data instanceof ArrayBuffer) wsLogMsg('recv', '[二进制 ' + data.byteLength + ' 字节]')
          else wsLogMsg('recv', String(data))
        }
        socket.onerror = () => wsLogMsg('err', 'WebSocket 错误（多为连接被拒 / 握手失败，详情看浏览器控制台）')
        socket.onclose = (event) => {
          if (state.transport === transport) state.transport = null
          wsSetConnected(false)
          wsLogMsg('sys', '连接关闭 (code=' + event.code + (event.reason ? ', ' + event.reason : '') + ')')
        }
      }

      // host proxy transport (header-auth ws / raw tcp): open + long-poll + send
      function connectProxy(spec, label) {
        let connId = null
        let stopped = false
        const doSend = (text) => {
          if (connId === null) return
          apiFetch('/conn/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: connId, data: text }) }).catch((e) =>
            wsLogMsg('err', '发送失败: ' + (e instanceof Error ? e.message : String(e))),
          )
        }
        const doClose = () => {
          stopped = true
          if (connId !== null) apiFetch('/conn/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: connId }) }).catch(() => {})
        }
        const transport = { kind: 'proxy', send: doSend, close: doClose }
        const pollLoop = async () => {
          let cursor = 0
          while (!stopped) {
            let r
            try {
              r = await apiFetch('/conn/poll?id=' + encodeURIComponent(connId) + '&cursor=' + cursor)
            } catch (err) {
              if (stopped) break
              if (err instanceof Error && /no such connection|HTTP 404/.test(err.message)) break
              await new Promise((res) => setTimeout(res, 600))
              continue
            }
            for (const ev of r.events || []) {
              if (ev.type === 'open') {
                wsSetConnected(true)
                wsLogMsg('sys', '已连接')
              } else if (ev.type === 'message') {
                wsLogMsg('recv', proxyMsgText(ev))
              } else if (ev.type === 'close') {
                wsLogMsg('sys', '连接关闭 (code=' + ev.code + (ev.reason ? ', ' + ev.reason : '') + ')')
              } else if (ev.type === 'error') {
                wsLogMsg('err', ev.message || 'error')
              }
            }
            cursor = r.cursor ?? cursor
            if (r.closed) break
          }
          if (state.transport === transport) state.transport = null
          wsSetConnected(false)
        }
        state.transport = transport
        wsStatus.textContent = '连接中…'
        wsLogMsg('sys', '正在连接 ' + label + '（经宿主转发）')
        apiFetch('/conn/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) })
          .then((r) => {
            if (state.transport !== transport) return
            connId = r.id
            pollLoop()
          })
          .catch((e) => {
            wsLogMsg('err', '打开连接失败: ' + (e instanceof Error ? e.message : String(e)))
            if (state.transport === transport) state.transport = null
            wsSetConnected(false)
          })
      }

      function connectProxyWs(url) {
        connectProxy({ kind: 'ws', url, headers: liveHeaders(), subprotocols: wsProtoIn.value.trim() }, url)
      }

      function connectProxyTcp(rawUrl) {
        const m = rawUrl.match(/^tcp:\/\/([^/:\s]+):(\d+)/i)
        if (m === null) {
          wsLogMsg('err', 'TCP 地址格式应为 tcp://host:port')
          return
        }
        connectProxy({ kind: 'tcp', host: m[1], port: Number(m[2]) }, rawUrl)
      }

      function wsConnect() {
        if (state.transport !== null) return
        const url = currentTargetUrl()
        if (state.mode === 'tcp') {
          connectProxyTcp(url)
        } else if (state.mode === 'ws') {
          if (!/^wss?:\/\//i.test(url)) return
          if (wsProxyCb.checked) connectProxyWs(url)
          else connectBrowserWs(url)
        }
      }

      function wsDisconnect() {
        const t = state.transport
        state.transport = null
        if (t !== null) {
          try {
            t.close()
          } catch {
            /* ignore */
          }
        }
        wsSetConnected(false)
      }

      function wsSendMessage() {
        if (!state.wsConnected || state.transport === null) return
        if (wsInput.value === '') return
        const msg = substVars(wsInput.value, state.env)
        try {
          state.transport.send(msg)
          wsLogMsg('sent', msg)
          wsInput.value = ''
          wsInput.focus()
        } catch (error) {
          wsLogMsg('err', '发送失败: ' + (error instanceof Error ? error.message : String(error)))
        }
      }

      function primaryAction() {
        if (state.mode === 'ws' || state.mode === 'tcp') {
          if (state.wsConnected) wsDisconnect()
          else wsConnect()
        } else if (state.mode === 'grpc') {
          grpcCall()
        } else {
          send()
        }
      }

      wsSetConnected(false) // initial disabled state for the ws controls

      // ---- wiring
      sendBtn.addEventListener('click', primaryAction)
      urlInput.addEventListener('input', () => {
        applyMode(detectMode(urlInput.value))
        setParamsFromUrl()
      })
      urlInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        if (state.mode === 'ws' || state.mode === 'tcp') {
          if (!state.wsConnected) wsConnect()
        } else if (state.mode === 'grpc') {
          grpcCall()
        } else {
          send()
        }
      })
      wsSendBtn.addEventListener('click', wsSendMessage)
      wsInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          wsSendMessage()
        }
      })
      wsClearBtn.addEventListener('click', () => {
        wsLog.textContent = ''
      })

      // ---- gRPC (host /grpc/*): parse proto → pick service/method → unary call
      let grpcServices = []
      function grpcTarget() {
        const u = substVars(urlInput.value.trim(), state.env)
        const m = u.match(/^grpc:\/\/(.+)$/i)
        return m ? m[1] : u
      }
      function grpcFillMethods() {
        const svc = grpcServices.find((s) => s.name === grpcSvcSel.value)
        grpcMethodSel.textContent = ''
        if (svc === undefined) return
        for (const m of svc.methods) {
          const streaming = m.requestStream || m.responseStream
          const o = el('option', '', m.name + (streaming ? ' (流式,暂不支持)' : ''))
          o.value = m.name
          o.disabled = streaming
          grpcMethodSel.appendChild(o)
        }
      }
      async function grpcParse() {
        grpcStatus.textContent = '解析中…'
        try {
          const r = await apiFetch('/grpc/methods', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proto: grpcProto.value }) })
          grpcServices = r.services || []
          grpcSvcSel.textContent = ''
          for (const s of grpcServices) {
            const o = el('option', '', s.name)
            o.value = s.name
            grpcSvcSel.appendChild(o)
          }
          grpcFillMethods()
          grpcStatus.textContent = grpcServices.length > 0 ? grpcServices.length + ' 个服务' : '未找到服务'
        } catch (e) {
          grpcStatus.textContent = '解析失败: ' + (e instanceof Error ? e.message : String(e))
        }
      }
      async function grpcCall() {
        if (state.grpcCalling) return
        if (grpcSvcSel.value === '' || grpcMethodSel.value === '') {
          grpcStatus.textContent = '先「解析 proto」并选服务 / 方法'
          return
        }
        state.grpcCalling = true
        updateActionButton()
        grpcStatus.textContent = '调用中…'
        try {
          const r = await apiFetch('/grpc/call', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              proto: grpcProto.value,
              target: grpcTarget(),
              service: grpcSvcSel.value,
              method: grpcMethodSel.value,
              request: substVars(grpcReq.value, state.env),
              metadata: liveHeaders(),
              tls: grpcTlsCb.checked,
              deadlineMs: 20000,
            }),
          })
          if (r.ok) {
            grpcStatus.textContent = '成功 · ' + fmtDur(r.durationMs)
            grpcResp.textContent = JSON.stringify(r.response, null, 2)
          } else {
            grpcStatus.textContent = '失败' + (r.code !== undefined ? ' (code=' + r.code + ')' : '')
            grpcResp.textContent = r.error || '(无错误信息)'
          }
        } catch (e) {
          grpcStatus.textContent = '请求失败'
          grpcResp.textContent = e instanceof Error ? e.message : String(e)
        } finally {
          state.grpcCalling = false
          updateActionButton()
        }
      }
      grpcParseBtn.addEventListener('click', grpcParse)
      grpcSvcSel.addEventListener('change', grpcFillMethods)

      // ---- history
      function renderHistory(items) {
        historyWrap.textContent = ''
        if (items.length === 0) {
          historyWrap.appendChild(el('div', 'pm-empty', '暂无历史 — 发送请求后会记录在这里'))
          return
        }
        const table = el('table', 'pm-htable')
        const thead = el('thead')
        const headRow = el('tr')
        ;['时间', '方法', 'URL', '状态', '耗时'].forEach((h) => headRow.appendChild(el('th', '', h)))
        thead.appendChild(headRow)
        table.appendChild(thead)
        const tbody = el('tbody')
        for (const item of items) {
          const tr = el('tr')
          tr.appendChild(el('td', '', fmtTime(item.ts)))
          const mTd = el('td')
          mTd.appendChild(methodBadge(item.method))
          tr.appendChild(mTd)
          const uTd = el('td', '', item.url)
          uTd.title = item.url
          tr.appendChild(uTd)
          const sTd = el('td')
          if (item.ok) sTd.appendChild(statusBadge(item.status))
          else sTd.appendChild(el('span', 'pm-badge pm-s-5', 'ERR'))
          tr.appendChild(sTd)
          tr.appendChild(el('td', '', fmtDur(item.durationMs)))
          tr.addEventListener('click', () => loadRecord(item.id))
          tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        historyWrap.appendChild(table)
      }

      async function loadHistory() {
        try {
          const data = await apiFetch('/history?limit=100')
          renderHistory(data.items)
        } catch (error) {
          historyWrap.textContent = ''
          historyWrap.appendChild(el('div', 'pm-empty', '加载历史失败: ' + (error instanceof Error ? error.message : String(error))))
        }
      }

      async function loadRecord(id) {
        try {
          const rec = await apiFetch(`/history/${encodeURIComponent(id)}`)
          methodSel.value = METHODS.includes(rec.request?.method) ? rec.request.method : 'GET'
          setUrl(rec.request?.url ?? '')
          setHeaders(rec.request?.headers ?? {})
          bodyText.value = rec.request?.body ?? ''
          renderResponse(rec.response)
          selectReqTab(tabHeaders)
        } catch (error) {
          console.error('[dsh-postman] load record failed:', error)
        }
      }

      historyRefresh.addEventListener('click', loadHistory)
      historyClear.addEventListener('click', () => {
        if (window.confirm('清空全部接口调试历史？')) {
          apiFetch('/history', { method: 'DELETE' })
            .then(() => loadHistory())
            .catch((error) => console.error('[dsh-postman] clear failed:', error))
        }
      })

      // ---- modal (env editor / curl import)
      let modalOnOk = null
      function openModal(title, text, placeholder, onOk) {
        modalTitle.textContent = title
        modalTa.value = text || ''
        modalTa.placeholder = placeholder || ''
        modalOnOk = onOk
        modal.hidden = false
        modalTa.focus()
      }
      function closeModal() {
        modal.hidden = true
        modalOnOk = null
      }
      modalCancel.addEventListener('click', closeModal)
      modalOk.addEventListener('click', () => {
        const fn = modalOnOk
        const value = modalTa.value
        closeModal()
        if (fn) fn(value)
      })

      function copyToClipboard(text, btn) {
        const old = btn.textContent
        const done = () => {
          btn.textContent = '已复制 ✓'
          setTimeout(() => {
            btn.textContent = old
          }, 1200)
        }
        const fallback = () => {
          const ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          try {
            document.execCommand('copy')
          } catch {
            /* ignore */
          }
          ta.remove()
          done()
        }
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback)
        else fallback()
      }

      // ---- request assembly: auth header + {{env}} substitution
      function substHeaders(headers) {
        const out = {}
        for (const [k, v] of Object.entries(headers)) out[substVars(k, state.env)] = substVars(v, state.env)
        return out
      }
      function buildRequest() {
        const headers = collectHeaders().headers
        const authVal = authHeaderValue(state.auth)
        if (authVal !== '' && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) headers['Authorization'] = authVal
        let method = methodSel.value
        let body
        if (state.bodyMode === 'graphql') {
          let variables = {}
          const vt = gqlVars.value.trim()
          if (vt !== '') {
            try {
              variables = JSON.parse(substVars(vt, state.env))
            } catch {
              variables = {}
            }
          }
          body = JSON.stringify({ query: substVars(gqlQuery.value, state.env), variables })
          method = 'POST'
          if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
        } else {
          body = substVars(bodyText.value, state.env)
        }
        return {
          method,
          url: substVars(urlInput.value.trim(), state.env),
          headers: substHeaders(headers),
          body,
        }
      }

      // ---- auth UI
      function updateAuthUI() {
        authBearer.hidden = state.auth.type !== 'bearer'
        authBasic.hidden = state.auth.type !== 'basic'
      }
      authSel.addEventListener('change', () => {
        state.auth.type = authSel.value
        updateAuthUI()
      })
      authToken.addEventListener('input', () => {
        state.auth.token = authToken.value
      })
      authUser.addEventListener('input', () => {
        state.auth.user = authUser.value
      })
      authPass.addEventListener('input', () => {
        state.auth.pass = authPass.value
      })
      updateAuthUI()

      // ---- environment variables (localStorage)
      const ENV_KEY = 'dsh-postman-env'
      function updateEnvBtn() {
        const n = Object.keys(state.env).length
        envBtn.textContent = n > 0 ? `环境变量 (${n})` : '环境变量'
      }
      function loadEnv() {
        try {
          const raw = window.localStorage.getItem(ENV_KEY)
          if (raw !== null) {
            state.envText = raw
            state.env = parseEnvText(raw)
          }
        } catch {
          /* ignore */
        }
        updateEnvBtn()
      }
      function saveEnv(text) {
        state.envText = text
        state.env = parseEnvText(text)
        try {
          window.localStorage.setItem(ENV_KEY, text)
        } catch {
          /* ignore */
        }
        updateEnvBtn()
      }
      loadEnv()
      envBtn.addEventListener('click', () => {
        openModal(
          '环境变量（每行 KEY=VALUE，# 为注释；发送时把 {{KEY}} 替换到 URL / 请求头 / body / WS 消息）',
          state.envText,
          'TOKEN=abc123\nBASE=https://api.example.com',
          saveEnv,
        )
      })

      // ---- curl import / export
      curlInBtn.addEventListener('click', () => {
        openModal(
          '粘贴 cURL 命令（导入后回填到编辑器）',
          '',
          "curl -X POST 'https://example.com/api' -H 'Content-Type: application/json' --data-raw '{}'",
          (text) => {
            const parsed = parseCurl(text)
            if (parsed.url === '') {
              window.alert('没解析出 URL')
              return
            }
            applyMode(detectMode(parsed.url))
            if (state.mode === 'http') methodSel.value = METHODS.includes(parsed.method) ? parsed.method : 'GET'
            setUrl(parsed.url)
            setHeaders(parsed.headers)
            bodyText.value = parsed.body
            selectReqTab(tabHeaders)
          },
        )
      })
      curlOutBtn.addEventListener('click', () => {
        copyToClipboard(toCurl(buildRequest()), curlOutBtn)
      })

      // ---- saved requests + collections (localStorage)
      const COL_KEY = 'dsh-postman-collections'
      function uid() {
        try {
          return crypto.randomUUID()
        } catch {
          return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        }
      }
      function loadCollections() {
        try {
          const raw = window.localStorage.getItem(COL_KEY)
          const parsed = raw ? JSON.parse(raw) : null
          state.collections = parsed && Array.isArray(parsed.collections) ? parsed.collections : []
        } catch {
          state.collections = []
        }
      }
      function saveCollections() {
        try {
          window.localStorage.setItem(COL_KEY, JSON.stringify({ collections: state.collections }))
        } catch {
          /* ignore */
        }
      }
      function currentComposer() {
        return {
          mode: state.mode,
          method: methodSel.value,
          url: urlInput.value,
          headers: collectHeaders().headers,
          body: bodyText.value,
          auth: { ...state.auth },
          bodyMode: state.bodyMode,
          gqlQuery: gqlQuery.value,
          gqlVars: gqlVars.value,
          grpcProto: grpcProto.value,
          grpcReq: grpcReq.value,
          grpcSvc: grpcSvcSel.value,
          grpcMethod: grpcMethodSel.value,
          grpcTls: grpcTlsCb.checked,
        }
      }
      function loadComposer(r) {
        setUrl(r.url || '')
        applyMode(r.mode || detectMode(r.url || ''))
        if (state.mode === 'http') methodSel.value = METHODS.includes(r.method) ? r.method : 'GET'
        setHeaders(r.headers || {})
        bodyText.value = r.body || ''
        state.bodyMode = r.bodyMode === 'graphql' ? 'graphql' : 'raw'
        bodyModeSel.value = state.bodyMode
        gqlQuery.value = r.gqlQuery || ''
        gqlVars.value = r.gqlVars || ''
        updateBodyMode()
        grpcProto.value = r.grpcProto || ''
        grpcReq.value = r.grpcReq || ''
        grpcTlsCb.checked = !!r.grpcTls
        if (state.mode === 'grpc' && grpcProto.value.trim() !== '') {
          grpcParse().then(() => {
            if (r.grpcSvc) {
              grpcSvcSel.value = r.grpcSvc
              grpcFillMethods()
            }
            if (r.grpcMethod) grpcMethodSel.value = r.grpcMethod
          })
        }
        state.auth = { type: 'none', token: '', user: '', pass: '', ...(r.auth || {}) }
        authSel.value = state.auth.type
        authToken.value = state.auth.token || ''
        authUser.value = state.auth.user || ''
        authPass.value = state.auth.pass || ''
        updateAuthUI()
        if (state.mode === 'http') selectReqTab(tabHeaders)
      }
      function reqBadge(r) {
        if (r.mode === 'ws') return el('span', 'pm-badge pm-m-other', 'WS')
        if (r.mode === 'tcp') return el('span', 'pm-badge pm-m-other', 'TCP')
        if (r.mode === 'grpc') return el('span', 'pm-badge pm-m-other', 'gRPC')
        return methodBadge((r.method || 'GET').toUpperCase())
      }
      function renderCollections() {
        colTree.textContent = ''
        if (state.collections.length === 0) {
          colTree.appendChild(el('div', 'pm-empty', '暂无集合 — 点「保存当前请求」新建'))
          return
        }
        for (const col of state.collections) {
          const colRow = el('div', 'pm-col-row')
          colRow.appendChild(el('span', 'pm-col-caret', col._open ? '▾' : '▸'))
          colRow.appendChild(el('span', 'pm-col-name', `${col.name} (${col.requests.length})`))
          const cdel = el('button', 'pm-hdel', '×')
          cdel.title = '删除集合'
          colRow.appendChild(cdel)
          colRow.addEventListener('click', () => {
            col._open = !col._open
            renderCollections()
          })
          cdel.addEventListener('click', (e) => {
            e.stopPropagation()
            if (window.confirm(`删除集合「${col.name}」及其 ${col.requests.length} 个请求？`)) {
              state.collections = state.collections.filter((c) => c !== col)
              saveCollections()
              renderCollections()
            }
          })
          colTree.appendChild(colRow)
          if (col._open) {
            for (const r of col.requests) {
              const rr = el('div', 'pm-req-row')
              rr.appendChild(reqBadge(r))
              const rn = el('span', 'pm-req-name', r.name)
              rn.title = `${r.method || ''} ${r.url || ''}`
              rr.appendChild(rn)
              const rdel = el('button', 'pm-hdel', '×')
              rdel.title = '删除请求'
              rr.appendChild(rdel)
              rr.addEventListener('click', () => loadComposer(r))
              rdel.addEventListener('click', (e) => {
                e.stopPropagation()
                col.requests = col.requests.filter((x) => x !== r)
                saveCollections()
                renderCollections()
              })
              colTree.appendChild(rr)
            }
          }
        }
      }
      function defaultReqName(c) {
        try {
          const u = new URL(substVars(c.url, state.env))
          return `${c.method || 'GET'} ${u.pathname}`
        } catch {
          return `${c.method || 'GET'} ${c.url || '请求'}`
        }
      }
      function openSaveDialog() {
        saveColSel.textContent = ''
        for (const col of state.collections) {
          const o = el('option', '', col.name)
          o.value = col.id
          saveColSel.appendChild(o)
        }
        const newOpt = el('option', '', '＋ 新建集合')
        newOpt.value = '__new__'
        saveColSel.appendChild(newOpt)
        saveColSel.value = state.collections.length > 0 ? state.collections[0].id : '__new__'
        saveNameIn.value = defaultReqName(currentComposer())
        saveNewColIn.value = ''
        saveNewColRow.hidden = saveColSel.value !== '__new__'
        saveDlg.hidden = false
        saveNameIn.focus()
      }
      function doSave() {
        const name = saveNameIn.value.trim() || '未命名请求'
        let col
        if (saveColSel.value === '__new__') {
          const cn = saveNewColIn.value.trim() || '默认集合'
          col = state.collections.find((c) => c.name === cn)
          if (!col) {
            col = { id: uid(), name: cn, requests: [], _open: true }
            state.collections.push(col)
          }
        } else {
          col = state.collections.find((c) => c.id === saveColSel.value)
        }
        if (!col) {
          col = { id: uid(), name: '默认集合', requests: [], _open: true }
          state.collections.push(col)
        }
        col.requests.push({ id: uid(), name, ...currentComposer() })
        col._open = true
        saveCollections()
        renderCollections()
        saveDlg.hidden = true
      }
      loadCollections()
      renderCollections()
      saveReqBtn.addEventListener('click', openSaveDialog)
      saveColSel.addEventListener('change', () => {
        saveNewColRow.hidden = saveColSel.value !== '__new__'
      })
      saveCancel.addEventListener('click', () => {
        saveDlg.hidden = true
      })
      saveOk.addEventListener('click', doSave)

      // ---- open / close
      const setOpen = (open) => {
        state.open = open
        if (open) {
          clearSiblings()
          document.documentElement.dataset.dshPostmanActive = 'true'
          urlInput.focus()
        } else {
          document.documentElement.removeAttribute('data-dsh-postman-active')
        }
      }
      const toggle = () => setOpen(!state.open)
      closeBtn.addEventListener('click', () => setOpen(false))
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.open) {
          if (!saveDlg.hidden) saveDlg.hidden = true
          else if (!modal.hidden) closeModal()
          else setOpen(false)
        }
      })

      // ---- cross-plugin prefill: 接口捕获「在接口调试打开」派发 window 事件 dsh-postman:prefill
      // detail = { method, url, headers(对象), body(字符串) }
      const onPrefill = (event) => {
        const d = event.detail ?? {}
        if (typeof d.url !== 'string' || d.url === '') return
        applyMode(detectMode(d.url))
        setUrl(d.url) // 把 URL 里的查询参数解析进「查询参数」表
        if (typeof d.method === 'string' && METHODS.includes(d.method)) methodSel.value = d.method
        setHeaders(d.headers ?? {})
        // 抓来的是一次原始 HTTP 调用：复位 body 模式 / 鉴权，避免上一次的 GraphQL 或 Bearer 残留污染
        state.bodyMode = 'raw'
        bodyModeSel.value = 'raw'
        updateBodyMode()
        bodyText.value = typeof d.body === 'string' ? d.body : ''
        state.auth = { type: 'none', token: '', user: '', pass: '' }
        authSel.value = 'none'
        updateAuthUI()
        // 有查询参数就落在「查询参数」页（用户可直接改 packType/version… 上方 URL 实时联动）；否则回请求头
        selectReqTab(parseUrlParts(d.url).query !== '' ? tabParams : tabHeaders)
        setOpen(true)
      }
      window.addEventListener('dsh-postman:prefill', onPrefill)

      return {
        view,
        toggle,
        dispose: () => {
          wsDisconnect()
          window.removeEventListener('dsh-postman:prefill', onPrefill)
        },
      }
    }

    // ------------------------------------------------------------------ apply

    let applied = false

    /**
     * Mount the sidebar entry and panel.
     * @param ctx - client root context (the plugin talks to the host via plain
     * same-origin fetch; ctx.effect is used only for teardown).
     */
    function apply(ctx) {
      if (applied) return
      applied = true
      try {
        injectStyle()
        const { view, toggle, dispose } = buildPanel()
        const disposers = []
        try {
          disposers.push(mountSidebarEntry(toggle))
          const column = centerColumn()
          column.appendChild(view)
          disposers.push(() => view.remove())
          disposers.push(() => {
            try {
              dispose()
            } catch {
              /* ignore */
            }
          })
        } catch (error) {
          console.error('[dsh-postman] mount failed:', error)
        }
        ctx.effect(
          () => () => {
            for (const dispose of disposers.splice(0)) dispose()
          },
          'dsh-postman: teardown',
        )
      } catch (error) {
        // never take the GUI down
        console.error('[dsh-postman] apply failed:', error)
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
