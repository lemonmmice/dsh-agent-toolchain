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
.pm-tblpane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.pm-tblpane[hidden]{display:none}
.pm-tbl-head{padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#23262e);font-size:12px;color:var(--dsw-alias-fg-muted,#9aa0aa);line-height:1.7}
.pm-tbl-head .pm-t{font-weight:600;color:var(--dsw-alias-fg-base,#e6e6e6);font-size:13px}
.pm-tbl-scroll{flex:1;min-height:0;overflow:auto}
.pm-tbl-table{min-width:100%;border-collapse:collapse;white-space:nowrap;font-variant-numeric:tabular-nums}
.pm-tbl-table th{position:sticky;top:0;background:var(--dsw-alias-bg-elevated,#20242c);text-align:right;padding:5px 10px;font-size:12px;color:var(--dsw-alias-fg-muted,#9aa0aa);border-bottom:1px solid var(--dsw-alias-border-subtle,#2a2e37)}
.pm-tbl-table th[data-key]{font-weight:600;color:var(--dsw-alias-fg-base,#e6e6e6)}
.pm-tbl-table td{padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-subtle,#23262e);font-size:12px;text-align:right}
.pm-tbl-table th.pm-tbl-name,.pm-tbl-table td.pm-tbl-name{text-align:left}
.pm-tbl-table tbody tr:hover{background:var(--dsw-alias-bg-hover,#20242c)}
.pm-tbl-table td.pm-tbl-rank{color:var(--dsw-alias-fg-muted,#9aa0aa)}
.pm-tbl-table td.pm-tbl-key{font-weight:600;color:var(--dsw-alias-fg-base,#e6e6e6)}
.pm-tbl-tag{margin-left:6px;padding:0 5px;border-radius:4px;background:#4a3b14;color:#fbbf24;font-size:11px}
.pm-fold{cursor:pointer;color:#fbbf24;border-bottom:1px dashed currentColor}
.pm-fold:hover{background:#4a3b14}
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
.pm-cur{font-size:12px;color:var(--dsw-alias-fg-muted,#9aa0aa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.pm-envsel{max-width:180px;font-weight:400}
.pm-sec-title{font-weight:600;margin:10px 0 6px}
.pm-sec-title:first-child{margin-top:2px}
.pm-crow{display:flex;gap:6px;margin-bottom:6px;align-items:center}
.pm-crow select,.pm-crow input[type=text],.pm-crow input:not([type]){background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:4px 6px;font:inherit;min-width:0}
.pm-crow .pm-cpath{flex:1 1 32%}
.pm-crow .pm-cval{flex:1 1 28%}
.pm-crow .pm-cvar{flex:0 1 20%}
.pm-crow input[hidden]{display:none}
.pm-addbtn{padding:2px 10px;font-size:12px}
.pm-chk-pane{flex:1;overflow:auto;padding:6px 0}
.pm-chk-pane[hidden]{display:none}
.pm-cres{display:flex;gap:8px;padding:4px 12px;align-items:baseline;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#23262e)}
.pm-cres .pm-cres-desc{flex:0 1 auto;font-family:Consolas,Menlo,monospace}
.pm-cres .pm-cres-act{flex:1 1 auto;color:var(--dsw-alias-fg-muted,#9aa0aa);overflow-wrap:anywhere}
.pm-ok{color:#4ade80}.pm-bad{color:#f87171}.pm-warn{color:#fbbf24}
.pm-tab.pm-ok,.pm-tab.pm-ok .pm-count{color:#4ade80}.pm-tab.pm-bad,.pm-tab.pm-bad .pm-count{color:#f87171}
.pm-tree-act{display:none;gap:2px;flex:none}
.pm-col-row:hover .pm-tree-act,.pm-req-row:hover .pm-tree-act{display:flex}
.pm-tree-btn{background:none;border:1px solid transparent;color:var(--dsw-alias-fg-muted,#9aa0aa);cursor:pointer;font:inherit;font-size:12px;padding:0 6px;border-radius:4px;white-space:nowrap}
.pm-tree-btn:hover{border-color:var(--dsw-alias-border-subtle,#2a2e37);color:var(--dsw-alias-fg-base,#e6e6e6)}
.pm-req-row[data-current]{background:var(--dsw-alias-bg-hover,#262b35);box-shadow:inset 2px 0 0 #60a5fa}
.pm-col-row.pm-folder .pm-col-name{font-weight:400}
.pm-store-note{color:var(--dsw-alias-fg-muted,#9aa0aa);font-size:11px;padding:6px 12px;overflow-wrap:anywhere}
.pm-run-box{width:min(900px,94%);max-height:88%}
.pm-run-opts{display:flex;flex-wrap:wrap;gap:12px;padding:10px 14px 4px;align-items:center}
.pm-run-opts label{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--dsw-alias-fg-muted,#9aa0aa)}
.pm-run-opts input[type=number]{width:72px;background:var(--dsw-alias-bg-base,#171a21);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:3px 6px;font:inherit}
.pm-run-data{min-height:56px;max-height:140px;margin:6px 14px}
.pm-run-summary{padding:6px 14px;font-size:13px;border-top:1px solid var(--dsw-alias-border-subtle,#2a2e37)}
.pm-run-list{flex:1;overflow:auto;min-height:80px}
.pm-run-row{display:flex;gap:8px;padding:4px 14px;align-items:center;cursor:pointer;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#23262e)}
.pm-run-row:hover{background:var(--dsw-alias-bg-hover,#262b35)}
.pm-run-row .pm-run-name{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pm-run-row .pm-run-meta{flex:none;color:var(--dsw-alias-fg-muted,#9aa0aa)}
.pm-run-detail{padding:4px 14px 8px 44px;font:12px/1.5 Consolas,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-fg-muted,#c4c9d2);border-bottom:1px solid var(--dsw-alias-border-subtle,#23262e)}
.pm-run-detail[hidden]{display:none}
.pm-env-bar{display:flex;gap:8px;padding:10px 14px 0;align-items:center;flex-wrap:wrap}
.pm-env-bar input{background:var(--dsw-alias-bg-base,#171a21);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:4px 8px;font:inherit}
.pm-env-hint{padding:6px 14px 0;margin:0}
`

    // ---------------------------------------------------------------- helpers

    function injectStyle() {
      if (typeof document === 'undefined') return
      // 宿主会热重载插件 bundle（/plugins/events → modules.reload），而 <style> 是**上一次**
      // 那份代码注入的：见到它就 return 会让热重载后的面板继续用旧 CSS（实测踩过：右栏
      // 掉到响应体下面变成没样式的块）。所以已存在时**换内容**，不是跳过。
      const existing = document.getElementById('dsh-postman-style')
      if (existing !== null) {
        existing.textContent = CSS
        return
      }
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

    // ---- oversized-JSON folding
    // A formatted body can be megabytes (one `lines` array of net-value points can
    // be 900KB+). Laying all of it out at once freezes the panel, so oversized
    // blocks render as a single-line stub and build their contents only on click.

    /** Fold an array once it holds more items than this (the `lines` point arrays). */
    const FOLD_ARRAY_ITEMS = 50
    /** Objects are just field sets — fold only truly huge ones. */
    const FOLD_OBJECT_KEYS = 200

    /** Line that opens a JSON object/array, e.g. `{`, `"lines": [`. */
    function isJsonOpenLine(line) {
      return /^\s*(?:"(?:[^"\\]|\\.)*":\s*)?[\[{],?$/.test(line)
    }

    /** Line that closes one, e.g. `]`, `},`. */
    function isJsonCloseLine(line) {
      return /^\s*[\]}],?$/.test(line)
    }

    function indentWidth(line) {
      const m = line.match(/^[ \t]*/)
      return m === null ? 0 : m[0].length
    }

    /**
     * Outermost [open, close] line pairs in lines[from..to) worth collapsing: arrays with
     * many items, and blocks that span too many lines. Item counts come from one
     * indentation-aware pass, so a 900KB body is still analysed in O(lines) and an object
     * holding a huge array (data: {list: [...60000 lines]}) is NOT itself collapsed.
     * Nested hits are dropped — expanding a stub re-analyses its own contents, so a
     * single click never lays out everything at once.
     */
    function foldRanges(lines, from, to) {
      const found = []
      const stack = []
      for (let i = from; i < to; i++) {
        const line = lines[i]
        if (isJsonOpenLine(line)) {
          const parent = stack[stack.length - 1]
          if (parent !== undefined) parent.children += 1
          stack.push({ line: i, indent: indentWidth(line), ch: line.trim().replace(/,$/, '').slice(-1), children: 0 })
          continue
        }
        if (isJsonCloseLine(line) && stack.length > 0) {
          const open = stack.pop()
          // 只看元素/字段个数：行数多的块几乎总是因为元素多或嵌套深，而嵌套的大块自己也会被
          // 折叠，所以展开一层真正要布局的行数始终有限 —— 于是 list(15 项) 直接展开，
          // 只有 list[i].lines(几千项) 这种才塌。
          const oversized = open.ch === '['
            ? open.children > FOLD_ARRAY_ITEMS
            : open.children > FOLD_OBJECT_KEYS
          if (oversized) found.push({ open: open.line, close: i })
          continue
        }
        const top = stack[stack.length - 1]
        if (top !== undefined && indentWidth(line) === top.indent + 2) top.children += 1
      }
      found.sort((a, b) => a.open - b.open)
      const out = []
      let covered = -1
      for (const r of found) {
        if (r.open > covered) {
          out.push(r)
          covered = r.close
        }
      }
      return out
    }

    function headersToText(headers) {
      if (headers === null || typeof headers !== 'object') return ''
      return Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    }

    // ---------------------------------------------- workflow helpers (pure)

    /**
     * Substitute {{var}} using a flat map; leaves unknown vars untouched.
     * 只给 WebSocket / TCP / gRPC 模式用（HTTP 发送、复制 cURL、集合运行都在宿主侧解析，见 lib/variables.mjs）；
     * 变量名口径与宿主一致：不含空白和花括号。动态变量（{{$guid}} 等）这里不认。
     */
    function substVars(str, env) {
      if (typeof str !== 'string' || str.indexOf('{{') === -1) return str
      return str.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, k) => (env && Object.prototype.hasOwnProperty.call(env, k) ? env[k] : m))
    }

    /** 变量列表 → 编辑文本（KEY=VALUE；停用的写成 # KEY=VALUE）。解析在宿主（variablesText 字段）。 */
    function variablesToText(list) {
      return (list || []).map((v) => (v.enabled === false ? '# ' : '') + v.key + '=' + (v.value ?? '')).join('\n')
    }

    // 断言 / 提取的选项（与宿主 lib/workspace.mjs 的 OPS_BY_SOURCE 等同口径；宿主保存时还会再校验一遍）
    const ASSERT_SOURCE_OPTS = [['status', '状态码'], ['json', 'JSON 路径'], ['header', '响应头'], ['body', '响应体'], ['duration', '耗时(ms)']]
    const OP_LABELS = {
      eq: '等于', ne: '不等于', gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于', contains: '包含', notContains: '不包含',
      regex: '匹配正则', exists: '存在', notExists: '不存在', empty: '为空', notEmpty: '非空', type: '类型是', in: '属于(逗号分隔)',
    }
    const OPS_BY_SOURCE = {
      status: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'regex'],
      duration: ['lt', 'lte', 'gt', 'gte'],
      header: ['exists', 'notExists', 'eq', 'ne', 'contains', 'notContains', 'regex'],
      body: ['contains', 'notContains', 'regex', 'eq', 'ne', 'empty', 'notEmpty'],
      json: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'regex', 'exists', 'notExists', 'empty', 'notEmpty', 'type', 'in'],
    }
    const VALUELESS_OPS = ['exists', 'notExists', 'empty', 'notEmpty']
    const EXTRACT_SOURCE_OPTS = [['json', 'JSON 路径'], ['header', '响应头'], ['body', '响应体正则'], ['status', '状态码']]
    const EXTRACT_SCOPE_OPTS = [['environment', '写到当前环境'], ['collection', '写到集合变量'], ['globals', '写到全局变量'], ['runtime', '只在本次运行']]

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
      const saveTopBtn = el('button', 'pm-btn', '保存')
      saveTopBtn.title = '保存到集合（Ctrl+S）：编辑的是已保存的请求时直接覆盖它，否则另存为新请求'
      toolbar.appendChild(saveTopBtn)
      const curLabel = el('span', 'pm-cur', '')
      toolbar.appendChild(curLabel)
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
      const tabChecks = el('button', 'pm-tab', '断言')
      const checksCount = el('span', 'pm-count', '')
      tabChecks.appendChild(document.createTextNode(' '))
      tabChecks.appendChild(checksCount)
      tabChecks.title = '声明式断言（状态码 / JSON 路径 / 响应头 / 响应体 / 耗时）与变量提取（从响应取值写回环境）'
      const tabCol = el('button', 'pm-tab', '集合')
      const tabHistory = el('button', 'pm-tab', '历史')
      reqTabs.appendChild(tabParams)
      reqTabs.appendChild(tabHeaders)
      reqTabs.appendChild(tabBody)
      reqTabs.appendChild(tabAuth)
      reqTabs.appendChild(tabChecks)
      reqTabs.appendChild(tabCol)
      reqTabs.appendChild(tabHistory)
      const envSel = el('select', 'pm-method pm-envsel pm-fmt')
      envSel.title = '当前环境：发送时用它的变量替换 {{变量}}'
      const envBtn = el('button', 'pm-btn', '环境…')
      envBtn.title = '管理环境与全局变量'
      const curlInBtn = el('button', 'pm-btn', '导入 cURL')
      const curlOutBtn = el('button', 'pm-btn', '复制 cURL')
      reqTabs.appendChild(envSel)
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

      // checks pane: 断言 + 变量提取（随请求一起保存；发送 / 集合运行时在宿主求值）
      const checksPane = el('div', 'pm-pane')
      checksPane.hidden = true
      checksPane.appendChild(el('div', 'pm-sec-title', '断言'))
      checksPane.appendChild(el('p', 'pm-hint', '发送后逐条判定，结果在下方「断言结果」。JSON 路径写法：data.list[0].code、data.list.length；期望值里可以写 {{变量}}。'))
      const assertList = el('div')
      checksPane.appendChild(assertList)
      const addAssertBtn = el('button', 'pm-btn pm-addbtn', '＋ 添加断言')
      checksPane.appendChild(addAssertBtn)
      checksPane.appendChild(el('div', 'pm-sec-title', '提取变量'))
      checksPane.appendChild(el('p', 'pm-hint', '从响应里取值写进变量，后面的请求用 {{变量名}} 引用（例如登录拿 token）。响应体正则取第 1 个分组。'))
      const extractList = el('div')
      checksPane.appendChild(extractList)
      const addExtractBtn = el('button', 'pm-btn pm-addbtn', '＋ 添加提取')
      checksPane.appendChild(addExtractBtn)
      req.appendChild(checksPane)

      // collections pane
      const colPane = el('div', 'pm-pane')
      colPane.hidden = true
      const colBar = el('div', 'pm-bodybar')
      const saveReqBtn = el('button', 'pm-btn pm-send', '保存当前请求')
      colBar.appendChild(saveReqBtn)
      const newColBtn = el('button', 'pm-btn', '新建集合')
      colBar.appendChild(newColBtn)
      const importColBtn = el('button', 'pm-btn', '导入集合')
      importColBtn.title = '导入本插件导出的 .dsh-collection.json'
      colBar.appendChild(importColBtn)
      const importColFile = el('input')
      importColFile.type = 'file'
      importColFile.accept = '.json,application/json'
      importColFile.hidden = true
      colBar.appendChild(importColFile)
      colBar.appendChild(el('span', 'pm-hint', '点名称展开/收起，点请求载入编辑器；悬停一行出现「运行 / 文件夹 / 变量 / 导出」'))
      colPane.appendChild(colBar)
      const colTree = el('div', 'pm-coltree')
      colPane.appendChild(colTree)
      const storeNote = el('div', 'pm-store-note', '')
      colPane.appendChild(storeNote)
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

      // -------- response region: status line + tabs (body / headers / 表格视图)
      const resp = el('div', 'pm-resp')
      const statusLine = el('div', 'pm-status')
      statusLine.appendChild(el('span', 'pm-status-meta', '尚未发送请求'))
      resp.appendChild(statusLine)
      const respTabs = el('div', 'pm-tabs')
      const tabRespBody = el('button', 'pm-tab', '响应体')
      const tabRespHeaders = el('button', 'pm-tab', '响应头')
      const tabRespTable = el('button', 'pm-tab', '表格视图')
      const tableCount = el('span', 'pm-count', '')
      tabRespTable.appendChild(document.createTextNode(' '))
      tabRespTable.appendChild(tableCount)
      const tabRespChecks = el('button', 'pm-tab', '断言结果')
      const respChecksCount = el('span', 'pm-count', '')
      tabRespChecks.appendChild(document.createTextNode(' '))
      tabRespChecks.appendChild(respChecksCount)
      respTabs.appendChild(tabRespBody)
      respTabs.appendChild(tabRespHeaders)
      respTabs.appendChild(tabRespTable)
      respTabs.appendChild(tabRespChecks)
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
      // 「表格视图」tab 的内容：把响应体里的「对象数组」铺成表（口径同接口捕获的「排序视图」）
      const tablePane = el('div', 'pm-tblpane')
      tablePane.hidden = true
      resp.appendChild(tablePane)
      const respChecksPane = el('div', 'pm-chk-pane')
      respChecksPane.hidden = true
      resp.appendChild(respChecksPane)
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
      const saveFolderRow = el('div', 'pm-hrow')
      saveFolderRow.appendChild(el('span', 'pm-save-lbl', '文件夹'))
      const saveFolderSel = el('select', 'pm-method')
      saveFolderRow.appendChild(saveFolderSel)
      saveForm.appendChild(saveFolderRow)
      saveBox.appendChild(saveForm)
      const saveBar = el('div', 'pm-modal-bar')
      const saveCancel = el('button', 'pm-btn', '取消')
      const saveOk = el('button', 'pm-btn pm-send', '保存')
      saveBar.appendChild(saveCancel)
      saveBar.appendChild(saveOk)
      saveBox.appendChild(saveBar)
      saveDlg.appendChild(saveBox)
      view.appendChild(saveDlg)

      // -------- environments dialog（环境 + 全局变量）
      const envDlg = el('div', 'pm-modal')
      envDlg.hidden = true
      const envBox = el('div', 'pm-modal-box')
      envBox.appendChild(el('div', 'pm-modal-title', '环境与变量'))
      const envBar = el('div', 'pm-env-bar')
      const envEditSel = el('select', 'pm-method')
      envBar.appendChild(envEditSel)
      const envNameIn = el('input', '')
      envNameIn.placeholder = '环境名'
      envNameIn.spellcheck = false
      envBar.appendChild(envNameIn)
      const envNewBtn = el('button', 'pm-btn', '新建环境')
      const envDelBtn = el('button', 'pm-btn pm-btn-danger', '删除')
      const envUseBtn = el('button', 'pm-btn', '设为当前')
      envBar.appendChild(envNewBtn)
      envBar.appendChild(envDelBtn)
      envBar.appendChild(envUseBtn)
      envBox.appendChild(envBar)
      envBox.appendChild(el('p', 'pm-hint pm-env-hint', '每行 KEY=VALUE，# KEY=VALUE 表示停用。发送时 {{KEY}} 按「数据行 > 当前环境 > 集合变量 > 全局变量」取值；还可以用 {{$guid}} {{$timestamp}} {{$timestampMs}} {{$isoTimestamp}} {{$randomInt}}。'))
      const envTa = el('textarea', 'pm-modal-ta')
      envTa.spellcheck = false
      envTa.placeholder = 'base=https://api.example.com\ntoken=abc123'
      envBox.appendChild(envTa)
      const envMsg = el('div', 'pm-store-note', '')
      envBox.appendChild(envMsg)
      const envFoot = el('div', 'pm-modal-bar')
      const envCloseBtn = el('button', 'pm-btn', '关闭')
      const envSaveBtn = el('button', 'pm-btn pm-send', '保存')
      envFoot.appendChild(envCloseBtn)
      envFoot.appendChild(envSaveBtn)
      envBox.appendChild(envFoot)
      envDlg.appendChild(envBox)
      view.appendChild(envDlg)

      // -------- collection runner dialog
      const runDlg = el('div', 'pm-modal')
      runDlg.hidden = true
      const runBox = el('div', 'pm-modal-box pm-run-box')
      const runTitle = el('div', 'pm-modal-title', '运行')
      runBox.appendChild(runTitle)
      const runOpts = el('div', 'pm-run-opts')
      const runEnvLbl = el('label', '', '环境')
      const runEnvSel = el('select', 'pm-method')
      runEnvLbl.appendChild(runEnvSel)
      runOpts.appendChild(runEnvLbl)
      const runIterLbl = el('label', '', '迭代')
      const runIterIn = el('input', '')
      runIterIn.type = 'number'
      runIterIn.min = '1'
      runIterIn.max = '100'
      runIterIn.placeholder = '1'
      runIterLbl.appendChild(runIterIn)
      runOpts.appendChild(runIterLbl)
      const runDelayLbl = el('label', '', '间隔(ms)')
      const runDelayIn = el('input', '')
      runDelayIn.type = 'number'
      runDelayIn.min = '0'
      runDelayIn.max = '60000'
      runDelayIn.placeholder = '0'
      runDelayLbl.appendChild(runDelayIn)
      runOpts.appendChild(runDelayLbl)
      const runStopLbl = el('label', '')
      const runStopCb = el('input', '')
      runStopCb.type = 'checkbox'
      runStopLbl.appendChild(runStopCb)
      runStopLbl.appendChild(document.createTextNode('失败即停'))
      runOpts.appendChild(runStopLbl)
      const runPersistLbl = el('label', '')
      const runPersistCb = el('input', '')
      runPersistCb.type = 'checkbox'
      runPersistCb.checked = true
      runPersistLbl.appendChild(runPersistCb)
      runPersistLbl.appendChild(document.createTextNode('提取的变量写回环境'))
      runOpts.appendChild(runPersistLbl)
      runBox.appendChild(runOpts)
      const runData = el('textarea', 'pm-textarea pm-run-data')
      runData.spellcheck = false
      runData.placeholder = '可选：数据驱动。CSV（首行表头）或 JSON 对象数组；第 i 轮用第 i 行，列名就是 {{变量}} 名。不填迭代次数时 = 数据行数'
      runBox.appendChild(runData)
      const runSummary = el('div', 'pm-run-summary', '')
      runBox.appendChild(runSummary)
      const runList = el('div', 'pm-run-list')
      runBox.appendChild(runList)
      const runFoot = el('div', 'pm-modal-bar')
      const runCloseBtn = el('button', 'pm-btn', '关闭')
      const runStopBtn = el('button', 'pm-btn pm-btn-danger', '停止')
      runStopBtn.hidden = true
      const runStartBtn = el('button', 'pm-btn pm-send', '开始运行')
      runFoot.appendChild(runCloseBtn)
      runFoot.appendChild(runStopBtn)
      runFoot.appendChild(runStartBtn)
      runBox.appendChild(runFoot)
      runDlg.appendChild(runBox)
      view.appendChild(runDlg)

      // -------------------------------------------------------------- state
      const state = {
        open: false,
        sending: false,
        formatted: true,
        respRaw: '',
        respContentType: '',
        respTruncated: false,
        respFailed: false,
        respTab: 'body',
        mode: 'http',
        transport: null,
        wsConnected: false,
        auth: { type: 'none', token: '', user: '', pass: '' },
        // WebSocket / TCP / gRPC 模式用的扁平变量表（全局 < 集合 < 当前环境），由工作区算出来
        env: {},
        // 宿主侧工作区（GET /workspace）：集合 / 环境 / 全局变量
        workspace: null,
        storePath: '',
        workspaceError: '',
        // 一次性提示（例如旧数据搬家的结果），一直显示在集合页底部
        notice: '',
        // 编辑器里的请求来自哪个已保存的请求：{ collectionId, itemId } | null
        current: null,
        // 集合树里展开着的集合 / 文件夹 id
        openIds: new Set(),
        bodyMode: 'raw',
        grpcCalling: false,
        run: null,
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
        { tab: tabChecks, pane: checksPane },
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
      tabChecks.addEventListener('click', () => selectReqTab(tabChecks))
      tabCol.addEventListener('click', () => selectReqTab(tabCol))
      tabHistory.addEventListener('click', () => selectReqTab(tabHistory))
      selectReqTab(tabParams)

      // ---- response tab switching（body / headers / table）
      function selectRespTab(mode) {
        state.respTab = mode
        respBodyPre.hidden = mode !== 'body'
        respHeadersPre.hidden = mode !== 'headers'
        tablePane.hidden = mode !== 'table'
        respChecksPane.hidden = mode !== 'checks'
        // 格式化开关只对响应体有意义
        fmtBtn.style.visibility = mode === 'body' ? '' : 'hidden'
        for (const [key, tab] of [['body', tabRespBody], ['headers', tabRespHeaders], ['table', tabRespTable], ['checks', tabRespChecks]]) {
          if (key === mode) tab.dataset.active = ''
          else delete tab.dataset.active
        }
      }
      tabRespBody.addEventListener('click', () => selectRespTab('body'))
      tabRespHeaders.addEventListener('click', () => selectRespTab('headers'))
      tabRespTable.addEventListener('click', () => selectRespTab('table'))
      tabRespChecks.addEventListener('click', () => selectRespTab('checks'))
      selectRespTab('body')

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
      /** Append lines[from..to] into node, replacing oversized sub-blocks with stubs. */
      function appendFoldRange(node, lines, from, to) {
        const parts = []
        let cursor = from
        for (const r of foldRanges(lines, from, to + 1)) {
          if (r.open > cursor) parts.push(lines.slice(cursor, r.open).join('\n'))
          parts.push(makeFoldStub(lines, r.open, r.close))
          cursor = r.close + 1
        }
        if (cursor <= to) parts.push(lines.slice(cursor, to + 1).join('\n'))
        // 片段之间补换行：stub 保持行内元素，断行只靠真实 "\n"，这样复制出来的还是完整 JSON
        parts.forEach((p, i) => {
          if (i > 0) node.appendChild(document.createTextNode('\n'))
          node.appendChild(typeof p === 'string' ? document.createTextNode(p) : p)
        })
      }

      /**
       * One collapsible block: a stub line now, the real lines only on click. Everything
       * stays inline — line breaks come from real "\n" text, so copying the body still
       * yields the original JSON instead of run-together lines.
       */
      function makeFoldStub(lines, open, close) {
        const head = lines[open]
        const summary = `${head}   … 已折叠 ${close - open - 1} 行 · 点此展开 ]`
        const stub = el('span', 'pm-fold', summary)
        stub.title = '这一块太大，已折叠；展开只渲染这一层，里面的块仍保持折叠'
        const body = el('span')
        body.hidden = true
        let built = false
        stub.addEventListener('click', () => {
          if (body.hidden) {
            if (!built) {
              body.appendChild(document.createTextNode('\n'))
              appendFoldRange(body, lines, open + 1, close)
              built = true
            }
            body.hidden = false
            stub.textContent = `${head}   … 点此收起 ]`
          } else {
            body.hidden = true
            stub.textContent = summary
          }
        })
        const wrap = el('span')
        wrap.appendChild(stub)
        wrap.appendChild(body)
        return wrap
      }

      /** Render the formatted body, folding oversized JSON blocks. Non-JSON stays plain text. */
      function renderRespBody() {
        if (!state.formatted) {
          respBodyPre.textContent = state.respRaw
          return
        }
        const text = beautify(state.respRaw, state.respContentType)
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          respBodyPre.textContent = text
          return
        }
        if (parsed === null || typeof parsed !== 'object') {
          respBodyPre.textContent = text
          return
        }
        const lines = text.split('\n')
        respBodyPre.textContent = ''
        // 顶层块永不折叠（否则整个 body 塌成一行），但它内部的大块照塌
        const top = foldRanges(lines, 0, lines.length)
        if (top.length !== 1 || top[0].open !== 0 || top[0].close !== lines.length - 1) {
          appendFoldRange(respBodyPre, lines, 0, lines.length - 1)
          return
        }
        respBodyPre.appendChild(document.createTextNode(lines[0] + '\n'))
        appendFoldRange(respBodyPre, lines, 1, lines.length - 2)
        respBodyPre.appendChild(document.createTextNode('\n' + lines[lines.length - 1]))
      }

      // ---- 表格视图（响应体右侧栏）
      // 列表型 JSON 响应（如榜单接口的 data.list）只看原始 JSON 看不出顺序，这一栏用表格给出
      // 「第几条、叫什么、值多少」。顺序恒为**接口返回顺序**：不重排（客户端榜单的既定口径就是
      // 「排序由后端定、客户端不排序」），后端置顶的行会被标记出来，免得看起来像排错了。
      // ⚠ 口径与 dsh-api-visualizer 的「排序视图」一致，但**是同语义的第二份实现**：宿主把每个
      // 插件的 client bundle 按原样下发（没有跨插件的模块解析），两个插件各自独立。改这里请同步
      // plugins/dsh-api-visualizer/lib/client.js 的 renderSortPane —— 反之亦然。

      /** 接口 sortField = 收益排序周期（月，1/3/6/12），标签与客户端榜单的周期选项同口径。 */
      const SORT_PERIOD_LABELS = { 1: '近1月', 3: '近3月', 6: '近6月', 12: '近1年' }

      /** 已知收益字段的列名；未知字段直接用字段名（每列的 tooltip 里始终给出真实字段名）。 */
      const SORT_COLUMN_LABELS = {
        yearYieldRate: 'year(年化)',
        totalYieldRate: 'total(累计)',
        todayYieldRate: 'today(今日)',
      }

      /** 已知名称字段的列名（其余字段名原样显示）。 */
      const SORT_NAME_LABELS = { name: '名称', strategyName: '策略名称', stockName: '股票名称', title: '标题', code: '代码', symbol: '代码' }

      /** 只有比率语义的字段名才按小数比率渲染，避免把普通数字（数量/价格）印成百分比。 */
      const SORT_RATE_KEY = /(rate|yield|ratio|return|percent|pct)/i

      /** 表格最多渲染多少行：几千行的响应只铺前 N 行，避免把面板卡住。 */
      const SORT_ROWS_CAP = 300

      /** 接口下发的收益有两种形态：文本百分比（`+53.44%`）与小数比率（0.55743）。 */
      function percentText(value) {
        return typeof value === 'string' && /^[+-]?\d+(\.\d+)?%$/.test(value.trim()) ? value.trim() : null
      }

      /** 小数比率 → 百分比文本，位数与接口下发的文本口径一致（2 位）。 */
      function ratioText(value) {
        return `${value >= 0 ? '+' : '-'}${(Math.abs(value) * 100).toFixed(2)}%`
      }

      /** 排序入参只从 URL 里读，不做语义推断。 */
      function sortParamsOf(url) {
        try {
          const params = new URL(url, location.origin).searchParams
          const field = params.get('sortField')
          const type = params.get('sortType')
          return {
            field,
            period: SORT_PERIOD_LABELS[Number(field)] ?? null,
            dir: type === '1' ? '正序' : type === '2' ? '倒序' : null,
          }
        } catch {
          return { field: null, period: null, dir: null }
        }
      }

      /**
       * 在响应 JSON 里找「行集」：元素为对象的数组，优先常见列表键（data.list / rows / items …）。
       * 有节点预算与深度上限——响应体可达 MB 级，不能全树遍历。
       */
      function pickListRows(root) {
        const PREFERRED = ['list', 'rows', 'items', 'records', 'results', 'data', 'result']
        let best = null
        let budget = 300
        const visit = (node, depth, key) => {
          if (budget <= 0 || node === null || typeof node !== 'object') return
          budget -= 1
          if (Array.isArray(node)) {
            const first = node[0]
            if (node.length > 0 && first !== null && typeof first === 'object' && !Array.isArray(first)) {
              const score = (PREFERRED.includes(String(key).toLowerCase()) ? 100000 : 0) + node.length
              if (best === null || score > best.score) best = { rows: node, score }
            }
            return // 行集内部不再下钻：嵌套数组不是行集
          }
          if (depth >= 4) return
          for (const k of Object.keys(node)) visit(node[k], depth + 1, k)
        }
        visit(root, 0, '')
        return best === null ? null : best.rows
      }

      /** 行集 → 列模型：名称列 + 最多 4 个值列（比率数字在前，百分比文本按字段出现顺序）。 */
      function buildTableColumns(rows) {
        const sample = rows.slice(0, 20)
        const first = sample[0]
        const keys = Object.keys(first)
        const nameKey = keys.find((k) => typeof first[k] === 'string' && /^(name|strategyName|stockName|title|label|code|symbol)$/i.test(k))
          ?? keys.find((k) => typeof first[k] === 'string' && !SORT_RATE_KEY.test(k) && first[k].length <= 40 && !/id$/i.test(k))
          ?? null
        const numeric = []
        const textual = []
        for (const k of keys) {
          if (k === nameKey || /id$/i.test(k) || (first[k] !== null && typeof first[k] === 'object')) continue
          if (sample.some((row) => typeof row[k] === 'number' && Number.isFinite(row[k])) && SORT_RATE_KEY.test(k)) numeric.push(k)
          else if (sample.some((row) => percentText(row[k]) !== null)) textual.push(k)
        }
        const columns = [...numeric, ...textual].slice(0, 4)
        return columns.length === 0 ? null : { nameKey, columns }
      }

      /** 行上的置顶标记：后端把「精选 / 已订阅」排在最前，标出来才不会看着像排序坏了。 */
      function tableRowTags(row) {
        const tags = []
        if (typeof row.handpick === 'string' && row.handpick !== '') tags.push(row.handpick)
        if (row.isSubscribed === true) tags.push('已订阅')
        return tags
      }

      function tableCellText(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return ratioText(value)
        return percentText(value) ?? (value === null || value === undefined ? '-' : String(value))
      }

      /** tab 上的行数角标：没有表就清空（不写 0 —— 0 行与「没有这张表」不是一回事）。 */
      function setTableCount(count) {
        tableCount.textContent = count === null ? '' : String(count)
      }

      /**
       * 把响应体里的「对象数组」铺成表格；铺不出来时**写明原因**（tab 是常驻的，
       * 空着会像坏了），并且绝不把截断/解析不了的响应硬凑成半张表。
       * @returns 是否真的画出了表（调用方靠它决定要不要把用户从空表上挪回「响应体」）
       */
      function renderTablePane() {
        tablePane.textContent = ''
        setTableCount(null)
        const empty = (reason) => {
          tablePane.appendChild(el('div', 'pm-empty', reason))
          return false
        }
        const text = typeof state.respRaw === 'string' ? state.respRaw : ''
        if (state.respFailed) return empty('请求失败，没有响应体可解析')
        if (text === '') return empty('尚未发送请求')
        // 截断的 body 无法整体解析，如实说明（与响应体的「已截断」口径一致）
        if (state.respTruncated) return empty('响应体已截断，无法整体解析（不铺半张表）')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          return empty('这份响应不是 JSON，没有可铺成表格的数据')
        }
        const rows = pickListRows(json)
        if (rows === null) return empty('这份响应里没有「元素为对象的数组」（例如 data.list / rows / items）')
        const model = buildTableColumns(rows)
        if (model === null) return empty(`认出了 ${rows.length} 行，但没有可展示的列`)
        const params = sortParamsOf(urlInput.value.trim())

        const head = el('div', 'pm-tbl-head')
        head.appendChild(el('div', 'pm-t', `表格视图 · 共 ${rows.length} 行`))
        const basis = ['顺序 = 接口返回顺序（未重排）']
        if (params.field !== null) basis.push(`sortField=${params.field}${params.period === null ? '' : `(${params.period})`}`)
        if (params.dir !== null) basis.push(`sortType=${params.dir}`)
        head.appendChild(el('div', '', basis.join(' · ')))
        tablePane.appendChild(head)

        const scroll = el('div', 'pm-tbl-scroll')
        const table = el('table', 'pm-tbl-table')
        const headRow = el('tr')
        headRow.appendChild(el('th', 'pm-tbl-rank', '顺序'))
        const nameTh = el('th', 'pm-tbl-name', model.nameKey === null ? '名称' : SORT_NAME_LABELS[model.nameKey] ?? model.nameKey)
        nameTh.title = model.nameKey ?? '未识别到名称字段'
        headRow.appendChild(nameTh)
        for (const key of model.columns) {
          const th = el('th', '', key === 'sortYieldRate' && params.period !== null ? `sort(${params.period})` : SORT_COLUMN_LABELS[key] ?? key)
          th.dataset.key = key
          th.title = key
          headRow.appendChild(th)
        }
        table.appendChild(headRow)

        const tbody = el('tbody')
        rows.slice(0, SORT_ROWS_CAP).forEach((row, index) => {
          const tr = el('tr')
          tr.appendChild(el('td', 'pm-tbl-rank', String(index + 1)))
          const nameTd = el('td', 'pm-tbl-name', model.nameKey === null ? '-' : String(row[model.nameKey] ?? '-'))
          for (const tag of tableRowTags(row)) nameTd.appendChild(el('span', 'pm-tbl-tag', tag))
          tr.appendChild(nameTd)
          for (const key of model.columns) tr.appendChild(el('td', key === model.columns[0] ? 'pm-tbl-key' : '', tableCellText(row[key])))
          tbody.appendChild(tr)
        })
        table.appendChild(tbody)
        scroll.appendChild(table)
        tablePane.appendChild(scroll)
        if (rows.length > SORT_ROWS_CAP) tablePane.appendChild(el('div', 'pm-tbl-head', `只渲染前 ${SORT_ROWS_CAP} 行（共 ${rows.length} 行）`))
        setTableCount(rows.length)
        return true
      }

      function renderResponse(response) {
        statusLine.textContent = ''
        let hasTable = false
        if (response && response.ok) {
          statusLine.appendChild(statusBadge(response.status))
          const meta = el(
            'span',
            'pm-status-meta',
            `${response.statusText || ''} · ${fmtDur(response.durationMs)} · ${response.sizeExact === false ? '≥' : ''}${fmtSize(response.size)}${response.truncated ? ' · 已截断' : ''}`,
          )
          statusLine.appendChild(meta)
          state.respFailed = false
          state.respRaw = response.body ?? ''
          state.respContentType = response.contentType || ''
          state.respTruncated = response.truncated === true
          renderRespBody()
          hasTable = renderTablePane()
          respHeadersPre.textContent = headersToText(response.headers)
        } else {
          const badge = el('span', 'pm-badge pm-s-5', '×')
          statusLine.appendChild(badge)
          statusLine.appendChild(el('span', 'pm-status-err', (response && response.error) || '请求失败'))
          if (response && Number.isFinite(response.durationMs)) statusLine.appendChild(el('span', 'pm-status-meta', fmtDur(response.durationMs)))
          state.respFailed = true
          state.respRaw = (response && response.error) || ''
          state.respContentType = ''
          state.respTruncated = false
          respBodyPre.textContent = state.respRaw
          renderTablePane()
          respHeadersPre.textContent = ''
        }
        // 保留用户选中的那个 tab（发第二次不该把人踢回「响应体」）；但他若停在「表格视图」
        // 而这次没有表可铺，就退回「响应体」—— 空表的原因仍写在那一栏里，切回去就能看到。
        selectRespTab(state.respTab === 'table' && !hasTable ? 'body' : state.respTab)
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
          // 模板原样发给宿主：{{变量}}、鉴权头、GraphQL 组装、断言、提取都在宿主侧做（与集合运行器同一份实现）
          const payload = {
            resolve: true,
            template: currentComposer(),
            collectionId: state.current ? state.current.collectionId : undefined,
            asserts: collectAsserts(),
            extract: collectExtract(),
            timeoutMs: 30000,
          }
          const result = await apiFetch('/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          renderResponse(result.response)
          renderChecks(result)
          if (Array.isArray(result.unresolved) && result.unresolved.length > 0) {
            const warn = el('span', 'pm-warn', `⚠ 没找到变量：${result.unresolved.join(', ')}（按原样发出）`)
            warn.title = '检查当前环境 / 集合变量 / 全局变量里有没有这些名字'
            statusLine.appendChild(warn)
          }
          if (result.environment) statusLine.appendChild(el('span', 'pm-status-meta', `环境：${result.environment.name}`))
          if (Array.isArray(result.notes)) for (const n of result.notes) statusLine.appendChild(el('span', 'pm-warn', n))
          if (result.workspaceChanged) loadWorkspace()
        } catch (error) {
          renderResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
          renderChecks(null)
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
          applyMode(detectMode(rec.request?.url ?? ''))
          methodSel.value = METHODS.includes(rec.request?.method) ? rec.request.method : 'GET'
          setUrl(rec.request?.url ?? '')
          setHeaders(rec.request?.headers ?? {})
          // 历史里存的是真正发出去的请求（变量已替换、鉴权已拼进请求头）：按原始 Raw 请求回填
          state.bodyMode = 'raw'
          bodyModeSel.value = 'raw'
          updateBodyMode()
          bodyText.value = rec.request?.body ?? ''
          state.auth = { type: 'none', token: '', user: '', pass: '' }
          authSel.value = 'none'
          updateAuthUI()
          detachComposer()
          renderResponse(rec.response)
          renderChecks(undefined)
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

      // ---- live (WS / TCP / gRPC) modes: {{env}} substitution on headers（HTTP 发送在宿主侧解析）
      function substHeaders(headers) {
        const out = {}
        for (const [k, v] of Object.entries(headers)) out[substVars(k, state.env)] = substVars(v, state.env)
        return out
      }

      const enc = encodeURIComponent
      const errText = (error) => (error instanceof Error ? error.message : String(error))
      function optionList(sel, pairs) {
        sel.textContent = ''
        for (const [value, label] of pairs) {
          const o = el('option', '', label)
          o.value = value
          sel.appendChild(o)
        }
      }
      function short(text, max = 160) {
        const s = String(text ?? '')
        return s.length > max ? s.slice(0, max) + '…' : s
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

      // ---- workspace（宿主侧 workspace.json：集合 / 文件夹 / 请求 / 环境 / 全局变量；agent 的 http_collection 读写同一份）
      function activeEnv() {
        const ws = state.workspace
        return ws ? ws.environments.find((e) => e.id === ws.activeEnvironmentId) || null : null
      }
      function currentCollection() {
        const ws = state.workspace
        if (!ws || !state.current) return null
        return ws.collections.find((c) => c.id === state.current.collectionId) || null
      }
      /** 在集合里找条目：{ item, path(上级文件夹名), parentId }。 */
      function findEntry(col, itemId) {
        const walk = (items, path, parentId) => {
          for (const it of items) {
            if (it.id === itemId) return { item: it, path, parentId }
            if (it.type === 'folder') {
              const hit = walk(it.items, [...path, it.name], it.id)
              if (hit) return hit
            }
          }
          return null
        }
        return col ? walk(col.items, [], null) : null
      }
      function countRequests(items) {
        let n = 0
        for (const it of items) n += it.type === 'folder' ? countRequests(it.items) : 1
        return n
      }
      /** WS / gRPC 用的扁平变量表：全局 < 集合（编辑器里的请求所在的集合）< 当前环境。 */
      function recomputeEnv() {
        const map = {}
        const put = (list) => {
          for (const v of list || []) if (v.enabled !== false) map[v.key] = v.value ?? ''
        }
        if (state.workspace) {
          put(state.workspace.globals)
          const col = currentCollection()
          if (col) put(col.variables)
          const env = activeEnv()
          if (env) put(env.variables)
        }
        state.env = map
      }
      function renderEnvSel() {
        const ws = state.workspace
        optionList(envSel, [['', '无环境'], ...(ws ? ws.environments.map((e) => [e.id, e.name]) : [])])
        envSel.value = ws && ws.activeEnvironmentId ? ws.activeEnvironmentId : ''
        const env = activeEnv()
        envSel.title = env ? `当前环境「${env.name}」：${env.variables.filter((v) => v.enabled !== false).length} 个变量` : '没有选环境：只用全局变量 / 集合变量'
      }
      function updateCurLabel() {
        const col = currentCollection()
        const entry = col ? findEntry(col, state.current.itemId) : null
        if (!entry) {
          state.current = null
          curLabel.textContent = ''
          curLabel.title = ''
          return
        }
        const text = [col.name, ...entry.path, entry.item.name].join(' / ')
        curLabel.textContent = '· ' + text
        curLabel.title = '正在编辑已保存的请求：' + text + '（点「保存」会覆盖它）'
      }
      function applyWorkspace(r) {
        if (!r || !r.workspace) return
        state.workspace = r.workspace
        if (r.storePath) state.storePath = r.storePath
        state.workspaceError = r.warning || ''
        updateCurLabel()
        recomputeEnv()
        renderEnvSel()
        renderCollections()
        storeNote.textContent = (state.notice ? state.notice + '　' : '') + (state.workspaceError ? '⚠ ' + state.workspaceError + '　' : '') + (state.storePath ? '集合与环境保存在宿主侧：' + state.storePath : '')
      }
      async function loadWorkspace() {
        try {
          applyWorkspace(await apiFetch('/workspace'))
        } catch (error) {
          state.workspaceError = errText(error)
          storeNote.textContent = '⚠ 读取集合 / 环境失败：' + state.workspaceError
          if (state.workspace === null) renderCollections()
        }
      }
      /** 改工作区：成功后整份刷新；失败弹窗说明原因并返回 null。 */
      async function wsMutate(path, method, payload) {
        try {
          const r = await apiFetch(path, {
            method,
            headers: { 'content-type': 'application/json' },
            body: payload === undefined ? undefined : JSON.stringify(payload),
          })
          applyWorkspace(r)
          return r
        } catch (error) {
          window.alert(errText(error))
          return null
        }
      }
      /**
       * 旧版面板把集合 / 环境存在 localStorage：首次打开新版时搬进宿主（浏览器里的原数据留着不删）。
       * localStorage 按源隔离（localhost 与 127.0.0.1 各一份），所以「搬过没有」按源记在本地；
       * 宿主按内容指纹去重，同一份数据不会搬两遍。
       */
      const LEGACY_DONE_KEY = 'dsh-postman-legacy-migrated'
      async function migrateLegacy() {
        if (!state.workspace) return
        let collections = []
        let envText = ''
        try {
          if (window.localStorage.getItem(LEGACY_DONE_KEY)) return
          const raw = window.localStorage.getItem('dsh-postman-collections')
          const parsed = raw ? JSON.parse(raw) : null
          if (parsed && Array.isArray(parsed.collections)) collections = parsed.collections
          envText = window.localStorage.getItem('dsh-postman-env') || ''
        } catch {
          return
        }
        if (collections.length === 0 && envText.trim() === '') return
        const r = await wsMutate('/workspace/legacy-import', 'POST', { collections, envText })
        if (r) {
          try {
            window.localStorage.setItem(LEGACY_DONE_KEY, String(Date.now()))
          } catch {
            /* ignore */
          }
        }
        if (r && r.result && !r.result.skipped) {
          for (const c of state.workspace.collections) state.openIds.add(c.id)
          renderCollections()
          state.notice = `已把浏览器里旧的 ${r.result.collections} 个集合、${r.result.requests} 个请求${r.result.environment ? '和环境变量（「默认环境」）' : ''}搬进宿主侧存储（浏览器里的原数据没删）。`
          applyWorkspace({ workspace: state.workspace, storePath: state.storePath })
        }
      }
      envSel.addEventListener('change', () => {
        wsMutate('/environments/active', 'POST', { id: envSel.value || null })
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
      curlOutBtn.addEventListener('click', async () => {
        // 变量 / 鉴权 / GraphQL 的组装在宿主侧（与发送同一份实现），复制出来的就是真正会发出去的那条
        try {
          const r = await apiFetch('/resolve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ template: currentComposer(), collectionId: state.current ? state.current.collectionId : undefined }),
          })
          copyToClipboard(toCurl(r.request), curlOutBtn)
          if (Array.isArray(r.unresolved) && r.unresolved.length > 0) window.alert(`已复制；注意这些变量没找到，按原样保留：${r.unresolved.join(', ')}`)
        } catch (error) {
          window.alert('复制失败：' + errText(error))
        }
      })

      // ---- 断言 / 提取编辑器
      function checkbox(checked, title) {
        const cb = el('input', '')
        cb.type = 'checkbox'
        cb.checked = checked
        cb.title = title
        return cb
      }
      function updateChecksCount() {
        const n = collectAsserts().filter((a) => a.enabled !== false).length
        const m = collectExtract().filter((x) => x.enabled !== false).length
        checksCount.textContent = n + m > 0 ? `(${n}${m > 0 ? '+' + m : ''})` : ''
      }
      function addAssertRow(spec = {}) {
        const row = el('div', 'pm-crow')
        const en = checkbox(spec.enabled !== false, '启用这条断言')
        const src = el('select', '')
        optionList(src, ASSERT_SOURCE_OPTS)
        src.value = OPS_BY_SOURCE[spec.source] ? spec.source : 'status'
        const pathIn = el('input', 'pm-cpath')
        pathIn.spellcheck = false
        pathIn.value = spec.path || ''
        const op = el('select', '')
        const val = el('input', 'pm-cval')
        val.spellcheck = false
        val.value = spec.value ?? ''
        const del = el('button', 'pm-hdel', '×')
        del.title = '删除'
        const syncVal = () => {
          val.hidden = VALUELESS_OPS.includes(op.value)
          val.placeholder = op.value === 'type' ? 'string / number / boolean / object / array / null'
            : op.value === 'in' ? '200,201' : op.value === 'regex' ? '正则' : src.value === 'duration' ? '毫秒，如 1000' : '期望值（可写 {{变量}}）'
        }
        const syncSource = (wantedOp) => {
          const ops = OPS_BY_SOURCE[src.value]
          optionList(op, ops.map((o) => [o, OP_LABELS[o]]))
          op.value = ops.includes(wantedOp) ? wantedOp : ops[0]
          pathIn.hidden = !(src.value === 'json' || src.value === 'header')
          pathIn.placeholder = src.value === 'header' ? '响应头名，如 content-type' : 'data.code（空 = 整个响应体）'
          syncVal()
        }
        syncSource(spec.op)
        src.addEventListener('change', () => {
          syncSource(op.value)
          updateChecksCount()
        })
        op.addEventListener('change', syncVal)
        en.addEventListener('change', updateChecksCount)
        del.addEventListener('click', () => {
          row.remove()
          updateChecksCount()
        })
        row.append(en, src, pathIn, op, val, del)
        row._get = () => ({ enabled: en.checked, source: src.value, path: pathIn.hidden ? '' : pathIn.value.trim(), op: op.value, value: val.hidden ? '' : val.value })
        assertList.appendChild(row)
      }
      function addExtractRow(spec = {}) {
        const row = el('div', 'pm-crow')
        const en = checkbox(spec.enabled !== false, '启用这条提取')
        const varIn = el('input', 'pm-cvar')
        varIn.placeholder = '变量名'
        varIn.spellcheck = false
        varIn.value = spec.var || ''
        const src = el('select', '')
        optionList(src, EXTRACT_SOURCE_OPTS)
        src.value = EXTRACT_SOURCE_OPTS.some(([v]) => v === spec.source) ? spec.source : 'json'
        const pathIn = el('input', 'pm-cpath')
        pathIn.spellcheck = false
        pathIn.value = spec.path || ''
        const scope = el('select', '')
        optionList(scope, EXTRACT_SCOPE_OPTS)
        scope.value = EXTRACT_SCOPE_OPTS.some(([v]) => v === spec.scope) ? spec.scope : 'environment'
        const del = el('button', 'pm-hdel', '×')
        del.title = '删除'
        const sync = () => {
          pathIn.hidden = src.value === 'status'
          pathIn.placeholder = src.value === 'header' ? '响应头名' : src.value === 'body' ? '正则，如 token=(\\w+)' : 'data.token'
        }
        sync()
        src.addEventListener('change', sync)
        en.addEventListener('change', updateChecksCount)
        del.addEventListener('click', () => {
          row.remove()
          updateChecksCount()
        })
        row.append(en, varIn, el('span', 'pm-hint', '←'), src, pathIn, scope, del)
        row._get = () => ({ enabled: en.checked, var: varIn.value.trim(), source: src.value, path: pathIn.hidden ? '' : pathIn.value.trim(), scope: scope.value })
        extractList.appendChild(row)
      }
      function collectAsserts() {
        return Array.from(assertList.children).map((r) => r._get())
      }
      function collectExtract() {
        return Array.from(extractList.children).map((r) => r._get()).filter((x) => x.var !== '')
      }
      function setChecks(asserts, extract) {
        assertList.textContent = ''
        extractList.textContent = ''
        for (const a of asserts || []) addAssertRow(a)
        for (const x of extract || []) addExtractRow(x)
        updateChecksCount()
      }
      addAssertBtn.addEventListener('click', () => {
        addAssertRow({ source: 'status', op: 'eq', value: '200' })
        updateChecksCount()
      })
      addExtractBtn.addEventListener('click', () => {
        addExtractRow({ source: 'json', scope: 'environment' })
        updateChecksCount()
      })
      checksPane.addEventListener('input', updateChecksCount)

      // ---- 断言结果（响应区第四个 tab）
      function renderChecks(result) {
        respChecksPane.textContent = ''
        tabRespChecks.classList.remove('pm-ok', 'pm-bad')
        const checks = result && result.checks
        if (!checks) {
          respChecksCount.textContent = ''
          respChecksPane.appendChild(el('div', 'pm-empty', result === null ? '请求没发出去，没有断言结果' : '发送后在这里逐条看断言是否通过、提取到了什么'))
          return
        }
        const asserts = checks.asserts || []
        const extract = checks.extract || []
        const passed = asserts.filter((a) => a.pass).length
        respChecksCount.textContent = asserts.length > 0 ? `(${passed}/${asserts.length})` : ''
        if (asserts.length > 0) tabRespChecks.classList.add(passed === asserts.length ? 'pm-ok' : 'pm-bad')
        if (asserts.length === 0 && extract.length === 0) {
          respChecksPane.appendChild(el('div', 'pm-empty', '这个请求没有设断言 —— 在上面「断言」里添加，发送后这里逐条显示通过 / 失败'))
          return
        }
        for (const a of asserts) {
          const row = el('div', 'pm-cres')
          row.appendChild(el('span', a.pass ? 'pm-ok' : 'pm-bad', a.pass ? '✓' : '✗'))
          row.appendChild(el('span', 'pm-cres-desc', a.desc))
          row.appendChild(el('span', 'pm-cres-act', [a.actual !== '' ? `实际 ${a.actual}` : '', a.error || '', a.note || ''].filter((s) => s !== '').join(' · ')))
          respChecksPane.appendChild(row)
        }
        const where = { environment: '当前环境', collection: '集合变量', globals: '全局变量', runtime: '只在本次' }
        for (const x of extract) {
          const row = el('div', 'pm-cres')
          row.appendChild(el('span', x.ok ? 'pm-ok' : 'pm-warn', x.ok ? '→' : '!'))
          row.appendChild(el('span', 'pm-cres-desc', `{{${x.var}}}`))
          row.appendChild(el('span', 'pm-cres-act', x.ok ? `= ${short(x.value)}（${where[x.savedTo || x.scope] || x.scope}）` : x.error || '没取到'))
          respChecksPane.appendChild(row)
        }
        if (asserts.length > 0) {
          const allOk = passed === asserts.length
          const badge = el('span', allOk ? 'pm-ok' : 'pm-bad', allOk ? `断言 ${passed}/${asserts.length} 通过` : `断言 ${asserts.length - passed}/${asserts.length} 失败`)
          badge.style.cursor = 'pointer'
          badge.title = '看断言结果'
          badge.addEventListener('click', () => selectRespTab('checks'))
          statusLine.appendChild(badge)
        }
      }

      // ---- 编辑器 ⇄ 已保存的请求
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
      /** 编辑器换成了一个「不是已保存请求」的东西（历史 / 抓包预填）：不再指向集合里的条目，断言清空。 */
      function detachComposer() {
        state.current = null
        setChecks([], [])
        updateCurLabel()
        recomputeEnv()
        renderCollections()
      }
      function loadSaved(col, item) {
        loadComposer(item.request)
        setChecks(item.asserts, item.extract)
        state.current = { collectionId: col.id, itemId: item.id }
        updateCurLabel()
        recomputeEnv()
        renderCollections()
        renderChecks(undefined)
      }
      function reqBadge(r) {
        if (r.mode === 'ws') return el('span', 'pm-badge pm-m-other', 'WS')
        if (r.mode === 'tcp') return el('span', 'pm-badge pm-m-other', 'TCP')
        if (r.mode === 'grpc') return el('span', 'pm-badge pm-m-other', 'gRPC')
        return methodBadge((r.method || 'GET').toUpperCase())
      }

      // ---- 集合树
      function treeBtn(label, title, fn) {
        const b = el('button', 'pm-tree-btn', label)
        b.title = title
        b.addEventListener('click', (e) => {
          e.stopPropagation()
          fn()
        })
        return b
      }
      function renderCollections() {
        colTree.textContent = ''
        const ws = state.workspace
        if (!ws) {
          colTree.appendChild(el('div', 'pm-empty', state.workspaceError ? '读取集合失败：' + state.workspaceError : '加载中…'))
          return
        }
        if (ws.collections.length === 0) {
          colTree.appendChild(el('div', 'pm-empty', '暂无集合 — 点「保存当前请求」或「新建集合」'))
          return
        }
        for (const col of ws.collections) renderNode(col, col, 0, true)
      }
      function renderNode(col, node, depth, isCollection) {
        if (isCollection || node.type === 'folder') {
          const isFolder = !isCollection
          const open = state.openIds.has(node.id)
          const row = el('div', 'pm-col-row' + (isFolder ? ' pm-folder' : ''))
          row.style.paddingLeft = 12 + depth * 18 + 'px'
          row.appendChild(el('span', 'pm-col-caret', open ? '▾' : '▸'))
          row.appendChild(el('span', 'pm-col-name', `${isFolder ? '📁 ' : ''}${node.name} (${countRequests(node.items)})`))
          const act = el('span', 'pm-tree-act')
          act.appendChild(treeBtn('▶ 运行', isCollection ? '按顺序运行整个集合' : '按顺序运行这个文件夹', () => openRunDialog(col, isFolder ? node : null, null)))
          act.appendChild(treeBtn('＋文件夹', '在这里新建文件夹', () => newFolder(col, isFolder ? node : null)))
          if (isCollection) {
            act.appendChild(treeBtn('变量', '集合变量：只对这个集合里的请求生效，优先级低于环境', () => editCollectionVars(col)))
            act.appendChild(treeBtn('导出', '导出成 .dsh-collection.json（可以发给别人导入）', () => exportCollection(col)))
          }
          act.appendChild(treeBtn('改名', '重命名', () => renameNode(col, isCollection ? null : node)))
          act.appendChild(treeBtn('×', isCollection ? '删除集合' : '删除文件夹', () => deleteNode(col, isCollection ? null : node)))
          row.appendChild(act)
          row.addEventListener('click', () => {
            if (open) state.openIds.delete(node.id)
            else state.openIds.add(node.id)
            renderCollections()
          })
          colTree.appendChild(row)
          if (open) {
            for (const child of node.items) renderNode(col, child, depth + 1, false)
            if (node.items.length === 0) {
              const empty = el('div', 'pm-req-row pm-hint', '（空）')
              empty.style.paddingLeft = 32 + (depth + 1) * 18 + 'px'
              colTree.appendChild(empty)
            }
          }
          return
        }
        const rr = el('div', 'pm-req-row')
        rr.style.paddingLeft = 32 + depth * 18 + 'px'
        if (state.current && state.current.itemId === node.id) rr.dataset.current = ''
        rr.appendChild(reqBadge(node.request))
        const rn = el('span', 'pm-req-name', node.name)
        rn.title = `${node.request.method || ''} ${node.request.url || ''}`
        rr.appendChild(rn)
        const n = (node.asserts || []).filter((a) => a.enabled !== false).length
        if (n > 0) {
          const tag = el('span', 'pm-count', `✓${n}`)
          tag.title = `${n} 条断言`
          rr.appendChild(tag)
        }
        const act = el('span', 'pm-tree-act')
        act.appendChild(treeBtn('▶', '单独运行这个请求（带断言和提取）', () => openRunDialog(col, null, node)))
        act.appendChild(treeBtn('改名', '重命名', () => renameNode(col, node)))
        act.appendChild(treeBtn('×', '删除请求', () => deleteNode(col, node)))
        rr.appendChild(act)
        rr.addEventListener('click', () => loadSaved(col, node))
        colTree.appendChild(rr)
      }
      async function newCollection() {
        const name = window.prompt('新集合名', '新集合')
        if (name === null) return
        const r = await wsMutate('/collections', 'POST', { name })
        if (r && r.result) {
          state.openIds.add(r.result.id)
          renderCollections()
        }
      }
      async function newFolder(col, parent) {
        const name = window.prompt('文件夹名', '新文件夹')
        if (name === null) return
        const r = await wsMutate(`/collections/${enc(col.id)}/items`, 'POST', { type: 'folder', name, parentId: parent ? parent.id : null })
        if (r && r.result) {
          state.openIds.add(parent ? parent.id : col.id)
          renderCollections()
        }
      }
      async function renameNode(col, node) {
        const old = node ? node.name : col.name
        const name = window.prompt('新名称', old)
        if (name === null || name.trim() === '' || name === old) return
        if (node) await wsMutate(`/collections/${enc(col.id)}/items/${enc(node.id)}`, 'PATCH', { name })
        else await wsMutate(`/collections/${enc(col.id)}`, 'PATCH', { name })
      }
      async function deleteNode(col, node) {
        const what = !node ? `集合「${col.name}」及其中 ${countRequests(col.items)} 个请求`
          : node.type === 'folder' ? `文件夹「${node.name}」及其中 ${countRequests(node.items)} 个请求` : `请求「${node.name}」`
        if (!window.confirm(`删除${what}？`)) return
        if (node) await wsMutate(`/collections/${enc(col.id)}/items/${enc(node.id)}`, 'DELETE')
        else await wsMutate(`/collections/${enc(col.id)}`, 'DELETE')
      }
      function editCollectionVars(col) {
        openModal(
          `集合「${col.name}」的变量（每行 KEY=VALUE，# KEY=VALUE 表示停用；只对这个集合里的请求生效，优先级低于环境）`,
          variablesToText(col.variables),
          'base=https://api.example.com',
          (text) => {
            wsMutate(`/collections/${enc(col.id)}`, 'PATCH', { variablesText: text })
          },
        )
      }
      async function exportCollection(col) {
        try {
          const data = await apiFetch(`/collections/${enc(col.id)}/export`)
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = `${col.name.replace(/[\\/:*?"<>|]+/g, '_')}.dsh-collection.json`
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(a.href), 5000)
        } catch (error) {
          window.alert('导出失败：' + errText(error))
        }
      }
      newColBtn.addEventListener('click', newCollection)
      importColBtn.addEventListener('click', () => importColFile.click())
      importColFile.addEventListener('change', async () => {
        const file = importColFile.files && importColFile.files[0]
        importColFile.value = ''
        if (!file) return
        let text
        try {
          text = await file.text()
        } catch (error) {
          window.alert('读文件失败：' + errText(error))
          return
        }
        const r = await wsMutate('/collections/import', 'POST', { data: text })
        if (r && r.result) {
          state.openIds.add(r.result.id)
          renderCollections()
        }
      })

      // ---- 保存
      function defaultReqName(c) {
        try {
          const u = new URL(substVars(c.url, state.env))
          return `${c.method || 'GET'} ${u.pathname}`
        } catch {
          return `${c.method || 'GET'} ${c.url || '请求'}`
        }
      }
      function folderOptions(col) {
        const out = [['', '（集合根目录）']]
        const walk = (items, path) => {
          for (const it of items) {
            if (it.type !== 'folder') continue
            const p = [...path, it.name]
            out.push([it.id, p.join(' / ')])
            walk(it.items, p)
          }
        }
        if (col) walk(col.items, [])
        return out
      }
      function fillSaveFolders() {
        const ws = state.workspace
        const col = ws && saveColSel.value !== '__new__' ? ws.collections.find((c) => c.id === saveColSel.value) : null
        optionList(saveFolderSel, folderOptions(col))
        saveFolderRow.hidden = !col
      }
      function openSaveDialog() {
        const ws = state.workspace
        if (!ws) {
          window.alert('集合还没加载出来：' + (state.workspaceError || '请稍后再试'))
          return
        }
        optionList(saveColSel, [...ws.collections.map((c) => [c.id, c.name]), ['__new__', '＋ 新建集合']])
        const cur = currentCollection()
        const entry = cur ? findEntry(cur, state.current.itemId) : null
        saveColSel.value = cur ? cur.id : ws.collections.length > 0 ? ws.collections[0].id : '__new__'
        fillSaveFolders()
        if (entry && entry.parentId) saveFolderSel.value = entry.parentId
        saveNameIn.value = entry ? `${entry.item.name} 副本` : defaultReqName(currentComposer())
        saveNewColIn.value = ''
        saveNewColRow.hidden = saveColSel.value !== '__new__'
        saveDlg.hidden = false
        saveNameIn.focus()
      }
      async function doSave() {
        const name = saveNameIn.value.trim() || '未命名请求'
        let colId = saveColSel.value
        if (colId === '__new__') {
          const created = await wsMutate('/collections', 'POST', { name: saveNewColIn.value.trim() || '默认集合' })
          if (!created || !created.result) return
          colId = created.result.id
        }
        const parentId = saveColSel.value === '__new__' ? null : saveFolderSel.value || null
        const r = await wsMutate(`/collections/${enc(colId)}/items`, 'POST', {
          type: 'request',
          parentId,
          name,
          request: currentComposer(),
          asserts: collectAsserts(),
          extract: collectExtract(),
        })
        if (!r || !r.result) return
        state.current = { collectionId: colId, itemId: r.result.id }
        state.openIds.add(colId)
        if (parentId) state.openIds.add(parentId)
        updateCurLabel()
        recomputeEnv()
        renderCollections()
        saveDlg.hidden = true
      }
      /** 顶栏「保存」/ Ctrl+S：编辑的是已保存的请求就覆盖它，否则走「另存为」对话框。 */
      async function saveCurrent() {
        const col = currentCollection()
        if (!col || !findEntry(col, state.current.itemId)) {
          openSaveDialog()
          return
        }
        const r = await wsMutate(`/collections/${enc(col.id)}/items/${enc(state.current.itemId)}`, 'PATCH', {
          request: currentComposer(),
          asserts: collectAsserts(),
          extract: collectExtract(),
        })
        if (r) {
          saveTopBtn.textContent = '已保存 ✓'
          setTimeout(() => {
            saveTopBtn.textContent = '保存'
          }, 1200)
        }
      }
      saveTopBtn.addEventListener('click', saveCurrent)
      saveReqBtn.addEventListener('click', openSaveDialog)
      saveColSel.addEventListener('change', () => {
        saveNewColRow.hidden = saveColSel.value !== '__new__'
        fillSaveFolders()
      })
      saveCancel.addEventListener('click', () => {
        saveDlg.hidden = true
      })
      saveOk.addEventListener('click', doSave)

      // ---- 环境与全局变量
      let envEditing = '__globals__'
      function fillEnvEditSel() {
        const ws = state.workspace
        optionList(envEditSel, [['__globals__', '全局变量'], ...(ws ? ws.environments.map((e) => [e.id, (e.id === ws.activeEnvironmentId ? '● ' : '') + e.name]) : [])])
        if (!Array.from(envEditSel.options).some((o) => o.value === envEditing)) envEditing = '__globals__'
        envEditSel.value = envEditing
      }
      function loadEnvEditor() {
        const ws = state.workspace
        const isGlobals = envEditing === '__globals__'
        const env = !isGlobals && ws ? ws.environments.find((e) => e.id === envEditing) : null
        envNameIn.value = env ? env.name : ''
        envNameIn.disabled = isGlobals
        envDelBtn.disabled = isGlobals
        envUseBtn.disabled = isGlobals || (ws !== null && ws.activeEnvironmentId === envEditing)
        envUseBtn.textContent = !isGlobals && ws !== null && ws.activeEnvironmentId === envEditing ? '已是当前环境' : '设为当前'
        envTa.value = variablesToText(isGlobals ? (ws ? ws.globals : []) : env ? env.variables : [])
        envMsg.textContent = state.storePath ? '保存在宿主侧：' + state.storePath + '（agent 的 http_request / http_collection 用同一份）' : ''
      }
      function openEnvDialog() {
        const ws = state.workspace
        if (!ws) {
          window.alert('环境还没加载出来：' + (state.workspaceError || '请稍后再试'))
          return
        }
        envEditing = ws.activeEnvironmentId || (ws.environments[0] ? ws.environments[0].id : '__globals__')
        fillEnvEditSel()
        loadEnvEditor()
        envDlg.hidden = false
        envTa.focus()
      }
      envEditSel.addEventListener('change', () => {
        envEditing = envEditSel.value
        loadEnvEditor()
      })
      envNewBtn.addEventListener('click', async () => {
        const name = window.prompt('新环境名（如 测试 / 预发 / 生产）', '新环境')
        if (name === null) return
        const r = await wsMutate('/environments', 'POST', { name })
        if (r && r.result) {
          envEditing = r.result.id
          fillEnvEditSel()
          loadEnvEditor()
        }
      })
      envDelBtn.addEventListener('click', async () => {
        const ws = state.workspace
        const env = ws ? ws.environments.find((e) => e.id === envEditing) : null
        if (!env || !window.confirm(`删除环境「${env.name}」？`)) return
        const r = await wsMutate(`/environments/${enc(env.id)}`, 'DELETE')
        if (r) {
          envEditing = '__globals__'
          fillEnvEditSel()
          loadEnvEditor()
        }
      })
      envUseBtn.addEventListener('click', async () => {
        const r = await wsMutate('/environments/active', 'POST', { id: envEditing })
        if (r) {
          fillEnvEditSel()
          loadEnvEditor()
        }
      })
      envSaveBtn.addEventListener('click', async () => {
        const r = envEditing === '__globals__'
          ? await wsMutate('/globals', 'PUT', { variablesText: envTa.value })
          : await wsMutate(`/environments/${enc(envEditing)}`, 'PATCH', { name: envNameIn.value, variablesText: envTa.value })
        if (r) {
          fillEnvEditSel()
          loadEnvEditor()
          envMsg.textContent = '已保存 ✓　' + envMsg.textContent
        }
      })
      envCloseBtn.addEventListener('click', () => {
        envDlg.hidden = true
      })
      envBtn.addEventListener('click', openEnvDialog)

      // ---- 集合运行器
      function openRunDialog(col, folder, request) {
        if (state.run && state.run.polling) {
          runDlg.hidden = false
          return
        }
        state.run = { col, folder, request, id: null, since: 0, polling: false, timer: null }
        runTitle.textContent = '运行：' + [col.name, folder ? folder.name : null, request ? request.name : null].filter(Boolean).join(' / ')
        const ws = state.workspace
        const act = activeEnv()
        optionList(runEnvSel, [['__active__', '当前环境' + (act ? `（${act.name}）` : '（无）')], ['', '无环境'], ...(ws ? ws.environments.map((e) => [e.id, e.name]) : [])])
        runEnvSel.value = '__active__'
        const n = request ? 1 : countRequests(folder ? folder.items : col.items)
        runSummary.textContent = `共 ${n} 个请求，按集合里的顺序依次发送。只跑 HTTP(S)，WebSocket / TCP / gRPC 请求会跳过。`
        runList.textContent = ''
        runStartBtn.disabled = n === 0
        runStartBtn.textContent = '开始运行'
        runStopBtn.hidden = true
        runDlg.hidden = false
      }
      function runSummaryText(s) {
        const m = s.summary || {}
        const label = { pass: '✓ 全部通过', fail: '✗ 有失败', incomplete: '… 没跑完', unchecked: '— 没有断言' }[s.outcome] || s.state
        return `${label} · 通过 ${m.passed} / 失败 ${m.failed} / 出错 ${m.errored} / 未设断言 ${m.unchecked}` +
          (m.skipped ? ` / 跳过 ${m.skipped}` : '') + (m.notRun ? ` / 未执行 ${m.notRun}` : '') +
          ` · 断言 ${m.asserts ? m.asserts.passed : 0}✓ ${m.asserts ? m.asserts.failed : 0}✗ · ${fmtDur(s.durationMs)}` +
          (s.environment ? ` · 环境 ${s.environment.name}` : ' · 无环境') +
          (Array.isArray(s.notes) && s.notes.length > 0 ? '\n' + s.notes.join('；') : '') +
          (s.reportPath ? '\n报告：' + s.reportPath : '')
      }
      function appendRunRow(r) {
        const row = el('div', 'pm-run-row')
        const icon = { pass: ['✓', 'pm-ok'], fail: ['✗', 'pm-bad'], error: ['!', 'pm-bad'], unchecked: ['—', 'pm-warn'], skipped: ['↷', 'pm-status-meta'] }[r.verdict] || ['?', '']
        row.appendChild(el('span', icon[1], icon[0]))
        row.appendChild(el('span', 'pm-run-meta', '#' + r.iteration))
        row.appendChild(methodBadge(r.method || 'GET'))
        const nm = el('span', 'pm-run-name', (r.path ? r.path + ' / ' : '') + r.name)
        nm.title = r.url || ''
        row.appendChild(nm)
        if (Number.isInteger(r.status)) row.appendChild(statusBadge(r.status))
        row.appendChild(el('span', 'pm-run-meta', Number.isFinite(r.durationMs) ? fmtDur(r.durationMs) : ''))
        const passed = r.asserts.filter((a) => a.pass).length
        row.appendChild(el('span', 'pm-run-meta', r.asserts.length > 0 ? `断言 ${passed}/${r.asserts.length}` : r.skipped ? '跳过' : '无断言'))
        const detail = el('div', 'pm-run-detail')
        const lines = [`${r.method} ${r.url}`]
        for (const a of r.asserts) lines.push(`${a.pass ? '✓' : '✗'} ${a.desc}　实际 ${a.actual}${a.error ? '　' + a.error : ''}`)
        for (const x of r.extract) lines.push(x.ok ? `→ {{${x.var}}} = ${x.value}${x.savedTo ? `（写到 ${x.savedTo}）` : x.scope === 'runtime' ? '（只在本次运行）' : ''}` : `! {{${x.var}}}：${x.error}`)
        if (r.unresolved) lines.push('⚠ 没找到变量：' + r.unresolved.join(', '))
        if (r.error) lines.push('出错：' + r.error)
        if (r.skipped) lines.push(r.skipped)
        if (r.redirected) lines.push('↪ 跳转后的响应：' + r.finalUrl)
        if (r.bodyPreview) lines.push('响应体：' + r.bodyPreview)
        detail.textContent = lines.join('\n')
        // 失败 / 出错的默认展开，其余点一下看
        detail.hidden = !(r.verdict === 'fail' || r.verdict === 'error')
        row.addEventListener('click', () => {
          detail.hidden = !detail.hidden
        })
        runList.appendChild(row)
        runList.appendChild(detail)
      }
      async function startRun() {
        const run = state.run
        if (!run || run.polling) return
        runList.textContent = ''
        runSummary.textContent = '启动中…'
        runStartBtn.disabled = true
        const envVal = runEnvSel.value
        try {
          const res = await apiFetch('/runs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              collectionId: run.col.id,
              folderId: run.folder ? run.folder.id : undefined,
              requestId: run.request ? run.request.id : undefined,
              environmentId: envVal === '__active__' ? undefined : envVal === '' ? null : envVal,
              iterations: runIterIn.value ? Number(runIterIn.value) : undefined,
              delayMs: runDelayIn.value ? Number(runDelayIn.value) : undefined,
              stopOnFailure: runStopCb.checked,
              persistVariables: runPersistCb.checked,
              data: runData.value.trim() || undefined,
            }),
          })
          run.id = res.id
          run.since = 0
          run.polling = true
          runStopBtn.hidden = false
          runSummary.textContent = `运行中… 0/${res.total}`
          pollRun()
        } catch (error) {
          runSummary.textContent = '启动失败：' + errText(error)
          runStartBtn.disabled = false
        }
      }
      async function pollRun() {
        const run = state.run
        if (!run || !run.polling) return
        try {
          const s = await apiFetch(`/runs/${enc(run.id)}?since=${run.since}`)
          for (const entry of s.results) appendRunRow(entry)
          run.since = s.from + s.results.length
          if (s.state === 'running') {
            runSummary.textContent = `运行中… ${s.done}/${s.total}`
            run.timer = setTimeout(pollRun, 400)
            return
          }
          run.polling = false
          runStopBtn.hidden = true
          runStartBtn.disabled = false
          runStartBtn.textContent = '再跑一次'
          runSummary.textContent = s.state === 'error' ? '运行出错：' + (s.error || '未知错误') : runSummaryText(s)
          loadWorkspace() // 提取的变量可能写回了环境
        } catch (error) {
          run.polling = false
          runStopBtn.hidden = true
          runStartBtn.disabled = false
          runSummary.textContent = '取运行进度失败：' + errText(error)
        }
      }
      runStartBtn.addEventListener('click', startRun)
      runStopBtn.addEventListener('click', () => {
        if (state.run && state.run.id) apiFetch(`/runs/${enc(state.run.id)}/stop`, { method: 'POST' }).catch(() => {})
      })
      runCloseBtn.addEventListener('click', () => {
        runDlg.hidden = true
      })
      runSummary.style.whiteSpace = 'pre-wrap'

      // ---- open / close
      const setOpen = (open) => {
        state.open = open
        if (open) {
          clearSiblings()
          document.documentElement.dataset.dshPostmanActive = 'true'
          urlInput.focus()
          // agent 可能刚用 http_collection 改过集合 / 环境：每次打开都拿最新的
          loadWorkspace()
        } else {
          document.documentElement.removeAttribute('data-dsh-postman-active')
        }
      }
      const toggle = () => setOpen(!state.open)
      closeBtn.addEventListener('click', () => setOpen(false))
      const onKeydown = (event) => {
        if (!state.open) return
        if (event.key === 'Escape') {
          if (!saveDlg.hidden) saveDlg.hidden = true
          else if (!modal.hidden) closeModal()
          else if (!envDlg.hidden) envDlg.hidden = true
          else if (!runDlg.hidden) runDlg.hidden = true
          else setOpen(false)
          return
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
          event.preventDefault()
          if (saveDlg.hidden && modal.hidden && envDlg.hidden && runDlg.hidden) saveCurrent()
        }
      }
      document.addEventListener('keydown', onKeydown)

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
        // 抓来的请求不是集合里的某一条：断开与已保存请求的关联、清掉上一条的断言
        detachComposer()
        // 有查询参数就落在「查询参数」页（用户可直接改 packType/version… 上方 URL 实时联动）；否则回请求头
        selectReqTab(parseUrlParts(d.url).query !== '' ? tabParams : tabHeaders)
        setOpen(true)
      }
      window.addEventListener('dsh-postman:prefill', onPrefill)

      // tab 是常驻的：初次进来就得把那一栏的空态写出来，不能开着一栏空白
      renderTablePane()
      renderChecks(undefined)
      renderCollections()
      // 集合 / 环境在宿主侧：先拿工作区，再把旧版浏览器里的数据（如果有）搬过去
      loadWorkspace().then(migrateLegacy)

      return {
        view,
        toggle,
        dispose: () => {
          wsDisconnect()
          window.removeEventListener('dsh-postman:prefill', onPrefill)
          document.removeEventListener('keydown', onKeydown)
          if (state.run && state.run.timer) clearTimeout(state.run.timer)
          if (state.run) state.run.polling = false
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
