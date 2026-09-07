/**
 * dsh-hang-inspector — client half (browser bundle, hand-built for the
 * __ModuleLoader__ format; no build step).
 *
 * Mounts the 「卡死分析」 sidebar entry and a panel in the center column:
 * left pack list (hang-loop evidence packs) + right detail (frozen screenshot,
 * summary / process-info / net-trace tail / probe / procdump logs, file list).
 * Toolbar has a 「启动监测」 button: one click starts the hang-loop window-
 * responsiveness monitor (no auto-clicking; you drive the client yourself),
 * the run banner tails its log live; when a hang pack lands it is auto-selected
 * and its frozen.dmp is auto-analyzed — the detail shows the suspect thread,
 * the diagnosis and the mapped project source code (「代码问题」 section).
 * Data comes from the host's /api/dsh-hang-inspector route family via plain
 * same-origin fetch; the panel polls while open. Plain DOM everywhere.
 */
window.__ModuleLoader__.load({
  id: '@dsh-agent-toolchain/dsh-hang-inspector',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const API = '/api/dsh-hang-inspector'
    const ENTRY_SEL = '[data-dsh-hanginsp-entry]'
    const POLL_MS = 5000
    const RUN_POLL_MS = 2000

    const CSS = `
[data-dsh-hanginsp-view]{position:absolute;inset:0;z-index:60;display:none;flex-direction:column;
background:var(--dsw-alias-bg-base,#171a21);color:var(--dsw-alias-fg-base,#e6e6e6);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
html[data-dsh-hanginsp-active] [data-dsh-hanginsp-view]{display:flex}
.hpi-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#2a2e37);flex-wrap:wrap}
.hpi-title{font-weight:600;font-size:14px}
.hpi-stats{color:var(--dsw-alias-fg-muted,#9aa0aa);font-size:12px;white-space:nowrap}
.hpi-btn{background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);color:inherit;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}
.hpi-btn:hover{background:var(--dsw-alias-bg-hover,#262b35)}
.hpi-btn-danger:hover{border-color:#c0392b;color:#e74c3c}
.hpi-close{margin-left:auto;font-size:16px;line-height:1;padding:4px 8px}
.hpi-body{flex:1;display:flex;overflow:hidden}
.hpi-list{width:360px;min-width:260px;border-right:1px solid var(--dsw-alias-border-subtle,#2a2e37);overflow:auto;padding:8px}
.hpi-pack{display:block;width:100%;text-align:left;background:var(--dsw-alias-bg-elevated,#20242c);border:1px solid var(--dsw-alias-border-subtle,#2a2e37);border-radius:6px;color:inherit;cursor:pointer;font:inherit;padding:8px 10px;margin-bottom:6px}
.hpi-pack:hover{background:var(--dsw-alias-bg-hover,#262b35)}
.hpi-pack[data-active]{border-color:#60a5fa}
.hpi-pack-name{font-weight:600;font-size:12.5px}
.hpi-pack-line{color:var(--dsw-alias-fg-muted,#9aa0aa);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hpi-pack-badges{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
.hpi-chip{font-size:10.5px;padding:0 6px;border-radius:4px;background:#33363f;color:#cbd5e1}
.hpi-chip[data-k="dump"]{background:#4c1d1d;color:#f87171}
.hpi-chip[data-k="shot"]{background:#1b4d3a;color:#4ade80}
.hpi-detail{flex:1;overflow:auto;padding:10px 14px 20px}
.hpi-empty{text-align:center;color:var(--dsw-alias-fg-muted,#9aa0aa);padding:48px 12px;font-size:12.5px}
.hpi-sec{margin-top:12px}
.hpi-sec-title{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-fg-muted,#9aa0aa);margin-bottom:4px}
.hpi-sec-title .hpi-t{font-weight:600}
.hpi-sec-title .hpi-hint{font-size:11px}
.hpi-img{max-width:100%;max-height:460px;border:1px solid var(--dsw-alias-border-subtle,#2a2e37);border-radius:6px;display:block;background:#000}
.hpi-pre{margin:0;padding:8px 10px;font:12px/1.55 Consolas,Menlo,monospace;color:#9fe8a0;white-space:pre-wrap;word-break:break-all;background:var(--dsw-alias-bg-elevated,#20242c);border-radius:6px;max-height:340px;overflow:auto}
.hpi-pre[data-dim]{color:var(--dsw-alias-fg-muted,#9aa0aa)}
.hpi-file{display:flex;gap:8px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-subtle,#23262e);font:12px Consolas,Menlo,monospace}
.hpi-file .hpi-fn{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hpi-file .hpi-fs{color:var(--dsw-alias-fg-muted,#9aa0aa);white-space:nowrap}
.hpi-entry{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;background:none;border:none;color:inherit;cursor:pointer;font:inherit;text-align:left}
.hpi-entry:hover{background:var(--dsw-alias-bg-hover,#20242c)}
.hpi-entry[data-active]{background:var(--dsw-alias-bg-hover,#20242c)}
.hpi-entry .hpi-entry-label{font-size:13px}
.hpi-entry svg{flex:none}
.hpi-btn-primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
.hpi-btn-primary:hover{background:#2563eb;border-color:#2563eb}
.hpi-btn-stop{background:#7f1d1d;border-color:#991b1b;color:#fff}
.hpi-btn-stop:hover{background:#991b1b}
.hpi-run{display:none;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,#2a2e37);background:var(--dsw-alias-bg-elevated,#1b1f26)}
.hpi-run[data-on]{display:block}
.hpi-run-head{display:flex;align-items:center;gap:8px;font-size:12px}
.hpi-run-status{font-weight:600}
.hpi-run-status[data-s="running"]{color:#fbbf24}
.hpi-run-status[data-s="exited"]{color:#4ade80}
.hpi-run-status[data-s="error"]{color:#f87171}
.hpi-run-pre{margin:6px 0 0;padding:6px 8px;font:11.5px/1.5 Consolas,Menlo,monospace;color:#9fe8a0;white-space:pre-wrap;word-break:break-all;background:#101319;border-radius:6px;max-height:150px;overflow:auto}
.hpi-chip[data-k="diag"]{background:#7c2d12;color:#fdba74}
.hpi-diag{border:1px solid #7f1d1d;background:#331414;border-radius:8px;padding:10px 12px;margin-top:10px}
.hpi-diag-title{font-weight:700;font-size:13px;color:#f87171}
.hpi-diag-text{color:#fecaca;font-size:12.5px;margin-top:6px;white-space:pre-wrap;word-break:break-word}
.hpi-diag-ok{border-color:#14532d;background:#12251c}
.hpi-diag-ok .hpi-diag-title{color:#4ade80}
.hpi-diag-ok .hpi-diag-text{color:#bbf7d0}
.hpi-code{margin:0;padding:8px 10px;font:12px/1.55 Consolas,Menlo,monospace;color:#c9d1d9;white-space:pre-wrap;word-break:break-all;background:#101319;border:1px solid var(--dsw-alias-border-subtle,#2a2e37);border-radius:6px;max-height:420px;overflow:auto}
.hpi-code .hpi-hit{display:block;background:#4c1d1d;color:#fca5a5}
.hpi-srcpath{font:12px Consolas,Menlo,monospace;color:#93c5fd;margin-bottom:4px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
`

    function injectStyle() {
      if (typeof document === 'undefined' || document.getElementById('dsh-hanginsp-style') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-hanginsp-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function el(tag, cls, text) {
      const node = document.createElement(tag)
      if (cls) node.className = cls
      if (text !== undefined) node.textContent = text
      return node
    }

    async function apiFetch(path) {
      const r = await fetch(API + path)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    }

    async function apiDelete(path) {
      const r = await fetch(API + path, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    }

    async function apiPost(path, body) {
      const r = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!r.ok) {
        let msg = `HTTP ${r.status}`
        try {
          const d = await r.json()
          if (d && d.error) msg = d.error
        } catch {
          // keep status message
        }
        throw new Error(msg)
      }
      return r.json()
    }

    function fmtBytes(n) {
      if (!Number.isFinite(n) || n <= 0) return '0 B'
      if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
      if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
      if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'
      return n + ' B'
    }

    function fmtTime(ms) {
      const d = new Date(ms)
      const pad = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    function copyText(text, btn, label) {
      const done = () => {
        btn.textContent = '已复制'
        setTimeout(() => { btn.textContent = label }, 1500)
      }
      const legacy = () => {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        let ok = false
        try { ok = document.execCommand('copy') } catch { ok = false }
        document.body.removeChild(ta)
        if (ok) done()
      }
      if (navigator.clipboard !== undefined && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, legacy)
      } else {
        legacy()
      }
    }

    // ------------------------------------------------------------ sidebar entry

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

    const ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.5v6M8 1.5L5.5 4M8 1.5l2.5 2.5"/><path d="M2.5 7.5v5a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-5"/><path d="M4.5 9.5h7"/></svg>`

    function createEntry(toggle) {
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.dataset.dshHanginspEntry = ''
      entry.className = 'hpi-entry'
      entry.setAttribute('aria-label', '卡死分析')
      entry.innerHTML = `<span>${ICON}</span><span class="hpi-entry-label">卡死分析</span>`
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
            child.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-apiviz-entry], [data-dsh-postman-entry], [data-dsh-hanginsp-entry]'),
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

    function buildPanel() {
      const view = el('div')
      view.dataset.dshHanginspView = ''

      const toolbar = el('div', 'hpi-toolbar')
      toolbar.appendChild(el('span', 'hpi-title', '卡死分析'))
      const stats = el('span', 'hpi-stats', '')
      toolbar.appendChild(stats)
      const runBtn = el('button', 'hpi-btn hpi-btn-primary', '▶ 启动监测')
      toolbar.appendChild(runBtn)
      const refreshBtn = el('button', 'hpi-btn', '刷新')
      toolbar.appendChild(refreshBtn)
      const clearAllBtn = el('button', 'hpi-btn hpi-btn-danger', '清空全部')
      toolbar.appendChild(clearAllBtn)
      const closeBtn = el('button', 'hpi-btn hpi-close', '×')
      toolbar.appendChild(closeBtn)
      view.appendChild(toolbar)

      // 运行横幅：监测状态 + 实时日志尾部
      const runBanner = el('div', 'hpi-run')
      const runHead = el('div', 'hpi-run-head')
      const runStatus = el('span', 'hpi-run-status', '')
      const runHint = el('span', 'hpi-stats', '')
      runHead.appendChild(runStatus)
      runHead.appendChild(runHint)
      const runPre = el('pre', 'hpi-run-pre', '')
      runBanner.appendChild(runHead)
      runBanner.appendChild(runPre)
      view.appendChild(runBanner)

      const body = el('div', 'hpi-body')
      const listEl = el('div', 'hpi-list')
      const detailEl = el('div', 'hpi-detail')
      body.appendChild(listEl)
      body.appendChild(detailEl)
      view.appendChild(body)

      const state = { open: false, timer: null, items: [], selectedId: null, run: null, runTimer: null, analysisTimer: null, lastAnalysisJson: null }

      const renderList = () => {
        listEl.textContent = ''
        if (state.items.length === 0) {
          listEl.appendChild(el('div', 'hpi-empty', '暂无证据包\n点「启动监测」后客户端卡死会自动生成证据包'))
          return
        }
        for (const pack of state.items) {
          const btn = el('button', 'hpi-pack')
          if (pack.id === state.selectedId) btn.dataset.active = '1'
          btn.appendChild(el('div', 'hpi-pack-name', pack.id))
          if (pack.summaryFirst !== '') btn.appendChild(el('div', 'hpi-pack-line', pack.summaryFirst))
          if (pack.procInfo !== '') btn.appendChild(el('div', 'hpi-pack-line', pack.procInfo))
          const badges = el('div', 'hpi-pack-badges')
          const shotChip = el('span', 'hpi-chip', '截图')
          shotChip.dataset.k = 'shot'
          const dumpChip = el('span', 'hpi-chip', 'dump ' + fmtBytes(pack.dumpBytes))
          dumpChip.dataset.k = 'dump'
          if (pack.hasScreenshot) badges.appendChild(shotChip)
          if (pack.dumpBytes > 0) badges.appendChild(dumpChip)
          if (pack.analysisStatus === 'done') {
            const diagChip = el('span', 'hpi-chip', '已分析')
            diagChip.dataset.k = 'diag'
            badges.appendChild(diagChip)
          } else if (pack.analysisStatus === 'running') {
            const diagChip = el('span', 'hpi-chip', '分析中…')
            diagChip.dataset.k = 'diag'
            badges.appendChild(diagChip)
          }
          badges.appendChild(el('span', 'hpi-chip', fmtTime(pack.ts)))
          btn.appendChild(badges)
          btn.addEventListener('click', () => {
            state.selectedId = pack.id
            for (const child of listEl.children) {
              if (child.dataset.active === '1') delete child.dataset.active
            }
            btn.dataset.active = '1'
            select(pack.id)
          })
          listEl.appendChild(btn)
        }
      }

      const renderAnalysisResult = (sec, a) => {
        const card = el('div', 'hpi-diag')
        card.appendChild(el('div', 'hpi-diag-title', '疑似卡死原因'))
        card.appendChild(el('div', 'hpi-diag-text', String(a.diagnosis ?? '')))
        sec.appendChild(card)
        if (a.suspectThread !== null && a.suspectThread !== undefined) {
          sec.appendChild(
            el('div', 'hpi-diag-text', `卡死线程：托管 ID ${a.suspectThread.managedId} / OS 线程 ${a.suspectThread.osId}`),
          )
        }
        if (typeof a.stackText === 'string' && a.stackText !== '') {
          const det = document.createElement('details')
          const sum = document.createElement('summary')
          sum.textContent = '卡死线程托管栈'
          det.appendChild(sum)
          det.appendChild(el('pre', 'hpi-pre', a.stackText))
          sec.appendChild(det)
        }
        if (Array.isArray(a.threadsSummary) && a.threadsSummary.length > 0) {
          const det = document.createElement('details')
          const sum = document.createElement('summary')
          sum.textContent = `全部线程概览（${a.threadsSummary.length}）`
          det.appendChild(sum)
          const lines = a.threadsSummary
            .map((th) => `#${th.managedId}(OS ${th.osId}) 顶帧: ${th.top}${th.user !== null ? `  项目代码: ${th.user}` : ''}`)
            .join('\n')
          det.appendChild(el('pre', 'hpi-pre', lines))
          sec.appendChild(det)
        }
        if (a.source !== null && a.source !== undefined) {
          const s = a.source
          const box = el('div', 'hpi-sec')
          const title = el('div', 'hpi-sec-title')
          title.appendChild(el('span', 'hpi-t', '项目代码问题'))
          box.appendChild(title)
          const pathLine = el('div', 'hpi-srcpath')
          pathLine.appendChild(el('span', '', `${s.rel}  （第 ${s.suspectLine} 行）`))
          const copyBtn = el('button', 'hpi-btn', '复制路径')
          copyBtn.addEventListener('click', () => copyText(s.file, copyBtn, '复制路径'))
          pathLine.appendChild(copyBtn)
          box.appendChild(pathLine)
          const pre = el('pre', 'hpi-code')
          for (const line of String(s.code ?? '').split('\n')) {
            const m = /^(\d+): /.exec(line)
            const span = document.createElement('span')
            span.textContent = `${line}\n`
            span.style.display = 'block'
            if (m !== null && Number(m[1]) === s.suspectLine) span.className = 'hpi-hit'
            pre.appendChild(span)
          }
          box.appendChild(pre)
          sec.appendChild(box)
        } else {
          sec.appendChild(
            el('div', 'hpi-diag-text', '未能定位到项目源码（卡死点在系统/框架代码，或该类型已不在当前源码树中）。'),
          )
        }
      }

      const analyzeBtn = (handler) => {
        const b = el('button', 'hpi-btn hpi-btn-primary', '分析卡死原因')
        b.addEventListener('click', () => {
          b.disabled = true
          handler()
        })
        return b
      }

      const startAnalysis = (packId) => {
        apiPost(`/packs/${encodeURIComponent(packId)}/analyze`)
          .then(() => {
            if (state.selectedId === packId) select(packId)
          })
          .catch(() => {
            if (state.selectedId === packId) select(packId)
          })
      }

      const renderDetail = (pack) => {
        detailEl.textContent = ''
        const renderAnalysisAction = () => startAnalysis(pack.id)

        const dirLine = el('div', 'hpi-sec')
        const dirTitle = el('div', 'hpi-sec-title')
        dirTitle.appendChild(el('span', 'hpi-t', pack.id))
        const copyBtn = el('button', 'hpi-btn', '复制目录')
        copyBtn.addEventListener('click', () => copyText(pack.dir, copyBtn, '复制目录'))
        dirTitle.appendChild(copyBtn)
        const delBtn = el('button', 'hpi-btn hpi-btn-danger', '删除此包')
        delBtn.addEventListener('click', () => {
          if (!window.confirm(`确定删除证据包 ${pack.id}？文件将直接删除，不可恢复。`)) return
          delBtn.disabled = true
          apiDelete(`/packs/${encodeURIComponent(pack.id)}`)
            .then(() => {
              state.selectedId = null
              detailEl.textContent = ''
              refresh()
            })
            .catch((error) => {
              dirTitle.appendChild(el('span', 'hpi-hint', `删除失败: ${error instanceof Error ? error.message : String(error)}`))
            })
            .finally(() => {
              delBtn.disabled = false
            })
        })
        dirTitle.appendChild(delBtn)
        dirLine.appendChild(dirTitle)
        const dirPre = el('pre', 'hpi-pre hpi-pre[data-dim]', pack.dir)
        dirPre.dataset.dim = '1'
        dirLine.appendChild(dirPre)
        detailEl.appendChild(dirLine)

        // ---- 自动分析结果（诊断 + 项目代码问题） ----
        const analysis = pack.analysis ?? null
        const analysisSec = el('div', 'hpi-sec')
        const aTitle = el('div', 'hpi-sec-title')
        aTitle.appendChild(el('span', 'hpi-t', '卡死原因分析'))
        analysisSec.appendChild(aTitle)
        if (analysis === null || analysis.status === 'none') {
          const hint = el('div', 'hpi-empty', '')
          if (pack.dumpBytes > 0) {
            hint.textContent = '该证据包含完整 dump，可自动分析托管线程栈定位卡死代码。'
            aTitle.appendChild(analyzeBtn(renderAnalysisAction))
          } else {
            hint.textContent = '该证据包没有 frozen.dmp，无法做堆栈分析。'
          }
          analysisSec.appendChild(hint)
        } else if (analysis.status === 'running') {
          const secs = Math.max(0, Math.round((Date.now() - (analysis.startedAt ?? Date.now())) / 1000))
          aTitle.appendChild(el('span', 'hpi-hint', `分析中…（已 ${secs} 秒，解析大 dump 需要一点时间）`))
        } else if (analysis.status === 'error') {
          const err = el('div', 'hpi-diag')
          err.appendChild(el('div', 'hpi-diag-title', '分析失败'))
          err.appendChild(el('div', 'hpi-diag-text', String(analysis.error ?? '未知错误')))
          analysisSec.appendChild(err)
          aTitle.appendChild(analyzeBtn(renderAnalysisAction))
        } else {
          renderAnalysisResult(analysisSec, analysis)
        }
        detailEl.appendChild(analysisSec)

        if (pack.hasScreenshot) {
          const sec = el('div', 'hpi-sec')
          const title = el('div', 'hpi-sec-title')
          title.appendChild(el('span', 'hpi-t', '冻结截图'))
          title.appendChild(el('span', 'hpi-hint', 'frozen-screen.png'))
          sec.appendChild(title)
          const img = document.createElement('img')
          img.className = 'hpi-img'
          img.alt = '冻结截图'
          img.src = `${API}/packs/${encodeURIComponent(pack.id)}/screenshot`
          img.addEventListener('error', () => {
            img.remove()
            sec.appendChild(el('pre', 'hpi-pre', '截图加载失败'))
          })
          sec.appendChild(img)
          detailEl.appendChild(sec)
        }

        const sections = [
          ['概要 / 时间线', 'summary', null],
          ['进程信息', 'processInfo', null],
          ['net-trace 尾部', 'traceTail', null],
          ['进程内探针输出', 'echo', 'ui-probe-echo.txt'],
          ['procdump 输出', 'procdumpOut', 'procdump.out.txt'],
        ]
        for (const [title, key, hint] of sections) {
          const text = pack.texts[key]
          if (text === null || text === '') continue
          const sec = el('div', 'hpi-sec')
          const t = el('div', 'hpi-sec-title')
          t.appendChild(el('span', 'hpi-t', title))
          if (hint !== null) t.appendChild(el('span', 'hpi-hint', hint))
          sec.appendChild(t)
          sec.appendChild(el('pre', 'hpi-pre', text))
          detailEl.appendChild(sec)
        }

        const filesSec = el('div', 'hpi-sec')
        const ft = el('div', 'hpi-sec-title')
        ft.appendChild(el('span', 'hpi-t', '文件清单'))
        if (pack.dumpBytes > 0) ft.appendChild(el('span', 'hpi-hint', 'frozen.dmp 用 Visual Studio「打开文件」看托管调用栈'))
        filesSec.appendChild(ft)
        const sorted = [...pack.files].sort((a, b) => b.bytes - a.bytes)
        for (const f of sorted) {
          const row = el('div', 'hpi-file')
          row.appendChild(el('span', 'hpi-fn', f.name))
          row.appendChild(el('span', 'hpi-fs', fmtBytes(f.bytes)))
          filesSec.appendChild(row)
        }
        detailEl.appendChild(filesSec)
      }

      const select = (id) => {
        apiFetch(`/packs/${encodeURIComponent(id)}`)
          .then((pack) => {
            state.lastAnalysisJson = pack.analysis === null || pack.analysis === undefined ? 'none' : JSON.stringify(pack.analysis)
            renderDetail(pack)
            const a = pack.analysis
            if (pack.dumpBytes > 0 && (a === null || a === undefined || a.status === 'none')) {
              startAnalysis(id)
            }
          })
          .catch((error) => {
            detailEl.textContent = ''
            detailEl.appendChild(el('div', 'hpi-empty', `加载失败: ${error instanceof Error ? error.message : String(error)}`))
          })
      }

      const refresh = async () => {
        try {
          const data = await apiFetch('/packs')
          state.items = data.items
          stats.textContent = `共 ${data.total} 个证据包`
          renderList()
          if (state.selectedId === null && data.items.length > 0) {
            state.selectedId = data.items[0].id
            const first = listEl.querySelector('.hpi-pack')
            if (first !== null) first.dataset.active = '1'
            select(state.selectedId)
          } else if (state.selectedId !== null && state.items.some((p) => p.id === state.selectedId)) {
            // 静默刷新选中包的分析状态（分析完成/失败时重渲染详情）
            apiFetch(`/packs/${encodeURIComponent(state.selectedId)}`)
              .then((pack) => {
                const j = pack.analysis === null || pack.analysis === undefined ? 'none' : JSON.stringify(pack.analysis)
                if (j !== state.lastAnalysisJson) {
                  state.lastAnalysisJson = j
                  renderDetail(pack)
                }
              })
              .catch(() => {
                // selected pack may be deleted meanwhile
              })
          }
        } catch (error) {
          stats.textContent = `加载失败: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      const scheduleNext = () => {
        state.timer = setTimeout(() => {
          refresh().finally(scheduleNext)
        }, POLL_MS)
      }

      // ---- 监测运行状态 ----

      const refreshRun = async () => {
        let r
        try {
          r = await apiFetch('/run')
        } catch (error) {
          runStatus.textContent = `运行状态获取失败: ${error instanceof Error ? error.message : String(error)}`
          return
        }
        state.run = r
        const st = r.status ?? 'idle'
        const textMap = {
          idle: '未运行',
          running: '监测运行中…',
          stopping: '正在停止…',
          exited: `监测已结束（exit ${r.exitCode ?? '?'}）`,
          error: `监测出错: ${r.error ?? ''}`,
        }
        runStatus.textContent = textMap[st] ?? st
        runStatus.dataset.s = st === 'running' || st === 'stopping' ? 'running' : st
        runHint.textContent = r.pid !== undefined ? `pid ${r.pid}${r.startedAt !== undefined ? ' · ' + fmtTime(r.startedAt) : ''}` : ''
        runPre.textContent = r.logTail ?? ''
        if (r.logTail) runPre.scrollTop = runPre.scrollHeight
        runBanner.dataset.on = st === 'idle' ? '' : '1'
        runBtn.textContent = st === 'running' || st === 'stopping' ? '■ 停止监测' : '▶ 启动监测'
        runBtn.className = st === 'running' || st === 'stopping' ? 'hpi-btn hpi-btn-stop' : 'hpi-btn hpi-btn-primary'
      }

      const pollRun = () => {
        if (!state.open) {
          state.runTimer = null
          return
        }
        refreshRun().finally(() => {
          if (state.open) state.runTimer = setTimeout(pollRun, RUN_POLL_MS)
        })
      }

      const setOpen = (open) => {
        state.open = open
        if (open) {
          // exclusive with sibling panels
          delete document.documentElement.dataset.dshTaskboardActive
          delete document.documentElement.dataset.dshSshActive
          delete document.documentElement.dataset.dshApivizActive
          delete document.documentElement.dataset.dshPostmanActive
          document.documentElement.dataset.dshHanginspActive = 'true'
          refresh().finally(scheduleNext)
          refreshRun().finally(() => {
            if (state.open) state.runTimer = setTimeout(pollRun, RUN_POLL_MS)
          })
        } else {
          document.documentElement.removeAttribute('data-dsh-hanginsp-active')
          if (state.timer !== null) {
            clearTimeout(state.timer)
            state.timer = null
          }
          if (state.runTimer !== null) {
            clearTimeout(state.runTimer)
            state.runTimer = null
          }
        }
      }
      const toggle = () => setOpen(!state.open)

      runBtn.addEventListener('click', () => {
        if (runBtn.textContent.includes('停止')) {
          runBtn.disabled = true
          apiPost('/run/stop')
            .then(() => refreshRun())
            .catch((error) => {
              runHint.textContent = `停止失败: ${error instanceof Error ? error.message : String(error)}`
            })
            .finally(() => {
              runBtn.disabled = false
            })
          return
        }
        runBtn.disabled = true
        apiPost('/run', {})
          .then(() => refreshRun())
          .catch((error) => {
            runStatus.textContent = `启动失败: ${error instanceof Error ? error.message : String(error)}`
            runStatus.dataset.s = 'error'
            runBanner.dataset.on = '1'
          })
          .finally(() => {
            runBtn.disabled = false
          })
      })

      closeBtn.addEventListener('click', () => setOpen(false))
      refreshBtn.addEventListener('click', refresh)
      clearAllBtn.addEventListener('click', () => {
        if (!window.confirm('确定清空全部证据包？文件将直接删除，不可恢复。')) return
        clearAllBtn.disabled = true
        apiDelete('/packs')
          .then((d) => {
            state.selectedId = null
            detailEl.textContent = ''
            stats.textContent = `已清空 ${d.deleted} 个证据包`
            refresh()
          })
          .catch((error) => {
            stats.textContent = `清空失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            clearAllBtn.disabled = false
          })
      })
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.open) setOpen(false)
      })

      return { view, toggle }
    }

    // ------------------------------------------------------------------ apply

    let applied = false

    /**
     * Mount the sidebar entry and panel.
     * @param ctx - client root context (unused; the plugin talks to the host
     * via plain same-origin fetch).
     */
    function apply(ctx) {
      if (applied) return
      applied = true
      try {
        injectStyle()
        const { view, toggle } = buildPanel()
        const disposers = []
        try {
          disposers.push(mountSidebarEntry(toggle))
          const column = centerColumn()
          column.appendChild(view)
          disposers.push(() => view.remove())
        } catch (error) {
          console.error('[dsh-hang-inspector] mount failed:', error)
        }
        ctx.effect(() => () => { for (const dispose of disposers.splice(0)) dispose() }, 'dsh-hang-inspector: teardown')
      } catch (error) {
        // never take the GUI down
        console.error('[dsh-hang-inspector] apply failed:', error)
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
