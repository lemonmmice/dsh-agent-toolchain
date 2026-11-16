/**
 * dsh-api-visualizer — client half (browser bundle, hand-built for the
 * __ModuleLoader__ format; no build step).
 *
 * Mounts the 「接口捕获」 sidebar entry and a live panel in the center
 * column: stats chips, filters (keyword / method / status / source), a
 * records table, and a JSON detail drawer. Data comes from the host's
 * /api/dsh-api-visualizer route family via plain same-origin fetch; the
 * panel polls every 2.5s while open. Plain DOM everywhere (no React), so
 * the bundle only depends on the module loader's built-in globals.
 */
window.__ModuleLoader__.load({
  id: '@dsh-agent-toolchain/dsh-api-visualizer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const API = '/api/dsh-api-visualizer'
    const ENTRY_SEL = '[data-dsh-apiviz-entry]'
    const VIEW_SEL = '[data-dsh-apiviz-view]'
    const POLL_MS = 2500
    const POLL_LIVE_MS = 1000
    const LIMIT = 300
    let liveDot = null

    const CSS = `
[data-dsh-apiviz-view]{position:absolute;inset:0;z-index:60;display:none;flex-direction:column;
background:var(--dsw-alias-bg-base,#171a21);color:var(--dsw-alias-label-primary);font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
html[data-dsh-apiviz-active] [data-dsh-apiviz-view]{display:flex}
.apv-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.apv-title{font-weight:600;font-size:14px;margin-right:4px}
.apv-stats{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.apv-statchip{cursor:pointer;border-radius:4px;padding:0 4px}
.apv-statchip:hover{background:var(--dsw-alias-interactive-bg-hover);text-decoration:underline}
.apv-statchip-on{background:var(--dsw-static-deepseek-100);color:var(--dsw-static-deepseek-700)}
body[data-ds-dark-theme] .apv-statchip-on{background:#1e2a44;color:#93c5fd}
.apv-q{flex:1 1 180px;min-width:120px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:inherit;border-radius:6px;padding:4px 8px;font:inherit}
.apv-select{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:inherit;border-radius:6px;padding:4px 6px;font:inherit}
.apv-client-sel{max-width:240px;font-weight:600}
.apv-btn{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:inherit;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}
.apv-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-btn-danger:hover{border-color:#c0392b;color:#e74c3c}
.apv-close{margin-left:auto;font-size:16px;line-height:1;padding:4px 8px}
.apv-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;position:relative}
.apv-table-wrap{flex:1;min-height:0;overflow:auto}
.apv-table{min-width:100%;border-collapse:collapse;white-space:nowrap}
.apv-table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);text-align:left;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);z-index:1}
.apv-table td{padding:5px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top;max-width:520px;overflow:hidden;text-overflow:ellipsis}
.apv-caller{color:var(--dsw-static-neutral-bluish-700);font-size:12px}
body[data-ds-dark-theme] .apv-caller{color:#c4a7f0}
.apv-table tbody tr{cursor:pointer}
.apv-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-table tbody tr.apv-selected{background:var(--dsw-static-deepseek-100)}
.apv-table tbody tr.apv-selected:hover{background:var(--dsw-static-deepseek-100)}
body[data-ds-dark-theme] .apv-table tbody tr.apv-selected{background:#1e2a44}
body[data-ds-dark-theme] .apv-table tbody tr.apv-selected:hover{background:#1e2a44}
.apv-table tbody tr.apv-selected td:first-child{box-shadow:inset 2px 0 0 #60a5fa}
.apv-empty{text-align:center;color:var(--dsw-alias-label-tertiary);padding:40px 0}
.apv-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:11px;font-weight:600}
.apv-m-get{background:var(--dsw-static-green-100);color:var(--dsw-static-green-900)}.apv-m-post{background:var(--dsw-static-blue-100);color:var(--dsw-static-blue-900)}.apv-m-put{background:var(--dsw-static-amber-100);color:var(--dsw-static-amber-900)}
body[data-ds-dark-theme] .apv-m-get{background:#1b4d3a;color:#4ade80}body[data-ds-dark-theme] .apv-m-post{background:#1e3a5f;color:#60a5fa}body[data-ds-dark-theme] .apv-m-put{background:#4a3b14;color:#fbbf24}
.apv-m-delete{background:var(--dsw-static-red-100);color:var(--dsw-static-red-900)}.apv-m-other{background:var(--dsw-static-neutral-bluish-100);color:var(--dsw-static-neutral-bluish-700)}
body[data-ds-dark-theme] .apv-m-delete{background:#4c1d1d;color:#f87171}body[data-ds-dark-theme] .apv-m-other{background:#33363f;color:#cbd5e1}
.apv-s-2{background:var(--dsw-static-green-100);color:var(--dsw-static-green-900)}.apv-s-3{background:var(--dsw-static-blue-100);color:var(--dsw-static-blue-900)}.apv-s-4{background:var(--dsw-static-amber-100);color:var(--dsw-static-amber-900)}
body[data-ds-dark-theme] .apv-s-2{background:#1b4d3a;color:#4ade80}body[data-ds-dark-theme] .apv-s-3{background:#1e3a5f;color:#60a5fa}body[data-ds-dark-theme] .apv-s-4{background:#4a3b14;color:#fbbf24}
.apv-s-5{background:var(--dsw-static-red-100);color:var(--dsw-static-red-900)}.apv-s-0{background:var(--dsw-static-neutral-bluish-100);color:var(--dsw-static-neutral-bluish-700)}
body[data-ds-dark-theme] .apv-s-5{background:#4c1d1d;color:#f87171}body[data-ds-dark-theme] .apv-s-0{background:#33363f;color:#cbd5e1}
.apv-note{color:var(--dsw-alias-label-tertiary);font-size:12px}
.apv-difftable{border-collapse:collapse;width:100%;table-layout:fixed;font:12px/1.5 ui-monospace,Consolas,monospace}
.apv-difftable td{width:50%;vertical-align:top;white-space:pre-wrap;word-break:break-all;padding:0 6px;border-left:1px solid var(--dsw-alias-border-l2)}
.apv-diff-del{background:rgba(231,76,60,.18)}
.apv-diff-ins{background:rgba(46,204,113,.18)}
.apv-diff-blank{background:var(--dsw-alias-bg-layer-2)}
.apv-bp-paused{padding:4px 8px;overflow:auto}
.apv-bp-card{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-2)}
.apv-bp-btns{display:flex;gap:8px;margin-top:6px}
.apv-detail{display:flex;flex:0 0 var(--apv-detail-height,42%);flex-direction:column;height:var(--apv-detail-height,42%);min-height:120px;max-height:85%;overflow:hidden;border-top:1px solid var(--dsw-alias-border-l2)}
.apv-detail[hidden]{display:none}
.apv-detail-resize{height:8px;flex:0 0 8px;cursor:ns-resize;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l2);position:relative;touch-action:none;z-index:2}
.apv-detail-resize::after{content:"";position:absolute;left:50%;top:3px;width:42px;height:2px;transform:translateX(-50%);border-radius:2px;background:var(--dsw-alias-label-tertiary);opacity:.75}
.apv-detail-resize:hover,.apv-detail-resize:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.apv-detail-resize:hover::after,.apv-detail-resize:focus-visible::after{background:var(--dsw-static-deepseek-500);opacity:1}
.apv-detail-head{display:flex;align-items:center;gap:8px;padding:6px 12px;background:var(--dsw-alias-bg-layer-2)}
.apv-detail-head .apv-durl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}
.apv-detail pre{flex:1;overflow:auto;margin:0;padding:10px 12px;font:12px/1.5 Consolas,Menlo,monospace;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-all}
.apv-entry{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;background:none;border:none;color:inherit;cursor:pointer;font:inherit;text-align:left}
.apv-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-entry[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.apv-entry .apv-entry-label{font-size:13px}
.apv-entry svg{flex:none}
.apv-live-dot{width:8px;height:8px;border-radius:50%;background:#3a3f4a;flex:none;margin-left:auto}
.apv-live-dot[data-on="1"]{background:#2ecc71;box-shadow:0 0 6px #2ecc71;animation:apv-pulse 1.6s infinite}
@keyframes apv-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.apv-live-on{color:#2ecc71}
.apv-capture-on{border-color:#2ecc71;color:#2ecc71}
.apv-autoscroll{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;cursor:pointer}
.apv-sep{color:var(--dsw-alias-border-l2)}
.apv-port{width:64px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:inherit;border-radius:6px;padding:4px 6px;font:inherit}
.apv-btn-danger:hover{border-color:#c0392b;color:#e74c3c}
.apv-btn-on{border-color:#2ecc71;color:#2ecc71}
.apv-star{background:none;border:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:15px;padding:0 4px;line-height:1}
.apv-star[data-on="1"]{color:#fbbf24}
.apv-detail-bar{display:flex;align-items:center;gap:8px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.apv-detail-bar .apv-in{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:inherit;border-radius:6px;padding:4px 8px;font:inherit}
.apv-detail-bar .apv-in-note{flex:1 1 160px;min-width:120px}
.apv-detail-bar .apv-in-tag{width:110px}
.apv-detail-main{flex:1;min-height:0;display:flex;flex-direction:row;align-items:stretch}
.apv-detail-body{flex:1;min-width:0;min-height:0;overflow:auto;padding:0 12px 12px}
.apv-sortpane{flex:0 0 var(--apv-sort-width,42%);min-width:240px;max-width:calc(100% - 208px);display:flex;flex-direction:column;min-height:0}
.apv-sortpane[hidden]{display:none}
.apv-sort-resize{flex:0 0 8px;width:8px;box-sizing:border-box;cursor:ew-resize;background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l2);position:relative;touch-action:none;z-index:2}
.apv-sort-resize[hidden]{display:none}
.apv-sort-resize::after{content:"";position:absolute;top:50%;left:2px;width:2px;height:42px;transform:translateY(-50%);border-radius:2px;background:var(--dsw-alias-label-tertiary);opacity:.75}
.apv-sort-resize:hover,.apv-sort-resize:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.apv-sort-resize:hover::after,.apv-sort-resize:focus-visible::after{background:var(--dsw-static-deepseek-500);opacity:1}
.apv-sort-head{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.7}
.apv-sort-head .apv-t{font-weight:600;color:var(--dsw-alias-label-primary);font-size:13px}
.apv-sort-scroll{flex:1;min-height:0;overflow:auto}
.apv-sort-table{min-width:100%;border-collapse:collapse;white-space:nowrap;font-variant-numeric:tabular-nums}
.apv-sort-table th{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-layer-2);text-align:right;padding:5px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2)}
.apv-sort-table th[data-key]{font-weight:600;color:var(--dsw-alias-label-primary)}
.apv-sort-table td{padding:4px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;text-align:right}
.apv-sort-table th.apv-sort-name,.apv-sort-table td.apv-sort-name,.apv-sort-table th.apv-sort-txt,.apv-sort-table td.apv-sort-txt{text-align:left}
.apv-sort-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-sort-table td.apv-sort-rank{color:var(--dsw-alias-label-tertiary)}
.apv-sort-table td.apv-sort-key{font-weight:600;color:var(--dsw-alias-label-primary)}
.apv-sort-table td.apv-sort-dim{color:var(--dsw-alias-label-tertiary)}
.apv-sort-table .apv-sort-pin{position:sticky;left:0;z-index:1;background:var(--dsw-alias-bg-base,#171a21)}
.apv-sort-table th.apv-sort-pin{z-index:3;background:var(--dsw-alias-bg-layer-2)}
.apv-sort-table .apv-sort-name.apv-sort-pin{left:var(--apv-sort-pin-left,0px)}
.apv-sort-table .apv-sort-pin-last{box-shadow:inset -1px 0 0 var(--dsw-alias-border-l2)}
.apv-sort-table tbody tr:hover td.apv-sort-pin{background:linear-gradient(var(--dsw-alias-interactive-bg-hover),var(--dsw-alias-interactive-bg-hover)),var(--dsw-alias-bg-base,#171a21)}
.apv-sort-tag{margin-left:6px;padding:0 5px;border-radius:4px;background:var(--dsw-static-amber-100);color:var(--dsw-static-amber-900);font-size:11px}
body[data-ds-dark-theme] .apv-sort-tag{background:#7c5c00;color:#fff}
.apv-sec{margin-top:10px}
.apv-sec-title{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
.apv-sec-title .apv-t{font-weight:600}
.apv-sec-pre{margin:0;padding:8px 10px;font:12px/1.5 Consolas,Menlo,monospace;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:normal;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-2);border-radius:6px;max-height:340px;overflow:auto}
.apv-sec-body{background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px 10px;max-height:340px;overflow:auto}
.apv-fold{cursor:pointer;color:#fbbf24;border-bottom:1px dashed currentColor}
.apv-fold:hover{background:#4a3b14}
.apv-sec-title-fold{cursor:pointer;user-select:none}
.apv-sec-title-fold:hover .apv-t{color:var(--dsw-static-deepseek-500)}
.apv-fold-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.apv-viewbtns{display:flex;gap:4px;margin-left:auto}
.apv-viewbtns .apv-btn{padding:2px 8px;font-size:11px}
[data-apv-back-entry]{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;white-space:nowrap}
[data-apv-back-entry]:hover{color:var(--dsw-static-deepseek-500);border-color:var(--dsw-static-deepseek-500)}
.apv-jt{font:12px/1.6 Consolas,Menlo,monospace}
.apv-jt-row{white-space:pre}
.apv-jt-toggle{cursor:pointer;user-select:none}
.apv-jt-toggle:hover{color:var(--dsw-static-deepseek-500)}
.apv-jt-collapsed::after{content:' …';color:var(--dsw-alias-label-tertiary)}
.apv-jt-brace{color:var(--dsw-alias-label-tertiary)}
.apv-jt-key{color:var(--dsw-static-deepseek-500)}
.apv-jt-idx{color:var(--dsw-alias-label-tertiary)}
.apv-jt-str{color:var(--dsw-static-green-900)}
body[data-ds-dark-theme] .apv-jt-str{color:#9fe8a0}
.apv-jt-num{color:var(--dsw-static-amber-900)}
body[data-ds-dark-theme] .apv-jt-num{color:#fbbf24}
.apv-jt-bool,.apv-jt-null{color:var(--dsw-static-neutral-bluish-700)}
body[data-ds-dark-theme] .apv-jt-bool,.apv-jt-null{color:#c4a7f0}
.apv-jt-kids{border-left:1px solid var(--dsw-alias-border-l2);margin-left:8px;padding-left:8px}
.apv-mark{background:var(--dsw-static-amber-100);color:var(--dsw-static-amber-900);border-radius:2px;padding:0 1px}
body[data-ds-dark-theme] .apv-mark{background:#7c5c00;color:#fff}
.apv-img{max-width:100%;max-height:320px;border-radius:6px;display:block}
.apv-iframe{width:100%;height:320px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:#fff}
.apv-filterbar{display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.apv-filterbar[hidden]{display:none}
.apv-frow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.apv-fin{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:inherit;border-radius:6px;padding:4px 8px;font:inherit}
.apv-fin-host{width:150px}.apv-fin-ct{width:150px}.apv-fin-dur{width:90px}.apv-fin-body{flex:1 1 160px;min-width:120px}
.apv-fcb{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;cursor:pointer}
.apv-agg{padding:8px 12px;overflow:auto}
.apv-agg[hidden]{display:none}
.apv-timeline-summary{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:4px 0 10px}
.apv-timeline-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.apv-timeline-help{flex:1 1 420px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.apv-timeline-table{min-width:980px}
.apv-timeline-table td,.apv-timeline-table th{font-variant-numeric:tabular-nums}
.apv-timeline-table tbody tr{cursor:default}
.apv-timeline-table .apv-timeline-range{color:var(--dsw-alias-label-primary);font-weight:600}
.apv-timeline-table .apv-timeline-muted{color:var(--dsw-alias-label-tertiary)}
.apv-timeline-table .apv-timeline-error{color:#f87171}
.apv-timeline-table .apv-timeline-tail{color:#fbbf24}
.apv-wf{display:flex;flex-direction:column;gap:2px}
.apv-wf-row{display:flex;align-items:center;gap:8px;padding:2px 0}
.apv-wf-meta{flex:0 0 320px;min-width:320px;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.apv-wf-track{flex:1;position:relative;height:14px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;overflow:hidden}
.apv-wf-bar{position:absolute;top:1px;height:12px;min-width:2px;border-radius:3px;background:#2f6f8f;cursor:pointer;overflow:hidden;display:flex}
.apv-wf-bar:hover{background:#3d87ad}
.apv-wf-ttfb{height:100%;background:#4a6a1f;flex:none}
.apv-wf-legend{display:flex;gap:14px;align-items:center;padding:4px 0 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.apv-wf-legend i{display:inline-block;width:26px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.apv-wf-total{background:#2f6f8f}.apv-wf-wait{background:#4a6a1f}
/* P1-5 域名/路径树：行的缩进由 inline padding-left 给（18 个域 × 深层路径段），不依赖嵌套容器 */
.apv-tree{padding:8px 12px 14px}
.apv-tree-head{display:flex;align-items:baseline;gap:10px;padding:2px 0 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.apv-tree-head b{color:var(--dsw-alias-label-primary)}
.apv-tree-head .apv-tree-actions{margin-left:auto;display:flex;gap:6px}
.apv-tree-node{margin-left:-2px}
.apv-tree-branch{display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;cursor:pointer;user-select:none}
.apv-tree-branch:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-tree-caret{width:12px;flex:none;color:var(--dsw-alias-label-tertiary)}
.apv-tree-label{font-weight:600}
.apv-tree-branch[data-kind="path"] .apv-tree-label{font-weight:400}
.apv-tree-note{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}
.apv-tree-node[data-depth="0"] .apv-tree-branch{background:var(--dsw-alias-bg-layer-2)}
.apv-tree-node[data-depth="0"] .apv-tree-branch:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-tree-leaf{display:flex;align-items:center;gap:8px;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:12px}
.apv-tree-leaf:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-tree-leaf.apv-selected{background:var(--dsw-static-deepseek-100)}
body[data-ds-dark-theme] .apv-tree-leaf.apv-selected{background:#1e2a44}
.apv-tree-leaf .apv-badge{flex:none}
.apv-tree-path{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px Consolas,Menlo,monospace}
.apv-tree-meta{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.apv-src-hit{display:flex;align-items:center;gap:8px;padding:3px 8px;border-radius:6px}
.apv-src-hit:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-src-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px Consolas,Menlo,monospace;color:#8ec5ff}
.apv-rules-table td,.apv-rules-table th{font-size:12px}
.apv-rules-form{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 0}
.apv-rules-form .apv-fin{flex:none}
.apv-rule-body{width:220px;height:44px;resize:vertical}
.apv-ic-btns{display:flex;flex-direction:column;gap:4px;align-self:flex-start}
.apv-ic-suggest{display:flex;flex-wrap:wrap;gap:4px 10px;padding:2px 0 6px}
.apv-ic-suggest label{font-size:12px;white-space:nowrap;cursor:pointer}
.apv-ic-suggest .apv-ic-client{font-weight:600}
.apv-ic-status{font-size:12px}
.apv-ic-status table{border-collapse:collapse;margin:4px 0}
.apv-ic-status td,.apv-ic-status th{padding:2px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);text-align:left;font:12px Consolas,Menlo,monospace}
.apv-ic-action{font-size:12px;padding:0 0 4px;white-space:pre-wrap}
.apv-ic-action:empty{display:none}
.apv-bp-err{font-size:12px;margin-top:6px;white-space:pre-wrap}
.apv-bp-err:empty{display:none}
.apv-warn{color:#d97706}
body[data-ds-dark-theme] .apv-warn{color:#fbbf24}
.apv-ok{color:#16a34a}
body[data-ds-dark-theme] .apv-ok{color:#4ade80}
.apv-mock-hint{font-size:12px;margin-left:4px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 过滤器（Fiddler 式自定义过滤器）：工具栏按钮 + 提示条 + 对话框 */
.apv-fgroup{display:inline-flex;align-items:stretch}
.apv-fbtn{display:inline-flex;align-items:center;gap:5px;max-width:280px}
.apv-fbtn svg{flex:none}
.apv-fbtn-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apv-fgroup-on .apv-btn{border-color:#3b82f6;color:#1d4ed8;background:var(--dsw-static-deepseek-100,#dbeafe)}
body[data-ds-dark-theme] .apv-fgroup-on .apv-btn{color:#93c5fd;background:#1e2a44;border-color:#3b82f6}
.apv-fgroup-on .apv-fbtn{border-top-right-radius:0;border-bottom-right-radius:0}
.apv-fbtn-x{border-top-left-radius:0;border-bottom-left-radius:0;border-left-width:0;padding:4px 8px}
.apv-fbtn-x[hidden]{display:none}
.apv-statfilter{color:#2563eb}
body[data-ds-dark-theme] .apv-statfilter{color:#93c5fd}
.apv-statfilter.apv-warn{color:#d97706}
body[data-ds-dark-theme] .apv-statfilter.apv-warn{color:#fbbf24}
.apv-notice{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;flex-wrap:wrap}
.apv-notice[hidden]{display:none}
.apv-notice-text{flex:1 1 320px;min-width:180px;white-space:pre-wrap;overflow-wrap:anywhere}
.apv-notice .apv-btn{padding:2px 8px;font-size:12px}
.apv-aiopt[hidden]{display:none}
.apv-ailimit{width:72px}
.apv-dproc{padding:8px 0 0;font-size:12px}
.apv-dproc .apv-t{font-weight:600;color:var(--dsw-alias-label-tertiary);margin-right:2px}
.apv-rules-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 0 6px}
.apv-rules-head .apv-t{font-weight:600}
.apv-rules-choice{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}
.apv-rules-choice[hidden]{display:none}
.apv-rules-help{white-space:pre-wrap}
.apv-fd-overlay{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.45);container-type:inline-size;container-name:apvfd}
.apv-fd-overlay[hidden]{display:none}
.apv-fd{display:flex;flex-direction:column;width:min(900px,100%);height:min(560px,100%);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#1d212b));color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.4);overflow:hidden;outline:none}
.apv-fd-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.apv-fd-title{font-weight:600;font-size:14px;white-space:nowrap}
.apv-fd-hostnote{flex:1;min-width:0;font-size:12px}
.apv-fd-x{margin-left:auto;padding:2px 8px;font-size:16px;line-height:1}
.apv-fd-main{flex:1;min-height:0;display:flex}
.apv-fd-side{flex:0 0 220px;min-width:0;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.apv-fd-list{flex:1;min-height:0;overflow:auto;padding:6px}
.apv-fd-item{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px;border:none;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.apv-fd-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.apv-fd-item[aria-selected="true"]{background:var(--dsw-static-deepseek-100,#dbeafe)}
body[data-ds-dark-theme] .apv-fd-item[aria-selected="true"]{background:#1e2a44}
.apv-fd-item-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apv-fd-item-default .apv-fd-item-name{color:var(--dsw-alias-label-tertiary)}
.apv-fd-mark{flex:none;width:14px;text-align:center;font-size:12px;font-weight:700}
.apv-fd-check{color:#16a34a}
body[data-ds-dark-theme] .apv-fd-check{color:#4ade80}
.apv-fd-dirty{color:#d97706}
body[data-ds-dark-theme] .apv-fd-dirty{color:#fbbf24}
.apv-fd-side-btns{display:flex;gap:6px;padding:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.apv-fd-side-btns .apv-btn{flex:1 1 0;padding:4px 6px;min-width:0}
.apv-fd-import{display:flex;flex-direction:column;gap:6px;padding:0 8px 8px;font-size:12px}
.apv-fd-import[hidden]{display:none}
.apv-fd-import .apv-btn{padding:3px 8px;font-size:12px;text-align:left}
.apv-fd-edit{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.apv-fd-namerow{display:flex;align-items:center;gap:6px;padding:10px 14px 6px;flex-wrap:wrap}
.apv-fd-namerow label{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.apv-fd-name{flex:1 1 200px;min-width:120px}
.apv-fd-name.apv-fd-bad{border-color:#dc2626}
.apv-fd-icon{display:inline-flex;align-items:center;justify-content:center;width:30px;height:28px;padding:0}
.apv-fd .apv-btn:disabled{opacity:.42;cursor:default}
.apv-fd-msg{padding:0 14px 4px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}
.apv-fd-msg:empty{display:none}
.apv-fd-confirm{display:flex;align-items:center;gap:8px;margin:2px 14px 6px;padding:6px 10px;border:1px solid #dc2626;border-radius:6px;font-size:12px;flex-wrap:wrap}
.apv-fd-confirm[hidden]{display:none}
.apv-fd-moderow{display:flex;align-items:center;gap:6px;padding:4px 14px 6px;flex-wrap:wrap}
.apv-fd-spacer{flex:1}
.apv-fd-conds{flex:1;min-height:0;overflow:auto;padding:2px 14px 10px;display:flex;flex-direction:column;gap:6px}
.apv-fd-cond{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-2)}
.apv-fd-cond-off .apv-fd-cond-main>:not(.apv-fd-cond-on):not(.apv-fd-cdel){opacity:.5}
.apv-fd-cond-bad{border-color:#dc2626;background:rgba(220,38,38,.08)}
body[data-ds-dark-theme] .apv-fd-cond-bad{border-color:#f87171;background:rgba(248,113,113,.1)}
.apv-fd-cond-todo .apv-fd-value{border-style:dashed;border-color:#d97706}
body[data-ds-dark-theme] .apv-fd-cond-todo .apv-fd-value{border-color:#fbbf24}
.apv-fd-cond-main{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.apv-fd-field{width:118px}
.apv-fd-op{width:110px}
.apv-fd-header{width:120px}
.apv-fd-header[hidden]{display:none}
.apv-fd-valwrap{flex:1 1 160px;min-width:110px;display:flex;align-items:center;position:relative}
.apv-fd-valwrap[hidden]{display:none}
.apv-fd-value{flex:1;min-width:0;padding-right:24px}
.apv-fd-valclear{position:absolute;right:4px;top:50%;transform:translateY(-50%);border:none;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}
.apv-fd-valclear:hover{color:var(--dsw-alias-label-primary)}
.apv-fd-valclear[hidden]{display:none}
.apv-fd-case{font:600 12px/1 system-ui,sans-serif;padding:6px 7px}
.apv-fd-case[hidden]{display:none}
.apv-fd-case[aria-pressed="true"]{border-color:#3b82f6;color:#1d4ed8;background:var(--dsw-static-deepseek-100,#dbeafe)}
body[data-ds-dark-theme] .apv-fd-case[aria-pressed="true"]{color:#93c5fd;background:#1e2a44}
.apv-fd-cond-err{font-size:12px;color:#dc2626;padding:4px 2px 0;white-space:pre-wrap;overflow-wrap:anywhere}
body[data-ds-dark-theme] .apv-fd-cond-err{color:#f87171}
.apv-fd-cond-err:empty{display:none}
.apv-fd-empty{padding:24px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.apv-fd-default-note{padding:16px 14px;font-size:13px;color:var(--dsw-alias-label-tertiary);line-height:1.7}
.apv-fd-default-note[hidden],.apv-fd-namerow[hidden],.apv-fd-moderow[hidden],.apv-fd-conds[hidden]{display:none}
.apv-fd-foot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.apv-fd-count{flex:1 1 240px;min-width:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.apv-fd-count b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.apv-fd-counting{opacity:.55}
.apv-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff}
.apv-btn-primary:hover{background:#1d4ed8}
@container apvfd (max-width:720px){.apv-fd-main{flex-direction:column}.apv-fd-side{flex:0 0 auto;max-height:150px;border-right:none;border-bottom:1px solid var(--dsw-alias-border-l2)}.apv-fd-list{display:flex;flex-wrap:wrap;gap:2px}.apv-fd-item{width:auto;max-width:200px}.apv-fd-side-btns{padding:4px 8px}}
`

    // ---------------------------------------------------------------- helpers

    function injectStyle() {
      if (typeof document === 'undefined') return
      // 已存在也要按当前 CSS 覆盖：客户端插件热更新只换 JS、不会换 DOM 里那份 <style>，
      // 否则改了样式会一直吃旧的那份（2026-10-08 实测：新面板出来了，新 CSS 没生效）。
      const existing = document.getElementById('dsh-apiviz-style')
      if (existing !== null) {
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      const style = document.createElement('style')
      style.id = 'dsh-apiviz-style'
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
      if (!response.ok) {
        // 带上状态码 / 错误码 / 原始错误体：调用方要区分 409 冲突、400 校验失败、404 不存在
        const error = new Error((body && body.error) || `HTTP ${response.status}`)
        error.status = response.status
        error.code = body && typeof body.code === 'string' ? body.code : undefined
        error.body = body
        throw error
      }
      return body
    }

    const errText = (error) => (error instanceof Error ? error.message : String(error))

    /**
     * 取响应原文（导出文件用）：不经 JSON.parse / JSON.stringify，大整数、1.50 这类数字原样保留。
     * 失败时和 apiFetch 一样抛带 status / code / body 的错误。
     */
    async function apiFetchText(path, init) {
      const response = await fetch(API + path, init)
      const text = await response.text()
      if (!response.ok) {
        let body = null
        try {
          body = JSON.parse(text)
        } catch {
          body = null
        }
        const error = new Error((body && body.error) || `HTTP ${response.status}`)
        error.status = response.status
        error.code = body && typeof body.code === 'string' ? body.code : undefined
        error.body = body
        throw error
      }
      return text
    }

    /** 下载文件名里的时间戳：本机时间 YYYYMMDD-HHmmss，和宿主给导出文件起名的格式相同（R5-06：以前用 UTC，和宿主存的文件名、本机日期对不上）。 */
    const fileStamp = () => {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }

    /** 同一类读取只认最后发出的那次：轮询和操作并发时，先发后到的旧响应不覆盖新数据。 */
    function latestGate() {
      let issued = 0
      let applied = 0
      return {
        next: () => ++issued,
        accept: (seq) => {
          if (seq < applied) return false
          applied = seq
          return true
        },
      }
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
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    }

    function fmtDur(ms) {
      if (typeof ms !== 'number') return '-'
      return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
    }

    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-'
      if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${Math.round(bytes)} B`
    }

    function fmtBucket(ms) {
      if (!Number.isFinite(ms)) return '-'
      if (ms % 3600000 === 0) return `${ms / 3600000} 小时`
      if (ms % 60000 === 0) return `${ms / 60000} 分钟`
      if (ms % 1000 === 0) return `${ms / 1000} 秒`
      return `${ms} 毫秒`
    }

    function headerValue(headers, name) {
      const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
      return key === undefined ? undefined : headers[key]
    }

    function isFlagged(record) {
      return record?.flag === true || record?.flag === 1
    }

    function methodBadge(method) {
      const cls = { GET: 'apv-m-get', POST: 'apv-m-post', PUT: 'apv-m-put', DELETE: 'apv-m-delete' }[method] || 'apv-m-other'
      return el('span', 'apv-badge ' + cls, method)
    }

    function statusBadge(status) {
      if (!Number.isInteger(status)) return el('span', 'apv-badge apv-s-0', '-')
      return el('span', 'apv-badge apv-s-' + Math.floor(status / 100), String(status))
    }

    /**
     * 归一化调用栈用于展示：折叠异步状态机产生的相邻重复帧（a,a,b,b → a,b）。
     * 一个 async 方法在物理栈上是 MoveNext(状态机) + kickoff 两帧，Unwrap 后同名相邻，
     * 这里合并；保持原始「内→外」顺序（stack[0]=最靠近 HTTP 的帧，末尾=最外层入口）。
     */
    function normalizeStack(stack) {
      if (!Array.isArray(stack)) return []
      const out = []
      for (const f of stack) {
        if (typeof f !== 'string' || f === '') continue
        if (out.length > 0 && out[out.length - 1] === f) continue // 折叠相邻重复(异步双帧)
        out.push(f)
      }
      return out
    }

    /**
     * 完整调用链文本（入口 → 接口）。去重后按「外→内」排列，
     * 连续同类型帧省略重复的类型前缀，紧凑又可读。
     * 例：WatchListViewModel.OnRefresh → .LoadQuotes → QuoteApi.FetchSnapshot
     */
    function formatCallChain(stack) {
      const norm = normalizeStack(stack)
      if (norm.length === 0) return ''
      const parts = []
      let prevType = null
      for (const frame of norm.slice().reverse()) {
        const dot = frame.indexOf('.')
        const type = dot > 0 ? frame.slice(0, dot) : ''
        const method = dot > 0 ? frame.slice(dot + 1) : frame
        parts.push(type !== '' && type === prevType ? '.' + method : frame)
        prevType = type
      }
      return parts.join(' → ')
    }

    /**
     * One 调用方 (caller) table cell from a record.caller object.
     * 列表列直接展示完整调用链（入口→接口，已折叠异步重复帧）；tooltip 逐帧编号。
     * 无调用栈时回退到「谁 ← Api」，仍无则显示「-」。
     */
    function callerCell(c) {
      const td = el('td', 'apv-caller')
      const norm = c !== null && c !== undefined ? normalizeStack(c.stack) : []
      const hasStack = norm.length > 0
      if (c === null || c === undefined || (!c.viewModel && !c.view && !hasStack)) {
        td.textContent = '-'
        return td
      }
      const chain = hasStack ? formatCallChain(c.stack) : ''
      if (chain !== '') {
        td.textContent = chain
      } else {
        const who = c.viewModel || c.view || (norm.length > 0 ? norm[0] : '')
        let label = who
        if (c.viewModel && c.apiMethod && c.apiMethod !== who) label += ' ← ' + c.apiMethod
        td.textContent = label
      }
      const lines = []
      if (c.viewModel) lines.push('ViewModel: ' + c.viewModel)
      if (c.view) lines.push('View(约定): ' + c.view)
      if (c.apiMethod) lines.push('Api: ' + c.apiMethod)
      if (c.trigger) lines.push('触发: ' + c.trigger)
      if (hasStack) {
        lines.push('调用链(入口→接口):')
        norm.slice().reverse().forEach((f, i) => lines.push('  ' + (i + 1) + '. ' + f))
      }
      td.title = lines.join('\n')
      return td
    }

    /** Lenient indentation for a JSON fragment (works on truncated/incomplete JSON text). */
    function prettyJsonFragment(s, cap) {
      let out = ''
      let indent = 0
      let inString = false
      let esc = false
      const max = cap ?? 262144
      for (let i = 0; i < s.length; i++) {
        if (out.length >= max) {
          out += '\n…(片段过长，已省略)'
          break
        }
        const c = s[i]
        if (inString) {
          out += c
          if (esc) { esc = false; continue }
          if (c === '\\') { esc = true; continue }
          if (c === '"') inString = false
          continue
        }
        if (c === '"') { inString = true; out += c; continue }
        switch (c) {
          case '{':
          case '[':
            out += c + '\n' + '  '.repeat(++indent)
            break
          case '}':
          case ']':
            indent = Math.max(0, indent - 1)
            out += '\n' + '  '.repeat(indent) + c
            break
          case ',':
            out += c + '\n' + '  '.repeat(indent)
            break
          case ':':
            out += c + ' '
            break
          default:
            out += c
        }
      }
      return out
    }

    /**
     * 标准 JSON 的词法扫描：返回 token 列表 [{ k, c, s, e }]（k：'p' 标点 / 'str' / 'num' / 'lit'；c：标点的字符码；
     * s/e：在原文里的起止下标）；词法不合法返回 null。下面两个「保留原文」的工具共用它。
     */
    function scanJsonTokens(src) {
      const n = src.length
      const out = []
      const isDigit = (d) => d >= 48 && d <= 57
      const isHex = (d) => isDigit(d) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)
      let i = 0
      while (i < n) {
        const c = src.charCodeAt(i)
        if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) { i++; continue }
        if (c === 0x7b || c === 0x7d || c === 0x5b || c === 0x5d || c === 0x3a || c === 0x2c) {
          out.push({ k: 'p', c, s: i, e: i + 1 })
          i++
          continue
        }
        if (c === 0x22) {
          let j = i + 1
          for (;;) {
            if (j >= n) return null
            const d = src.charCodeAt(j)
            if (d === 0x22) break
            if (d < 0x20) return null
            if (d !== 0x5c) { j++; continue }
            const x = src.charCodeAt(j + 1)
            if (x === 0x75) {
              if (!(isHex(src.charCodeAt(j + 2)) && isHex(src.charCodeAt(j + 3)) && isHex(src.charCodeAt(j + 4)) && isHex(src.charCodeAt(j + 5)))) return null
              j += 6
            } else if (x === 0x22 || x === 0x5c || x === 0x2f || x === 0x62 || x === 0x66 || x === 0x6e || x === 0x72 || x === 0x74) {
              j += 2
            } else {
              return null
            }
          }
          out.push({ k: 'str', c: 0, s: i, e: j + 1 })
          i = j + 1
          continue
        }
        if (c === 0x2d || isDigit(c)) {
          // -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?
          let j = c === 0x2d ? i + 1 : i
          if (src.charCodeAt(j) === 0x30) j++
          else if (isDigit(src.charCodeAt(j))) { while (isDigit(src.charCodeAt(j))) j++ }
          else return null
          if (src.charCodeAt(j) === 0x2e) {
            j++
            if (!isDigit(src.charCodeAt(j))) return null
            while (isDigit(src.charCodeAt(j))) j++
          }
          if (src.charCodeAt(j) === 0x65 || src.charCodeAt(j) === 0x45) {
            j++
            if (src.charCodeAt(j) === 0x2b || src.charCodeAt(j) === 0x2d) j++
            if (!isDigit(src.charCodeAt(j))) return null
            while (isDigit(src.charCodeAt(j))) j++
          }
          out.push({ k: 'num', c: 0, s: i, e: j })
          i = j
          continue
        }
        const len = src.startsWith('true', i) || src.startsWith('null', i) ? 4 : src.startsWith('false', i) ? 5 : 0
        if (len === 0) return null
        out.push({ k: 'lit', c: 0, s: i, e: i + len })
        i += len
      }
      return out
    }

    /**
     * 保留原文的 JSON 缩进（2 空格，版式同 JSON.stringify(v, null, 2)）：字符串（连同原来的转义写法）、数字、
     * true/false/null 逐字拷贝，只重排 token 之间的空白；不是合法 JSON 原样返回。
     * 不用 JSON.parse/JSON.stringify：那会把超过 2^53 的整数（订单号、账户号）四舍五入、把 1.50 写成 1.5、
     * 把 \u 转义改写成字面字符、合并重复键 —— 而这里的文本会被用户编辑后原样发回给客户端。
     * 迭代实现（不递归）；嵌套超过 PRETTY_JSON_MAX_DEPTH 层（缩进本身就会让文本膨胀成几百 MB）也原样返回。
     */
    const PRETTY_JSON_MAX_DEPTH = 512
    function prettyJsonText(text) {
      const src = String(text ?? '')
      const toks = scanJsonTokens(src)
      if (toks === null || toks.length === 0) return src
      const parts = []
      const pads = ['']
      const pad = (d) => {
        while (pads.length <= d) pads.push(pads[pads.length - 1] + '  ')
        return pads[d]
      }
      const stack = [] // 0x7b {  /  0x5b [
      let want = 'value' // value | key | colon | next（逗号或收尾）| done
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i]
        const c = t.k === 'p' ? t.c : 0
        if (want === 'done') return src
        if (want === 'colon') {
          if (c !== 0x3a) return src
          parts.push(': ')
          want = 'value'
          continue
        }
        if (want === 'next') {
          const top = stack[stack.length - 1]
          if (c === 0x2c) {
            parts.push(',\n', pad(stack.length))
            want = top === 0x7b ? 'key' : 'value'
            continue
          }
          if ((c === 0x7d && top === 0x7b) || (c === 0x5d && top === 0x5b)) {
            stack.pop()
            parts.push('\n', pad(stack.length), c === 0x7d ? '}' : ']')
            want = stack.length === 0 ? 'done' : 'next'
            continue
          }
          return src
        }
        if (want === 'key') {
          if (t.k !== 'str') return src
          parts.push(src.slice(t.s, t.e))
          want = 'colon'
          continue
        }
        // want === 'value'
        if (c === 0x7b || c === 0x5b) {
          const close = c === 0x7b ? 0x7d : 0x5d
          const nextTok = toks[i + 1]
          if (nextTok !== undefined && nextTok.k === 'p' && nextTok.c === close) {
            parts.push(c === 0x7b ? '{}' : '[]')
            i++
            want = stack.length === 0 ? 'done' : 'next'
            continue
          }
          stack.push(c)
          if (stack.length > PRETTY_JSON_MAX_DEPTH) return src
          parts.push(c === 0x7b ? '{' : '[', '\n', pad(stack.length))
          want = c === 0x7b ? 'key' : 'value'
          continue
        }
        if (t.k === 'p') return src
        parts.push(src.slice(t.s, t.e))
        want = stack.length === 0 ? 'done' : 'next'
      }
      if (want !== 'done') return src
      try {
        return parts.join('')
      } catch {
        return src // 结果超过字符串长度上限（RangeError）：宁可不排版
      }
    }

    /**
     * 解析 JSON，但数字不转成 JS number，一律保留原文字符串（"1.50"、"12345678901234567891" 原样）。
     * 用在用户能编辑、再发回宿主的 JSON 上（断点里的请求头 / 响应头）：头的值本来就是字符串，
     * 用 JSON.parse 会把没加引号的大整数四舍五入。返回 { ok: true, value } / { ok: false }。
     */
    function parseJsonKeepNumbers(text) {
      const src = String(text ?? '')
      const toks = scanJsonTokens(src)
      if (toks === null || toks.length === 0) return { ok: false }
      let p = 0
      const isP = (t, code) => t !== undefined && t.k === 'p' && t.c === code
      const fail = () => { throw new SyntaxError('invalid JSON') }
      const readValue = () => {
        const t = toks[p++]
        if (t === undefined) fail()
        if (t.k === 'str') return JSON.parse(src.slice(t.s, t.e)) // 单个字符串 token：JSON.parse 无损
        if (t.k === 'num') return src.slice(t.s, t.e)
        if (t.k === 'lit') {
          const w = src.slice(t.s, t.e)
          return w === 'true' ? true : w === 'false' ? false : null
        }
        if (t.c === 0x7b) {
          const obj = {}
          if (isP(toks[p], 0x7d)) { p++; return obj }
          for (;;) {
            const k = toks[p++]
            if (k === undefined || k.k !== 'str' || !isP(toks[p++], 0x3a)) fail()
            // defineProperty：键名是 "__proto__" 时也当普通字段（与 JSON.parse 一致），不改原型
            Object.defineProperty(obj, JSON.parse(src.slice(k.s, k.e)), { value: readValue(), enumerable: true, writable: true, configurable: true })
            const sep = toks[p++]
            if (isP(sep, 0x7d)) return obj
            if (!isP(sep, 0x2c)) fail()
          }
        }
        if (t.c === 0x5b) {
          const arr = []
          if (isP(toks[p], 0x5d)) { p++; return arr }
          for (;;) {
            arr.push(readValue())
            const sep = toks[p++]
            if (isP(sep, 0x5d)) return arr
            if (!isP(sep, 0x2c)) fail()
          }
        }
        return fail()
      }
      try {
        const value = readValue()
        return p === toks.length ? { ok: true, value } : { ok: false }
      } catch {
        return { ok: false }
      }
    }

    /** Render one body: pretty JSON when parseable, readable fragment when truncated, raw text otherwise. */
    function formatBody(v) {
      if (typeof v !== 'string' || v === '') return null
      let text = v
      const truncated = text.endsWith('…(截断)')
      if (truncated) text = text.slice(0, -5)
      try {
        const pretty = JSON.stringify(JSON.parse(text), null, 2)
        return (truncated ? '(响应体超过 2MB 上限，已截断)\n' : '') + pretty
      } catch {
        // Not strictly parseable — truncated at the 2MB cap, trailing bytes, or a
        // reassembled capture fragment. If it still looks like JSON, indent it
        // leniently so it reads as a tree instead of one crammed blob.
        if (/^\s*[{\[]/.test(text)) {
          const note = truncated ? '(响应体超过 2MB 上限，以下为可读片段)\n' : ''
          return note + prettyJsonFragment(text)
        }
        return v
      }
    }

    /** Sectioned detail dump: bodies render raw (pretty), never as escaped blob strings. */
    function detailText(full) {
      const meta = {
        method: full.method,
        url: full.url,
        status: full.status,
        time: Number.isFinite(full.ts) ? new Date(full.ts).toLocaleString() : undefined,
        source: full.source,
        durationMs: full.durationMs,
        process: full.process,
        note: full.note,
      }
      const parts = ['=== 基本信息 ===', JSON.stringify(meta, null, 2)]
      if (full.reqHeaders !== undefined) parts.push('=== 请求头 ===', JSON.stringify(full.reqHeaders, null, 2))
      const rb = formatBody(full.reqBody)
      if (rb !== null) parts.push('=== 请求体 ===', rb)
      if (full.resHeaders !== undefined) parts.push('=== 响应头 ===', JSON.stringify(full.resHeaders, null, 2))
      const sb = formatBody(full.resBody)
      if (sb !== null) parts.push('=== 响应体 ===', sb)
      return parts.join('\n\n')
    }

    /** Copy text to the clipboard with a legacy fallback; flips the button label briefly. */
    function copyText(text, btn, originalLabel) {
      const label = originalLabel !== undefined ? originalLabel : btn.textContent
      const done = () => {
        btn.textContent = '已复制 ✓'
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

    // ------------------------------------------------------- P0-1 copy-as snippets

    function snippetCurl(rec) {
      const parts = [`curl -X ${rec.method} '${rec.url.replace(/'/g, "'\\''")}'`]
      for (const [k, v] of Object.entries(rec.reqHeaders ?? {})) {
        parts.push(`-H '${k}: ${String(v).replace(/'/g, "'\\''")}'`)
      }
      if (typeof rec.reqBody === 'string' && rec.reqBody !== '' && !/^(GET|HEAD)$/i.test(rec.method)) {
        parts.push(`--data-raw '${rec.reqBody.replace(/'/g, "'\\''")}'`)
      }
      return parts.join(' \\\n  ')
    }

    function snippetPwsh(rec) {
      const headers = {}
      for (const [k, v] of Object.entries(rec.reqHeaders ?? {})) {
        headers[k] = String(v)
      }
      const lines = []
      lines.push(`$headers = @{`)
      for (const [k, v] of Object.entries(headers)) lines.push(`  '${k.replace(/'/g, "''")}' = '${String(v).replace(/'/g, "''")}'`)
      lines.push(`}`)
      lines.push(`Invoke-RestMethod -Method ${rec.method} -Uri '${rec.url.replace(/'/g, "''")}' -Headers $headers` + (typeof rec.reqBody === 'string' && rec.reqBody !== '' && !/^(GET|HEAD)$/i.test(rec.method) ? ` -Body '${rec.reqBody.replace(/'/g, "''")}'` : ''))
      return lines.join('\n')
    }

    function snippetFetch(rec) {
      const headers = {}
      for (const [k, v] of Object.entries(rec.reqHeaders ?? {})) {
        headers[k] = String(v)
      }
      const opts = [`method: '${rec.method}'`]
      if (Object.keys(headers).length > 0) opts.push(`headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')}`)
      if (typeof rec.reqBody === 'string' && rec.reqBody !== '' && !/^(GET|HEAD)$/i.test(rec.method)) opts.push(`body: ${JSON.stringify(rec.reqBody)}`)
      return `fetch('${rec.url.replace(/'/g, "\\'")}', {\n  ${opts.join(',\n  ')}\n})`
    }

    function buildSnippet(kind, rec) {
      if (kind === 'curl') return snippetCurl(rec)
      if (kind === 'pwsh') return snippetPwsh(rec)
      return snippetFetch(rec)
    }

    // ------------------------------------------------------- P0-4 redaction/export

    const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-token|access-token|token)$/i
    const SENSITIVE_QUERY = /^(token|usertoken|connectiontoken|access_token|refresh_token|password|secret|apikey|api_key|sign|sig)$/i

    function redactUrl(url) {
      try {
        const u = new URL(url)
        for (const key of [...u.searchParams.keys()]) {
          if (SENSITIVE_QUERY.test(key)) u.searchParams.set(key, '***')
        }
        return u.toString()
      } catch {
        return url.replace(/([?&](?:token|usertoken|userToken|connectionToken|access_token|password|secret|apikey|sign|sig)=)[^&]*/gi, '$1***')
      }
    }

    function redactRecord(rec) {
      const out = { ...rec }
      if (typeof out.url === 'string') out.url = redactUrl(out.url)
      for (const key of ['reqHeaders', 'resHeaders']) {
        if (out[key] === null || typeof out[key] !== 'object') continue
        const headers = {}
        for (const [k, v] of Object.entries(out[key])) {
          headers[k] = SENSITIVE_HEADERS.test(k) ? '***' : v
        }
        out[key] = headers
      }
      return out
    }

    function downloadBlob(filename, content, type) {
      const blob = new Blob([content], { type: type ?? 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    }

    function buildHar(records) {
      return {
        log: {
          version: '1.2',
          creator: { name: 'dsh-api-visualizer', version: '0.3.0' },
          entries: records.map((r) => ({
            startedDateTime: Number.isFinite(r.ts) ? new Date(r.ts).toISOString() : new Date().toISOString(),
            time: r.durationMs ?? 0,
            request: {
              method: r.method,
              url: r.url,
              httpVersion: 'HTTP/1.1',
              headers: Object.entries(r.reqHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
              queryString: [],
              postData: typeof r.reqBody === 'string' && r.reqBody !== '' ? { mimeType: 'text/plain', text: r.reqBody } : undefined,
            },
            response: {
              status: r.status ?? 0,
              statusText: '',
              httpVersion: 'HTTP/1.1',
              headers: Object.entries(r.resHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
              content: typeof r.resBody === 'string' ? { size: r.resBody.length, mimeType: headerValue(r.resHeaders, 'content-type') ?? 'text/plain', text: r.resBody } : { size: 0, mimeType: 'text/plain' },
            },
            cache: {},
            timings: { send: 0, wait: r.durationMs ?? 0, receive: 0 },
            comment: r.note ?? '',
          })),
        },
      }
    }

    function bodyJsonSchema(text, depth = 0) {
      if (typeof text !== 'string' || text.trim() === '' || depth > 6) return undefined
      let value
      try { value = JSON.parse(text) } catch { return undefined }
      const schema = (v, d) => {
        if (v === null) return { type: 'null' }
        if (Array.isArray(v)) return { type: 'array', items: v.length > 0 ? schema(v[0], d + 1) : {} }
        if (typeof v === 'object') {
          if (d > 6) return { type: 'object' }
          const properties = {}
          for (const [k, child] of Object.entries(v).slice(0, 100)) properties[k] = schema(child, d + 1)
          return { type: 'object', properties }
        }
        if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' }
        return { type: typeof v }
      }
      return schema(value, depth)
    }

    /** Generate a useful OpenAPI 3.0 draft from the captured samples. */
    function buildOpenApi(records) {
      const paths = {}
      for (const r of records) {
        let u
        try { u = new URL(r.url) } catch { continue }
        const path = u.pathname || '/'
        const method = String(r.method ?? 'GET').toLowerCase()
        const op = paths[path]?.[method] ?? {
          operationId: `${method}_${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'root'}`,
          summary: `${r.method} ${path}`,
          parameters: [],
          responses: {},
        }
        for (const key of u.searchParams.keys()) {
          if (!op.parameters.some((p) => p.name === key)) op.parameters.push({ name: key, in: 'query', required: false, schema: { type: 'string' } })
        }
        const reqType = String(headerValue(r.reqHeaders, 'content-type') ?? 'application/json').split(';')[0]
        if (typeof r.reqBody === 'string' && r.reqBody !== '' && !op.requestBody) {
          op.requestBody = { required: true, content: { [reqType || 'text/plain']: { schema: bodyJsonSchema(r.reqBody) ?? { type: 'string' }, example: r.reqBody } } }
        }
        const status = String(Number.isInteger(r.status) ? r.status : 200)
        if (op.responses[status] === undefined) {
          const resType = String(headerValue(r.resHeaders, 'content-type') ?? 'application/json').split(';')[0]
          op.responses[status] = { description: 'Captured response', content: typeof r.resBody === 'string' && r.resBody !== '' ? { [resType || 'text/plain']: { schema: bodyJsonSchema(r.resBody) ?? { type: 'string' }, example: r.resBody } } : undefined }
        }
        paths[path] ??= {}
        paths[path][method] = op
      }
      return { openapi: '3.0.3', info: { title: 'DSH captured API', version: new Date().toISOString().slice(0, 10) }, servers: [], paths }
    }

    function jsonDiff(before, after, path = '$', out = []) {
      if (out.length >= 100) return out
      if (before === after) return out
      if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) !== Array.isArray(after)) {
        out.push({ path, before, after })
        return out
      }
      const keys = new Set([...Object.keys(before), ...Object.keys(after)])
      for (const key of keys) jsonDiff(before[key], after[key], `${path}.${key}`, out)
      return out
    }

    function replayDiff(original, response) {
      if (original === null || typeof response?.body !== 'string') return []
      const changes = []
      if (Number.isInteger(original.status) && Number.isInteger(response.status) && original.status !== response.status) changes.push({ path: '$.status', before: original.status, after: response.status })
      try {
        const before = JSON.parse(original.resBody ?? '')
        const after = JSON.parse(response.body)
        return jsonDiff(before, after, '$.body', changes)
      } catch {
        if (original.resBody !== response.body) changes.push({ path: '$.body', before: original.resBody ?? '', after: response.body })
        return changes
      }
    }

    // ------------------------------------------- 过滤器（Fiddler 式自定义过滤器）：纯函数
    // 过滤器存在宿主上（GET/POST/DELETE /filters），面板、智能体（capture_query 的 filter / conditions）和同事共用。
    // 匹配在宿主做（lib/capture-filters.mjs）；面板只负责编辑、即时校验，以及把「当前启用的过滤器」带进每次查询。

    const FILTER_COND_LIMIT = 50
    const FILTER_NAME_MAX = 80
    const FILTER_VALUE_MAX = 2000
    const FILTER_REGEX_MAX = 1000
    const FILTER_HEADER_MAX = 200
    /** 过滤条件放进查询串的上限（编码后字符数）：更长的已存过滤器改用 filterId，由宿主按 id 取（URL 太长会被拒）。 */
    const FILTER_QUERY_MAX = 6000
    /** 当前启用的过滤器多久和宿主对一次（被别处删除 / 修改时跟上）。 */
    const FILTER_SYNC_MS = 5000
    const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

    /** 宿主是旧版本（没有 GET /filters）时用的字段 / 运算符表：与 lib/capture-filters.mjs 的 FILTER_FIELDS / FILTER_OPS 同一份契约。 */
    const BUILTIN_FILTER_FIELDS = [
      { id: 'url', label: 'URL', kind: 'text', hint: '完整 URL' },
      { id: 'host', label: '域名', kind: 'text', hint: '小写主机名' },
      { id: 'path', label: '路径', kind: 'text', hint: '不含查询参数' },
      { id: 'query', label: '查询参数', kind: 'text', hint: '? 后面的原文' },
      { id: 'method', label: '方法', kind: 'text' },
      { id: 'status', label: '状态码', kind: 'number' },
      { id: 'process', label: '进程', kind: 'text', hint: '发起请求的进程名（不含 .exe）' },
      { id: 'channel', label: '捕获渠道', kind: 'text', hint: 'realtime / intercept / local-proxy / import / agent' },
      { id: 'contentType', label: 'Content-Type', kind: 'text', hint: '响应的 Content-Type' },
      { id: 'durationMs', label: '耗时 ms', kind: 'number' },
      { id: 'bytesRes', label: '响应大小', kind: 'number', hint: '字节' },
      { id: 'bytesReq', label: '请求大小', kind: 'number', hint: '字节' },
      { id: 'pid', label: '进程 PID', kind: 'number' },
      { id: 'reqHeader', label: '请求头', kind: 'text', header: true },
      { id: 'resHeader', label: '响应头', kind: 'text', header: true },
      { id: 'reqBody', label: '请求体', kind: 'text' },
      { id: 'resBody', label: '响应体', kind: 'text' },
      { id: 'note', label: '备注', kind: 'text' },
      { id: 'caller', label: '调用方', kind: 'text', hint: 'ViewModel / Api 方法 / 调用栈' },
      { id: 'tag', label: '标签', kind: 'text' },
    ]
    // 文本比较也能用在数字字段上（比较 String(值)），所以 kinds 是 ['text', 'number']；数字比较只有 ['number']
    const BUILTIN_FILTER_OPS = [
      { id: 'contains', label: '包含', kinds: ['text', 'number'], needsValue: true },
      { id: 'notContains', label: '不包含', kinds: ['text', 'number'], needsValue: true },
      { id: 'equals', label: '等于', kinds: ['text', 'number'], needsValue: true },
      { id: 'notEquals', label: '不等于', kinds: ['text', 'number'], needsValue: true },
      { id: 'startsWith', label: '开头是', kinds: ['text', 'number'], needsValue: true },
      { id: 'endsWith', label: '结尾是', kinds: ['text', 'number'], needsValue: true },
      { id: 'regex', label: '匹配正则', kinds: ['text', 'number'], needsValue: true },
      { id: 'notRegex', label: '不匹配正则', kinds: ['text', 'number'], needsValue: true },
      { id: 'eq', label: '=', kinds: ['number'], needsValue: true },
      { id: 'ne', label: '≠', kinds: ['number'], needsValue: true },
      { id: 'gt', label: '>', kinds: ['number'], needsValue: true },
      { id: 'gte', label: '≥', kinds: ['number'], needsValue: true },
      { id: 'lt', label: '<', kinds: ['number'], needsValue: true },
      { id: 'lte', label: '≤', kinds: ['number'], needsValue: true },
      { id: 'exists', label: '有值', kinds: ['text', 'number'], needsValue: false },
      { id: 'notExists', label: '为空', kinds: ['text', 'number'], needsValue: false },
    ]

    const fieldKind = (field) => (field !== undefined && field !== null && field.kind === 'number' ? 'number' : 'text')
    const opKinds = (op) => (op !== undefined && op !== null && Array.isArray(op.kinds) && op.kinds.length > 0 ? op.kinds : ['text', 'number'])
    /** 只用于数字的运算符（= ≠ > …）：值必须是数字，没有 Aa。 */
    const isNumberOp = (op) => opKinds(op).includes('number') && !opKinds(op).includes('text')
    /** 文本比较（包含 / 等于 / 正则 …）：有 Aa（区分大小写）开关。 */
    const isTextOp = (op) => op !== undefined && op !== null && op.needsValue !== false && !isNumberOp(op)
    const isRegexOp = (opId) => opId === 'regex' || opId === 'notRegex'

    /** 某字段能用的运算符：文本字段只给文本比较；数字字段先给 = ≠ > …，再给文本比较（按 String(值) 比），最后 有值 / 为空。 */
    function opsForField(field, ops) {
      const kind = fieldKind(field)
      const usable = ops.filter((op) => opKinds(op).includes(kind) || (kind === 'number' && opKinds(op).includes('text')))
      if (kind !== 'number') return usable
      const rank = (op) => (isNumberOp(op) ? 0 : op.needsValue === false ? 2 : 1)
      return usable.map((op, i) => [op, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([op]) => op)
    }

    const BUILTIN_OPS_BY_ID = new Map(BUILTIN_FILTER_OPS.map((op) => [op.id, op]))
    /** 名称的比较形式（与宿主一致：连续空白算一个空格、去首尾空白、不区分大小写）。 */
    const cleanFilterName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim()
    const codePoints = (s) => [...String(s)].length

    /**
     * 条件的规范形式（判断改没改、发给宿主）：不带 id；头名只在非空时带；不用值的比较（有值 / 为空）值记为空，
     * 只有文本比较带 Aa。编辑中的副本照样留着原来的值（换回「包含」时还在）。值不去空白（包含空格也算条件）。
     */
    function canonCond(c, opsById = BUILTIN_OPS_BY_ID) {
      const op = opsById.get(String(c.op ?? ''))
      const out = {
        enabled: c.enabled !== false,
        field: String(c.field ?? ''),
        op: String(c.op ?? ''),
        value: op !== undefined && op.needsValue === false ? '' : String(c.value ?? ''),
        caseSensitive: c.caseSensitive === true && (op === undefined || isTextOp(op)),
      }
      const header = typeof c.header === 'string' ? c.header.trim() : ''
      if (header !== '') out.header = header
      return out
    }
    const condSig = (c, opsById) => JSON.stringify(canonCond(c, opsById))
    /** 发给宿主的过滤条件（查询串 conditions= / POST 体）：{ mode, conditions }。 */
    const filterPayload = (f, opsById) => ({ mode: f.mode === 'any' ? 'any' : 'all', conditions: (Array.isArray(f.conditions) ? f.conditions : []).map((c) => canonCond(c, opsById)) })
    const filterSignature = (f, opsById) => JSON.stringify({ name: cleanFilterName(f.name), ...filterPayload(f, opsById) })
    const enabledCondCount = (f) => (Array.isArray(f.conditions) ? f.conditions : []).filter((c) => c && c.enabled !== false).length

    /** 宿主报错里「第 N 个条件」→ 下标（0 起）；不是某个条件的错误返回 -1。 */
    function conditionIndexOf(message) {
      const m = /第\s*(\d+)\s*个条件/.exec(String(message ?? ''))
      return m === null ? -1 : Number(m[1]) - 1
    }

    /** 宿主 FILTER_INVALID 错误点名的条件下标（0 起）：优先用错误体里的 conditionIndex，没有就从文字里认。 */
    function filterErrorIndex(error) {
      const raw = error?.body?.conditionIndex
      return Number.isInteger(raw) && raw >= 0 ? raw : conditionIndexOf(errText(error))
    }

    /**
     * 值还没填（要填值的比较方式，值是空的）：不标红（刚加的条件本来就是空的），但还不能统计、保存、应用。
     * 与宿主同一口径：文本比较的值不能是空串；数字比较去掉空白后不能为空。
     */
    function condIncomplete(c, opsById) {
      const op = opsById.get(c.op)
      if (op === undefined || op.needsValue === false) return false
      const value = String(c.value ?? '')
      return isNumberOp(op) ? value.trim() === '' : value === ''
    }

    /** 本地先查一遍明显的错误（正则写错、数字写错…），即时标红；宿主的校验结果到了以宿主的为准。 */
    function condProblem(c, fieldsById, opsById, ops) {
      const field = fieldsById.get(c.field)
      const op = opsById.get(c.op)
      if (field === undefined) return `未知字段「${c.field}」`
      if (op === undefined) return `未知比较方式「${c.op}」`
      if (!opsForField(field, ops).some((o) => o.id === op.id)) return `「${field.label ?? field.id}」不能用「${op.label ?? op.id}」`
      const header = typeof c.header === 'string' ? c.header.trim() : ''
      if (field.header === true && header !== '') {
        if (codePoints(header) > FILTER_HEADER_MAX) return `头名称太长（最多 ${FILTER_HEADER_MAX} 个字符）`
        if (!HEADER_TOKEN_RE.test(header)) return '头名称不合法：只能有字母、数字和 - _ . 等符号，不能有空格或冒号'
      }
      if (op.needsValue === false || condIncomplete(c, opsById)) return null
      const value = String(c.value ?? '')
      if (codePoints(value) > FILTER_VALUE_MAX) return `值太长（最多 ${FILTER_VALUE_MAX} 个字符）`
      if (isNumberOp(op)) {
        if (!Number.isFinite(Number(value.trim()))) return `「${op.label ?? op.id}」要填数字，「${value.trim()}」不是数字`
        return null
      }
      if (isRegexOp(op.id)) {
        if (codePoints(value) > FILTER_REGEX_MAX) return `正则太长（最多 ${FILTER_REGEX_MAX} 个字符）`
        try {
          filterRegex(value, c.caseSensitive === true)
        } catch (error) {
          return `正则无效：${errText(error)}`
        }
      }
      return null
    }

    /**
     * 与宿主同一套正则规则：不加 u 标志（.NET / Fiddler 风格的写法照样能用），不区分大小写时加 i；
     * 开头的 .NET 内联选项（(?i) / (?ms) …）翻译成标志。本地只用来即时提示，宿主的校验结果到了以宿主为准。
     */
    const INLINE_REGEX_OPTIONS = /^\(\?([imnsx]+)\)/
    function filterRegex(pattern, caseSensitive) {
      let source = pattern
      const flags = new Set(caseSensitive ? [] : ['i'])
      const inline = INLINE_REGEX_OPTIONS.exec(source)
      if (inline !== null) {
        source = source.slice(inline[0].length)
        if (inline[1].includes('x') && /[\s#]/.test(source)) throw new Error('不支持 (?x) 选项下的空白和 # 注释')
        for (const option of inline[1]) if (option === 'i' || option === 'm' || option === 's') flags.add(option)
      }
      return new RegExp(source, [...flags].join(''))
    }

    /** 一行中文描述（按钮提示、统计行用；与宿主 describeFilter 同一口径）。 */
    function describeFilterText(f, fieldsById, opsById) {
      const parts = []
      for (const c of Array.isArray(f.conditions) ? f.conditions : []) {
        if (c === null || typeof c !== 'object' || c.enabled === false) continue
        const field = fieldsById.get(c.field)
        const op = opsById.get(c.op)
        const header = typeof c.header === 'string' ? c.header.trim() : ''
        let text = `${field?.label ?? c.field}${field?.header === true && header !== '' ? ' ' + header : ''} ${op?.label ?? c.op}`
        if (op === undefined || op.needsValue !== false) {
          const value = String(c.value ?? '')
          if (isRegexOp(c.op)) text += ` /${value}/${c.caseSensitive === true ? '' : 'i'}`
          else if (op !== undefined && isNumberOp(op)) text += ` ${value}`
          else text += ` "${value}"${c.caseSensitive === true ? '（区分大小写）' : ''}`
        }
        parts.push(text)
      }
      if (parts.length === 0) return '（无条件，匹配全部）'
      return `${f.mode === 'any' ? '满足任一' : '全部满足'}：${parts.join('；')}`
    }

    /** 条件列表的可编辑副本（字段都补齐，头名缺省为空串）。 */
    function cloneConditions(list) {
      return (Array.isArray(list) ? list : []).filter((c) => c !== null && typeof c === 'object').map((c) => ({
        ...(typeof c.id === 'string' && c.id !== '' ? { id: c.id } : {}),
        enabled: c.enabled !== false,
        field: String(c.field ?? 'url'),
        op: String(c.op ?? 'contains'),
        value: String(c.value ?? ''),
        caseSensitive: c.caseSensitive === true,
        header: typeof c.header === 'string' ? c.header : '',
      }))
    }

    /** prefs 里存的「当前启用的过滤器」快照（宿主还没回话时先用它查，宿主的列表回来后以宿主为准）。 */
    function activeFilterSnapshot(f) {
      if (f === null || typeof f !== 'object' || typeof f.id !== 'string' || f.id === '' || !Array.isArray(f.conditions)) return null
      return {
        id: f.id,
        name: String(f.name ?? ''),
        mode: f.mode === 'any' ? 'any' : 'all',
        conditions: cloneConditions(f.conditions),
        updatedAt: Number.isFinite(Number(f.updatedAt)) ? Number(f.updatedAt) : 0,
      }
    }

    /** 记录的捕获渠道（与过滤字段 channel 同一口径）。 */
    const channelOf = (r) => (r?.source === 'proxy' ? (r.process === 'intercept' ? 'intercept' : 'local-proxy') : String(r?.source ?? ''))

    /** 发起请求的进程：`进程名:PID`（实时捕获只有进程名；都没有返回空串）。 */
    function clientProcText(r) {
      const name = typeof r?.clientProcess === 'string' ? r.clientProcess : ''
      const pid = Number.isInteger(r?.clientPid) ? r.clientPid : null
      if (name === '' && pid === null) return ''
      if (name === '') return `PID ${pid}`
      return pid === null ? name : `${name}:${pid}`
    }

    const SVG_ATTRS = 'viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
    const ICON_FUNNEL = `<svg ${SVG_ATTRS}><path d="M2.5 3h11l-4.3 5.3v4.4l-2.4 1.2V8.3z"/></svg>`
    const ICON_SAVE = `<svg ${SVG_ATTRS}><path d="M3 2.5h8.2l2.3 2.3v8.7h-11z"/><path d="M5.2 2.5v3.3h5V2.5"/><path d="M5.2 13.5V9.2h5.6v4.3"/></svg>`
    const ICON_COPY = `<svg ${SVG_ATTRS}><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5V3.2a.7.7 0 0 0-.7-.7H3.2a.7.7 0 0 0-.7.7v6.6c0 .4.3.7.7.7h2.3"/></svg>`
    const ICON_REVERT = `<svg ${SVG_ATTRS}><path d="M3.5 6.5h6.2a3.3 3.3 0 0 1 0 6.6H6"/><path d="M6 3.8 3.3 6.5 6 9.2"/></svg>`
    const ICON_TRASH = `<svg ${SVG_ATTRS}><path d="M2.8 4.2h10.4"/><path d="M6.2 4.2V2.8h3.6v1.4"/><path d="M4.2 4.2l.6 9h6.4l.6-9"/><path d="M6.8 6.6v4.4M9.2 6.6v4.4"/></svg>`

    /** 图标按钮：图标是常量 SVG，文字说明放 title / aria-label（不往 innerHTML 里放任何数据）。 */
    function iconButton(icon, title, extraClass) {
      const b = el('button', 'apv-btn apv-fd-icon' + (extraClass ? ' ' + extraClass : ''))
      b.type = 'button'
      b.innerHTML = icon
      b.title = title
      b.setAttribute('aria-label', title)
      return b
    }

    // ------------------------------------------------------- P0-3 json tree

    /** Collapsible JSON tree (plain DOM). Objects/arrays expand/collapse on click. */
    function jsonTreeEl(value, depth) {
      const d = depth ?? 0
      if (value !== null && typeof value === 'object') {
        const isArr = Array.isArray(value)
        const wrap = el('div', 'apv-jt')
        const row = el('div', 'apv-jt-row apv-jt-toggle')
        const kids = Object.keys(value)
        const expanded = d < 2
        row.appendChild(el('span', 'apv-jt-brace', isArr ? `[${kids.length}]` : `{${kids.length}}`))
        row.addEventListener('click', () => {
          container.hidden = !container.hidden
          row.classList.toggle('apv-jt-collapsed', container.hidden)
        })
        wrap.appendChild(row)
        const container = el('div', 'apv-jt-kids')
        if (!expanded) {
          container.hidden = true
          row.classList.add('apv-jt-collapsed')
        }
        for (const key of kids) {
          const childRow = el('div', 'apv-jt-row')
          if (isArr) childRow.appendChild(el('span', 'apv-jt-idx', key + ': '))
          else childRow.appendChild(el('span', 'apv-jt-key', JSON.stringify(key) + ': '))
          childRow.appendChild(jsonTreeEl(value[key], d + 1))
          container.appendChild(childRow)
        }
        wrap.appendChild(container)
        return wrap
      }
      const span = el('span', value === null ? 'apv-jt-null' : typeof value === 'number' ? 'apv-jt-num' : value === true || value === false ? 'apv-jt-bool' : 'apv-jt-str')
      span.textContent = value === null ? 'null' : typeof value === 'string' ? JSON.stringify(value) : String(value)
      return span
    }

    /** Highlight matches of a query inside a pre (returns element; skips when query empty). */
    function highlightedPre(text, query) {
      const pre = el('pre', 'apv-sec-pre')
      const q = (query ?? '').trim()
      if (q === '') {
        pre.textContent = text
        return pre
      }
      let escaped
      try {
        escaped = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      } catch {
        escaped = null
      }
      if (escaped === null) {
        pre.textContent = text
        return pre
      }
      const parts = text.split(escaped)
      let idx = 0
      escaped.lastIndex = 0
      let m
      while ((m = escaped.exec(text)) !== null) {
        pre.appendChild(document.createTextNode(text.slice(idx, m.index)))
        const mark = el('mark', 'apv-mark', m[0])
        pre.appendChild(mark)
        idx = m.index + m[0].length
        if (m.index === escaped.lastIndex) escaped.lastIndex += 1
      }
      pre.appendChild(document.createTextNode(text.slice(idx)))
      return pre
    }

    // ------------------------------------------------- P1-5 域名/路径树（纯函数）
    /**
     * 把记录列表折成 Fiddler 那种「域名 → 路径段 → 单条请求」的树。
     *
     * 为什么是纯函数而不是塞进渲染里：面板要能钉住它的语义（分桶、计数、错误归
     * 属、"解析不出域名的记录"不许被静默丢掉），而 client.js 其余部分要 document/localStorage
     * 才能跑，测不了。这里只吃 records，返回普通对象，没有 DOM 依赖。
     *
     * 口径（写死、可复跑）：
     *   · 顺序沿用入参顺序 —— 面板发来的列表是「新→旧」，所以同层第一个域名就是
     *     「最近命中的域」，`defaultOpen` 只对它（及其子树）为 true；
     *   · count / errors 是**子树合计**（错误=HTTP ≥400）；lastTs 是子树最新一条；
     *   · 解析不出域名或路径的记录不丢：挂到 noHost=true 的「(无法归簇)」桶里，
     *     第一层按整串 URL 分开（`/relative/x` 与 `about:blank` 不混成一个节点），
     *     并计入 unparsableUrls。
     * @param {Array<object>} records
     * @returns {{domains: Array<object>, total: number, unparsableUrls: number, newestTs: number|null, oldestTs: number|null}}
     */
    function buildUrlTree(records) {
      const list = Array.isArray(records) ? records : []
      const domains = new Map()
      let unparsableUrls = 0
      let newestTs = null
      let oldestTs = null
      for (const r of list) {
        const ts = Number(r?.ts)
        if (Number.isFinite(ts)) {
          if (newestTs === null || ts > newestTs) newestTs = ts
          if (oldestTs === null || ts < oldestTs) oldestTs = ts
        }
        let domain = ''
        let segments = null
        try {
          const u = new URL(String(r?.url ?? ''))
          domain = u.hostname
          // new URL('about:blank') 之类不进主机树：它有 hostname 语义但没有接口路径
          segments = u.pathname.split('/').filter((s) => s !== '')
          if (domain === '' || segments.length === 0) segments = null
        } catch {
          segments = null
        }
        if (segments === null) {
          unparsableUrls += 1
          // 不编造域名：`about:blank` 这类有 hostname 语义却没有接口路径，硬塞进某个域
          // 就是撒谎。它们统一挂到「(无法归簇)」，第一层按**整个 URL**分开，一个都不丢。
          domain = '(无法归簇)'
          segments = [String(r?.url ?? '')]
        }
        let node = domains.get(domain)
        if (node === undefined) {
          node = { domain, noHost: domain === '(无法归簇)', count: 0, errors: 0, lastTs: 0, key: domain, label: domain, depth: 0, kind: 'domain', _childIndex: new Map(), children: [] }
          domains.set(domain, node)
        }
        node.count += 1
        if (Number.isInteger(r?.status) && r.status >= 400) node.errors += 1
        if (Number.isFinite(ts) && ts > node.lastTs) node.lastTs = ts
        let cur = node
        for (let i = 0; i < segments.length; i++) {
          // 每个节点在被**走到**时就把自己的 children 从 Map 刷成数组（渲染层直接 for..of）。
          // 这是唯一正确的位置：映射会随新兄弟节点增长，只在"第一次下降"那次刷会漏掉
          // 之后追加的同级兄弟（实测：第二个兄弟节点根本没进数组 = 整条分支静默消失）。
          cur.children = [...cur._childIndex.values()]
          const bucket = cur._childIndex
          let child = bucket.get(segments[i])
          if (child === undefined) {
            child = {
              // key = 本节点的**完整路径**（父路径 + 本级段）。展开态是按 key 记的，
              // 曾经写成 `domain + '|' + cur.key` —— cur.key 对路径节点不是父路径，
              // 于是同域下所有路径段的 key 撞成同一串，展开一个兄弟等于动了另一个。
              key: cur.key + '|' + segments[i],
              label: segments[i],
              depth: cur.depth + 1,
              kind: 'path',
              count: 0,
              errors: 0,
              lastTs: 0,
              _childIndex: new Map(),
              children: [],
              records: [],
            }
            bucket.set(segments[i], child)
            cur.children = [...cur._childIndex.values()]
          }
          child.count += 1
          if (Number.isInteger(r?.status) && r.status >= 400) child.errors += 1
          if (Number.isFinite(ts) && ts > child.lastTs) child.lastTs = ts
          if (i === segments.length - 1) child.records.push(r)
          else cur = child
        }
      }
      const out = []
      for (const node of domains.values()) {
        node.children = [...node._childIndex.values()]
        for (const child of node.children) child.children = [...child._childIndex.values()]
        out.push(node)
      }
      // 默认只展开「最近命中的域」：排序只影响显示，不影响哪个域被展开
      const target = out.slice().sort((a, b) => (b.lastTs - a.lastTs) || (b.count - a.count) || (a.domain < b.domain ? -1 : 1))[0]
      if (target !== undefined) {
        const mark = (node) => {
          node.defaultOpen = true
          for (const child of node.children) mark(child)
        }
        mark(target)
      }
      return { domains: out, total: list.length, unparsableUrls, newestTs, oldestTs }
    }

    // ------------------------------------------------------------ sidebar entry

    function sidebarRoot() {
      const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
      if (column === null) return undefined
      const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement
      return logoOwner ?? (column.firstElementChild)
    }

    function newSessionButton(root) {
      const nested = root.querySelector('button[class*="newSession"]')
      if (nested !== null) return nested
      for (const child of root.children) {
        if (child.tagName === 'BUTTON') return child
      }
      return undefined
    }

    const ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8h2.5l1.8-4 2.4 8 1.8-4H14"/></svg>`

    function createEntry(toggle) {
      const entry = document.createElement('button')
      entry.type = 'button'
      entry.dataset.dshApivizEntry = ''
      entry.className = 'apv-entry'
      entry.setAttribute('aria-label', '接口捕获')
      entry.innerHTML = `<span>${ICON}</span><span class="apv-entry-label">接口捕获</span>`
      liveDot = el('span', 'apv-live-dot')
      liveDot.title = '实时捕获状态'
      entry.appendChild(liveDot)
      entry.addEventListener('click', toggle)
      return entry
    }

    function placeEntry(root, entry) {
      const button = newSessionButton(root)
      if (button === undefined) return false
      if (entry.parentElement !== root) {
        const row = button.closest('[class*="logoRow"]')
        const base = (row !== null && row.parentElement === root) ? row : button
        const family = Array.from(root.children).filter(
          (child) => child instanceof HTMLElement && child.matches('[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-apiviz-entry]'),
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
      const waitObserver = new MutationObserver(() => { tryPlace() })
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

    /** The view is a fixed overlay inside the center column (like task-board). */
    function buildPanel() {
      const view = el('div')
      view.dataset.dshApivizView = ''

      // toolbar
      const toolbar = el('div', 'apv-toolbar')
      toolbar.appendChild(el('span', 'apv-title', '接口捕获'))
      // 多客户端捕获库：显示的是哪个客户端的记录（宿主没配 capture-clients.json 或宿主太旧时整个隐藏）
      const clientSel = el('select', 'apv-select apv-client-sel')
      clientSel.hidden = true
      clientSel.title = '记录按客户端分库：「自动」跟随最近启动的客户端；选某个客户端 = 锁定只看它的记录（规则 / 证书 / 过滤器所有客户端共用）'
      toolbar.appendChild(clientSel)
      const stats = el('span', 'apv-stats', '…')
      toolbar.appendChild(stats)
      const q = el('input', 'apv-q')
      q.placeholder = '搜索 URL / 备注'
      toolbar.appendChild(q)
      const methodSel = el('select', 'apv-select')
      ;['', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'WS'].forEach((m) => {
        const opt = el('option', '', m === '' ? '方法:全部' : m)
        opt.value = m
        methodSel.appendChild(opt)
      })
      toolbar.appendChild(methodSel)
      const statusSel = el('select', 'apv-select')
      ;['', '2xx', '3xx', '4xx', '5xx'].forEach((s) => {
        const opt = el('option', '', s === '' ? '状态:全部' : s)
        opt.value = s
        statusSel.appendChild(opt)
      })
      toolbar.appendChild(statusSel)
      const sourceSel = el('select', 'apv-select')
      toolbar.appendChild(sourceSel)
      const flaggedBtn = el('button', 'apv-btn', '只看标记')
      flaggedBtn.title = '只显示打了星标的记录'
      toolbar.appendChild(flaggedBtn)
      // 过滤器（Fiddler 式）：条件构造器 + 存在宿主上的过滤器；启用后和这一排的筛选同时生效（AND）
      const filterGroup = el('span', 'apv-fgroup')
      const filterBtn = el('button', 'apv-btn apv-fbtn')
      filterBtn.type = 'button'
      const filterIconEl = el('span')
      filterIconEl.style.display = 'inline-flex'
      filterIconEl.innerHTML = ICON_FUNNEL
      const filterLabel = el('span', 'apv-fbtn-label', '过滤器')
      filterBtn.appendChild(filterIconEl)
      filterBtn.appendChild(filterLabel)
      const filterClearBtn = el('button', 'apv-btn apv-fbtn-x', '×')
      filterClearBtn.type = 'button'
      filterClearBtn.title = '取消当前过滤器（恢复为不过滤）'
      filterClearBtn.setAttribute('aria-label', '取消当前过滤器')
      filterClearBtn.hidden = true
      filterGroup.appendChild(filterBtn)
      filterGroup.appendChild(filterClearBtn)
      toolbar.appendChild(filterGroup)
      const captureBtn = el('button', 'apv-btn', '开始实时捕获')
      captureBtn.id = 'apv-capture-toggle'
      captureBtn.title = '像 Fiddler 一样实时抓取客户端 HTTP 流量（自动解析入库）'
      toolbar.appendChild(captureBtn)
      const captureChip = el('span', 'apv-stats', '')
      toolbar.appendChild(captureChip)
      const autoScrollWrap = el('label', 'apv-autoscroll')
      const autoScrollCb = el('input', '')
      autoScrollCb.type = 'checkbox'
      autoScrollCb.checked = true
      autoScrollWrap.appendChild(autoScrollCb)
      autoScrollWrap.appendChild(document.createTextNode(' 自动滚动'))
      toolbar.appendChild(autoScrollWrap)
      const freezeWrap = el('label', 'apv-autoscroll')
      freezeWrap.title = '冻结实时流：暂停自动刷新，方便查看/复制当前列表；取消勾选立即恢复（手动「刷新」仍可用）'
      const freezeCb = el('input', '')
      freezeCb.type = 'checkbox'
      freezeWrap.appendChild(freezeCb)
      freezeWrap.appendChild(document.createTextNode(' 冻结'))
      toolbar.appendChild(freezeWrap)
      // 本地代理（Fiddler 式，抓任意进程）
      const proxySep = el('span', 'apv-sep', '|')
      toolbar.appendChild(proxySep)
      const portInput = el('input', 'apv-port')
      portInput.type = 'number'
      portInput.min = '1'
      portInput.max = '65535'
      portInput.value = '8899'
      portInput.title = '代理监听端口'
      toolbar.appendChild(portInput)
      const proxyBtn = el('button', 'apv-btn', '启动代理')
      proxyBtn.title = '启动本地 HTTP(S) 代理：任意程序把代理指向它即可被抓包（HTTPS 自动解密）'
      toolbar.appendChild(proxyBtn)
      const proxyChip = el('span', 'apv-stats', '')
      toolbar.appendChild(proxyChip)
      const caBtn = el('button', 'apv-btn', '安装根证书')
      caBtn.title = '把本插件生成的根证书导入本机信任（当前用户，无需管理员）'
      toolbar.appendChild(caBtn)
      const sysProxyBtn = el('button', 'apv-btn', '设为系统代理')
      sysProxyBtn.title = '把 Windows 系统代理指向本代理（浏览器等程序即走它）；再次点击恢复原设置'
      toolbar.appendChild(sysProxyBtn)
      const rulesBtn = el('button', 'apv-btn', '代理规则')
      rulesBtn.title = 'AutoResponder 规则引擎：按 URL/方法 mock 响应、伪造状态码、注入延迟、阻断请求（对本地代理与透明拦截的流量生效）'
      toolbar.appendChild(rulesBtn)
      const bpBtn = el('button', 'apv-btn', '断点')
      bpBtn.title = '断点（Fiddler 式）：请求阶段=转发前挂起改 方法/请求头/请求体；响应阶段=拿到真实响应后挂起改 状态码/响应头/响应体，再放行或丢弃'
      toolbar.appendChild(bpBtn)
      const interceptBtn = el('button', 'apv-btn', '透明拦截')
      interceptBtn.title = '客户端强制直连、不走任何代理时用：把它的接口域名经 hosts 指向本机做反向代理（Fiddler 反向代理模式），mock / 断点 / 延时随即对它生效；不改客户端代码'
      toolbar.appendChild(interceptBtn)
      const interceptChip = el('span', 'apv-stats', '')
      toolbar.appendChild(interceptChip)
      const netsimBtn = el('button', 'apv-btn', '延时/弱网')
      const NETSIM_BTN_TITLE = '全局接口延时 / 弱网（Fiddler「Simulate Modem Speeds」）：不写规则，统一加 请求延迟 / 回包延迟 / 抖动 / 上下行限速；单个接口的延时在「代理规则」或详情里的「Mock」里设'
      netsimBtn.title = NETSIM_BTN_TITLE
      toolbar.appendChild(netsimBtn)
      /**
       * 工具栏按钮跟着真实开关走（智能体用 capture_netsim 打开的全局减速也要看得见，C43）。
       * summary 只在拿到宿主状态里的摘要时给（undefined = 不动提示文字），免得两处算法不同的摘要在提示里来回跳。
       */
      const setNetsimBtn = (enabled, summary) => {
        netsimBtn.textContent = enabled ? '延时/弱网 ●' : '延时/弱网'
        if (summary !== undefined) netsimBtn.title = enabled ? `${NETSIM_BTN_TITLE}\n当前已启用：${summary || '（未设数值）'}` : NETSIM_BTN_TITLE
      }
      // 导出（P0-4）
      const exportSep = el('span', 'apv-sep', '|')
      toolbar.appendChild(exportSep)
      const exportSel = el('select', 'apv-select')
      ;[['HAR', 'HAR'], ['JSON', 'JSON'], ['CSV', 'CSV'], ['OpenAPI', 'OpenAPI'], ['AI', 'AI 分析包 (Markdown)']].forEach(([f, label]) => {
        const opt = el('option', '', label)
        opt.value = f
        exportSel.appendChild(opt)
      })
      toolbar.appendChild(exportSel)
      // AI 分析包：正文截断长度 + 最多导出多少条（只在选了「AI 分析包」时显示）
      const aiBodySel = el('select', 'apv-select apv-aiopt')
      aiBodySel.title = 'AI 分析包里每个请求 / 响应正文最多保留多少（超出部分截掉并注明原长）'
      ;[['1024', '正文 1KB'], ['4096', '正文 4KB（默认）'], ['16384', '正文 16KB'], ['65536', '正文 64KB'], ['0', '不含正文']].forEach(([v, label]) => {
        const opt = el('option', '', label)
        opt.value = v
        aiBodySel.appendChild(opt)
      })
      aiBodySel.value = '4096'
      aiBodySel.hidden = true
      toolbar.appendChild(aiBodySel)
      const aiLimitIn = el('input', 'apv-port apv-ailimit apv-aiopt')
      aiLimitIn.type = 'number'
      aiLimitIn.min = '1'
      aiLimitIn.max = '5000'
      aiLimitIn.value = '500'
      aiLimitIn.title = '最多导出多少条（取最新的，默认 500，最多 5000）'
      aiLimitIn.setAttribute('aria-label', 'AI 分析包最多导出的条数')
      aiLimitIn.hidden = true
      toolbar.appendChild(aiLimitIn)
      const exportRedactWrap = el('label', 'apv-autoscroll')
      const exportRedactCb = el('input', '')
      exportRedactCb.type = 'checkbox'
      exportRedactCb.checked = false
      exportRedactWrap.appendChild(exportRedactCb)
      exportRedactWrap.appendChild(document.createTextNode(' 脱敏'))
      toolbar.appendChild(exportRedactWrap)
      const exportBtn = el('button', 'apv-btn', '导出')
      exportBtn.title = '导出 全部/当前筛选 的记录为 HAR / JSON / CSV / OpenAPI（可勾选脱敏）'
      toolbar.appendChild(exportBtn)
      const importBtn = el('button', 'apv-btn', '导入')
      importBtn.title = '导入 HAR 或之前导出的 JSON 记录，回灌进捕获库（可载入同事抓包/历史会话）'
      toolbar.appendChild(importBtn)
      const importFile = el('input', '')
      importFile.type = 'file'
      importFile.accept = '.har,.json,application/json'
      importFile.style.display = 'none'
      toolbar.appendChild(importFile)
      const refreshBtn = el('button', 'apv-btn', '刷新')
      toolbar.appendChild(refreshBtn)
      const clearBtn = el('button', 'apv-btn apv-btn-danger', '清空')
      toolbar.appendChild(clearBtn)
      const closeBtn = el('button', 'apv-btn apv-close', '×')
      closeBtn.title = '关闭'
      toolbar.appendChild(closeBtn)
      const moreBtn = el('button', 'apv-btn', '更多 ▾')
      moreBtn.title = '高级筛选 / 聚合视图 / 删除筛选集 / 自动捕获 / 日志路径'
      toolbar.appendChild(moreBtn)
      view.appendChild(toolbar)
      // 提示条：AI 分析包的结果（保存路径 + 复制按钮）、当前过滤器被别处删除等，留到用户关掉或下一条提示
      const noticeBar = el('div', 'apv-notice')
      noticeBar.hidden = true
      noticeBar.setAttribute('role', 'status')
      view.appendChild(noticeBar)

      // ---- P1 advanced filter bar + observability controls
      const filterBar = el('div', 'apv-filterbar')
      filterBar.hidden = true
      const fRow1 = el('div', 'apv-frow')
      const hostIn = el('input', 'apv-fin apv-fin-host')
      hostIn.placeholder = '域名(逗号分隔)'
      hostIn.spellcheck = false
      fRow1.appendChild(hostIn)
      const ctIn = el('input', 'apv-fin apv-fin-ct')
      ctIn.placeholder = 'Content-Type 含'
      ctIn.spellcheck = false
      fRow1.appendChild(ctIn)
      const minDurIn = el('input', 'apv-fin apv-fin-dur')
      minDurIn.type = 'number'
      minDurIn.placeholder = '慢请求ms'
      fRow1.appendChild(minDurIn)
      const minBytesIn = el('input', 'apv-fin apv-fin-dur')
      minBytesIn.type = 'number'
      minBytesIn.placeholder = '最小响应字节'
      fRow1.appendChild(minBytesIn)
      const maxBytesIn = el('input', 'apv-fin apv-fin-dur')
      maxBytesIn.type = 'number'
      maxBytesIn.placeholder = '最大响应字节'
      fRow1.appendChild(maxBytesIn)
      const fromIn = el('input', 'apv-fin apv-fin-dur')
      fromIn.type = 'datetime-local'
      fromIn.title = '开始时间'
      fRow1.appendChild(fromIn)
      const toIn = el('input', 'apv-fin apv-fin-dur')
      toIn.type = 'datetime-local'
      toIn.title = '结束时间'
      fRow1.appendChild(toIn)
      const bodyQIn = el('input', 'apv-fin apv-fin-body')
      bodyQIn.placeholder = '在请求/响应体中查找…'
      bodyQIn.spellcheck = false
      fRow1.appendChild(bodyQIn)
      filterBar.appendChild(fRow1)
      const fRow2 = el('div', 'apv-frow')
      const mkCb = (label, cb) => {
        const wrap = el('label', 'apv-fcb')
        wrap.appendChild(cb)
        wrap.appendChild(document.createTextNode(' ' + label))
        fRow2.appendChild(wrap)
        return cb
      }
      const errorsCb = mkCb('只看错误', el('input', ''))
      errorsCb.type = 'checkbox'
      const noiseCb = mkCb('隐藏噪音', el('input', ''))
      noiseCb.type = 'checkbox'
      const regexCb = mkCb('正则', el('input', ''))
      regexCb.type = 'checkbox'
      const aggBtn = el('button', 'apv-btn', '聚合视图')
      aggBtn.title = '按 方法+路径 聚合：次数/错误率/平均/P95 耗时'
      fRow2.appendChild(aggBtn)
      const treeBtn = el('button', 'apv-btn', '域名树')
      treeBtn.title = 'Fiddler 式分层：域名 → 路径段 → 单条请求；点请求行看详情。覆盖范围是上面那次列表请求（当前约 300 条），不是整库'
      fRow2.appendChild(treeBtn)
      const sessionBtn = el('button', 'apv-btn', '会话视图')
      sessionBtn.title = '按 sessionId/traceId/调用方时间窗查看请求会话'
      fRow2.appendChild(sessionBtn)
      const timelineBtn = el('button', 'apv-btn', '时间分析')
      timelineBtn.title = '查看请求量、错误率、吞吐和 P50/P95/P99 趋势'
      fRow2.appendChild(timelineBtn)
      const waterfallBtn = el('button', 'apv-btn', '瀑布图')
      waterfallBtn.title = '请求级时间瀑布：每个请求一条横线，绿色段=等待响应(TTFB)，蓝色段=传输；点击查看详情'
      fRow2.appendChild(waterfallBtn)
      const repeatsBtn = el('button', 'apv-btn', '重复检测')
      repeatsBtn.title = '高频重复请求检测：同一接口在时间窗内反复调用（定时器风暴）'
      fRow2.appendChild(repeatsBtn)
      const baselineBtn = el('button', 'apv-btn', '基线管理')
      baselineBtn.title = '把当前筛选的接口契约存为基线，之后一键对比响应结构/状态码/字段变化'
      fRow2.appendChild(baselineBtn)
      const delFilteredBtn = el('button', 'apv-btn apv-btn-danger', '删除筛选集')
      delFilteredBtn.title = '删除当前筛选条件命中的全部记录'
      fRow2.appendChild(delFilteredBtn)
      const savedSel = el('select', 'apv-select')
      savedSel.title = '已保存的筛选'
      fRow2.appendChild(savedSel)
      const saveFilterBtn = el('button', 'apv-btn', '保存筛选')
      fRow2.appendChild(saveFilterBtn)
      const delSavedBtn = el('button', 'apv-btn', '删除')
      delSavedBtn.title = '删除选中的已保存筛选'
      fRow2.appendChild(delSavedBtn)
      const clearFilterBtn = el('button', 'apv-btn', '清空条件')
      clearFilterBtn.title = '清空上方的筛选条件，不删除记录或已保存筛选；工具栏「过滤器」不受影响（用它旁边的 × 取消）'
      fRow2.appendChild(clearFilterBtn)
      filterBar.appendChild(fRow2)
      const fRow3 = el('div', 'apv-frow')
      const autoCapCb = mkCb('打开面板自动开始捕获', el('input', ''))
      autoCapCb.type = 'checkbox'
      const logPathIn = el('input', 'apv-fin apv-fin-body')
      logPathIn.placeholder = '跟踪日志路径（默认 %TEMP%\\uiprobe-net-trace.log）'
      logPathIn.spellcheck = false
      fRow3.appendChild(logPathIn)
      const healthHint = el('span', 'apv-note', '')
      fRow3.appendChild(healthHint)
      const clearLogsBtn = el('button', 'apv-btn apv-btn-danger', '清除日志')
      clearLogsBtn.title = '运行清理脚本：删除客户端跟踪日志（客户端运行时自动跳过）与抓包目录的日志文件'
      fRow3.appendChild(clearLogsBtn)
      const rotateBtn = el('button', 'apv-btn', '轮转日志')
      rotateBtn.title = '把当前跟踪/调用方日志改名归档（.bak）并按保留天数清理过期归档；捕获中会自动先停再启'
      fRow3.appendChild(rotateBtn)
      filterBar.appendChild(fRow3)
      const fRow4 = el('div', 'apv-frow')
      fRow4.appendChild(el('span', 'apv-note', '契约基线:'))
      const baselineSel = el('select', 'apv-select')
      baselineSel.title = '已保存的契约基线'
      fRow4.appendChild(baselineSel)
      const saveBaselineBtn = el('button', 'apv-btn', '保存基线')
      saveBaselineBtn.title = '把当前筛选命中的接口契约（状态码/Content-Type/响应字段结构）存为基线'
      fRow4.appendChild(saveBaselineBtn)
      const diffBaselineBtn = el('button', 'apv-btn', '对比')
      diffBaselineBtn.title = '用当前记录重新计算契约并与基线对比（新增/缺失端点、状态码与字段变化）'
      fRow4.appendChild(diffBaselineBtn)
      const delBaselineBtn = el('button', 'apv-btn apv-btn-danger', '删除基线')
      fRow4.appendChild(delBaselineBtn)
      filterBar.appendChild(fRow4)
      view.appendChild(filterBar)

      // ---- AutoResponder rules panel
      const rulesWrap = el('div', 'apv-agg')
      rulesWrap.hidden = true
      const RULES_HELP_TEXT = '规则按顺序匹配第一条生效，对「本地代理」和「透明拦截」进来的 HTTP(S) 流量起作用（不含 WebSocket 帧）。' +
        'mock=直接回包；Map Local=用本地文件回包（改文件即生效）；Map Remote=转发到另一个地址（换测试环境）；改写=在真实响应上改字段；' +
        '延迟=请求延迟（转发前等）+ 回包延迟（拿到真实响应后再等）± 抖动，可叠加限速；挂起=一直不回包让客户端自己超时；阻断=立即断开；重写状态=只改状态码。'
      // 规则集导出 / 导入（交给同事、留作备份）
      const rulesTopBar = el('div', 'apv-rules-head')
      rulesTopBar.appendChild(el('span', 'apv-t', '规则集'))
      const rulesExportBtn = el('button', 'apv-btn', '导出规则')
      rulesExportBtn.title = '把全部规则（含停用的）导出成 JSON 文件，交给同事导入或留作备份；不含命中次数'
      rulesTopBar.appendChild(rulesExportBtn)
      const rulesImportBtn = el('button', 'apv-btn', '导入规则')
      rulesImportBtn.title = '从导出的 JSON 文件导入规则：选「合并」加在最前面（跳过完全相同的），或「替换」现有规则'
      rulesTopBar.appendChild(rulesImportBtn)
      const rulesImportFile = el('input', '')
      rulesImportFile.type = 'file'
      rulesImportFile.accept = '.json,application/json'
      rulesImportFile.style.display = 'none'
      rulesTopBar.appendChild(rulesImportFile)
      const rulesImportChoice = el('span', 'apv-rules-choice')
      rulesImportChoice.hidden = true
      rulesTopBar.appendChild(rulesImportChoice)
      rulesWrap.appendChild(rulesTopBar)
      const rulesHelp = el('div', 'apv-note apv-rules-help', RULES_HELP_TEXT)
      rulesHelp.style.padding = '0 0 8px'
      rulesWrap.appendChild(rulesHelp)
      const rulesForm = el('div', 'apv-rules-form')
      const ruleNameIn = el('input', 'apv-fin')
      ruleNameIn.placeholder = '规则名称'
      ruleNameIn.style.width = '110px'
      rulesForm.appendChild(ruleNameIn)
      const ruleMethodSel = el('select', 'apv-select')
      ;['', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'].forEach((m) => {
        const opt = el('option', '', m === '' ? '方法:任意' : m)
        opt.value = m
        ruleMethodSel.appendChild(opt)
      })
      rulesForm.appendChild(ruleMethodSel)
      const ruleUrlIn = el('input', 'apv-fin')
      ruleUrlIn.placeholder = 'URL 匹配（子串 / 接口路径：完整 URL 或 /api/x / 通配* / 正则）'
      ruleUrlIn.title = '接口路径：写完整 URL（https://host/api/x，只匹配这个域名）或只写 /api/x（任何域名上的这个路径），都忽略查询参数；' +
        '包含 = URL 子串；通配用 *；正则不区分大小写。除「延迟」外，规则必须填 URL（留空会接管所有请求）。'
      ruleUrlIn.style.width = '200px'
      rulesForm.appendChild(ruleUrlIn)
      const ruleTypeSel = el('select', 'apv-select')
      ;[['contains', '包含'], ['path', '接口路径(完整URL或/路径，忽略参数)'], ['glob', '通配'], ['regex', '正则']].forEach(([t, label]) => {
        const opt = el('option', '', label)
        opt.value = t
        ruleTypeSel.appendChild(opt)
      })
      rulesForm.appendChild(ruleTypeSel)
      const RULE_ACTIONS = [
        ['mock', 'mock 回包'], ['map-local', 'Map Local 本地文件'], ['map-remote', 'Map Remote 转发'], ['rewrite', '改写真实响应'],
        ['delay', '延迟'], ['hang', '挂起(模拟超时)'], ['block', '阻断'], ['rewrite-status', '重写状态码'],
      ]
      const ruleActionSel = el('select', 'apv-select')
      RULE_ACTIONS.forEach(([a, label]) => {
        const opt = el('option', '', label)
        opt.value = a
        ruleActionSel.appendChild(opt)
      })
      rulesForm.appendChild(ruleActionSel)
      const ruleDelayIn = el('input', 'apv-fin apv-fin-dur')
      ruleDelayIn.type = 'number'
      ruleDelayIn.min = '0'
      ruleDelayIn.placeholder = '请求延迟ms'
      ruleDelayIn.title = '请求延迟：转发前（或本地回包前）等待的毫秒数；「挂起」时 = 挂起多久（默认 60000）'
      rulesForm.appendChild(ruleDelayIn)
      const ruleRespDelayIn = el('input', 'apv-fin apv-fin-dur')
      ruleRespDelayIn.type = 'number'
      ruleRespDelayIn.min = '0'
      ruleRespDelayIn.placeholder = '回包延迟ms'
      ruleRespDelayIn.title = '回包延迟：拿到真实响应（或生成 mock）后，再等这么久才发给客户端（Fiddler AutoResponder 的 Latency）'
      rulesForm.appendChild(ruleRespDelayIn)
      const ruleJitterIn = el('input', 'apv-fin apv-fin-dur')
      ruleJitterIn.type = 'number'
      ruleJitterIn.min = '0'
      ruleJitterIn.placeholder = '抖动±ms'
      ruleJitterIn.title = '抖动：请求延迟在 ± 这个范围内随机，模拟不稳定的网络'
      rulesForm.appendChild(ruleJitterIn)
      const ruleThrottleIn = el('input', 'apv-fin apv-fin-dur')
      ruleThrottleIn.type = 'number'
      ruleThrottleIn.min = '0'
      ruleThrottleIn.placeholder = '限速KB/s'
      ruleThrottleIn.title = '下行限速（KB/s，0=不限）：命中的响应按此速率下发，模拟弱网'
      rulesForm.appendChild(ruleThrottleIn)
      const ruleStatusIn = el('input', 'apv-fin apv-fin-dur')
      ruleStatusIn.type = 'number'
      ruleStatusIn.placeholder = '状态码'
      rulesForm.appendChild(ruleStatusIn)
      const ruleArgIn = el('input', 'apv-fin')
      ruleArgIn.style.width = '220px'
      ruleArgIn.spellcheck = false
      rulesForm.appendChild(ruleArgIn)
      const ruleBodyIn = el('textarea', 'apv-fin apv-rule-body')
      ruleBodyIn.spellcheck = false
      rulesForm.appendChild(ruleBodyIn)
      const ruleAddBtn = el('button', 'apv-btn', '添加规则')
      rulesForm.appendChild(ruleAddBtn)
      const ruleCancelBtn = el('button', 'apv-btn', '取消编辑')
      ruleCancelBtn.hidden = true
      rulesForm.appendChild(ruleCancelBtn)
      rulesWrap.appendChild(rulesForm)
      // 表单的提交方式：'add' 新增 / 'edit' 改一条（以原规则为底，C39）/
      // 'quick-original'（详情「Mock ▾ → 原响应」带进来的，提交时写成这个接口的一键规则并替换旧的，C38）。
      // ruleAddTemplate：要改的规则已被删掉时，表单转成「添加」，原规则里表单管不到的字段（限定域名、响应头…）作为模板带上。
      let ruleFormMode = 'add'
      let ruleAddTemplate = null
      /** 按动作切换"参数框/正文框"的含义与可见性，免得用户猜哪个框管什么。 */
      const REWRITE_PLACEHOLDER = '改写脚本（每行一条）：\nset data.list = []\ndel data.banner\nreplace 涨停 => 跌停\nstatus 500\nheader X-Mock: 1\nreq.header Authorization: xxx\nreq.query token = abc'
      const syncRuleForm = () => {
        const a = ruleActionSel.value
        const quick = ruleFormMode === 'quick-original'
        ruleArgIn.hidden = !(a === 'map-local' || a === 'map-remote')
        ruleArgIn.placeholder = a === 'map-local' ? '本地文件的完整路径（每次请求都重新读，改文件即生效）' : '目标地址（https://test-host 只换主机；带路径=整条替换）'
        ruleBodyIn.hidden = !(a === 'mock' || a === 'rewrite')
        ruleBodyIn.placeholder = a === 'rewrite' ? REWRITE_PLACEHOLDER : 'mock 响应体（JSON/文本）'
        ruleBodyIn.style.height = a === 'rewrite' ? '96px' : quick ? '160px' : ''
        ruleBodyIn.style.width = a === 'rewrite' ? '300px' : quick ? '420px' : ''
        ruleStatusIn.hidden = !(a === 'mock' || a === 'map-local' || a === 'rewrite-status')
        // 一键规则固定「接口路径 + mock」，一键接口只收 方法 / URL / 状态码 / 请求延迟 / 正文 / 名称，其余框不显示
        ruleRespDelayIn.hidden = quick || a === 'hang' || a === 'block'
        ruleThrottleIn.hidden = quick || a === 'hang' || a === 'block'
        ruleJitterIn.hidden = quick
        ruleTypeSel.disabled = quick
        ruleActionSel.disabled = quick
        ruleDelayIn.placeholder = a === 'hang' ? '挂起ms(默认60000)' : a === 'block' ? '多久后断开ms' : '请求延迟ms'
        ruleAddBtn.textContent = ruleFormMode === 'edit' ? '保存修改' : quick ? '生效（替换一键规则）' : '添加规则'
        ruleAddBtn.title = ruleFormMode === 'edit'
          ? '只改这一条规则；表单里看不到的字段（限定域名、响应头等）原样保留'
          : quick
            ? '按「方法 + 接口路径」写成这个接口的一键规则，放到最前面；这个接口原来的一键规则会被替换'
            : '写入规则集：插到最前面（规则按顺序匹配，先到先得），对正在运行的代理 / 透明拦截即时生效'
        ruleCancelBtn.hidden = ruleFormMode === 'add' && ruleAddTemplate === null
      }
      ruleActionSel.addEventListener('change', syncRuleForm)
      syncRuleForm()
      const rulesTable = el('table', 'apv-table apv-rules-table')
      const rulesHead = el('thead')
      const rulesHeadRow = el('tr')
      ;['启用', '名称', '匹配', '动作', '延迟', '状态/响应体', '命中', '操作'].forEach((h) => rulesHeadRow.appendChild(el('th', '', h)))
      rulesHead.appendChild(rulesHeadRow)
      rulesTable.appendChild(rulesHead)
      const rulesBodyEl = el('tbody')
      rulesTable.appendChild(rulesBodyEl)
      rulesWrap.appendChild(rulesTable)
      view.appendChild(rulesWrap)

      // ---- 请求断点面板
      const bpWrap = el('div', 'apv-agg')
      bpWrap.hidden = true
      bpWrap.appendChild(el('div', 'apv-note', '断点：启用后，命中（阶段 / 方法 / URL 子串 过滤）的「本地代理」与「透明拦截」请求会挂起等你处理。请求阶段=转发前改 方法/请求头/请求体；响应阶段=拿到真实响应后改 状态码/响应头/响应体（压缩自动解开）再发给客户端。120s 未处理自动放行。'))
      const bpForm = el('div', 'apv-rules-form')
      const bpEnableWrap = el('label', 'apv-autoscroll')
      const bpEnableCb = el('input', '')
      bpEnableCb.type = 'checkbox'
      bpEnableWrap.appendChild(bpEnableCb)
      bpEnableWrap.appendChild(document.createTextNode(' 启用断点'))
      bpForm.appendChild(bpEnableWrap)
      const bpMethodSel = el('select', 'apv-select')
      ;[['', '全部方法'], ['GET', 'GET'], ['POST', 'POST'], ['PUT', 'PUT'], ['DELETE', 'DELETE'], ['PATCH', 'PATCH']].forEach(([v, l]) => {
        const o = el('option', '', l)
        o.value = v
        bpMethodSel.appendChild(o)
      })
      bpForm.appendChild(bpMethodSel)
      const bpPhaseSel = el('select', 'apv-select')
      ;[['request', '请求阶段'], ['response', '响应阶段'], ['both', '请求+响应']].forEach(([v, l]) => {
        const o = el('option', '', l)
        o.value = v
        bpPhaseSel.appendChild(o)
      })
      bpPhaseSel.title = '在哪个阶段挂起：请求（转发前）/ 响应（拿到真实响应后、发给客户端前）/ 两者'
      bpForm.appendChild(bpPhaseSel)
      const bpUrlIn = el('input', 'apv-fin')
      bpUrlIn.placeholder = 'URL 包含…（空=全部）'
      bpForm.appendChild(bpUrlIn)
      const bpSaveBtn = el('button', 'apv-btn', '应用配置')
      bpForm.appendChild(bpSaveBtn)
      bpWrap.appendChild(bpForm)
      const bpPausedEl = el('div', 'apv-bp-paused')
      bpWrap.appendChild(bpPausedEl)
      view.appendChild(bpWrap)

      // ---- 透明拦截面板（hosts 重定向 + 反向代理）
      const icWrap = el('div', 'apv-agg')
      icWrap.hidden = true
      icWrap.appendChild(el('div', 'apv-note',
        '适用于在代码里强制直连、不认系统代理的客户端。启用后，把下面这些域名在系统 hosts 里指向本机回环地址，由本插件解密并转发到真实服务器（Fiddler 的「反向代理 + HOSTS」做法），' +
        '不改客户端代码、不装驱动；之后「代理规则 / 断点 / 延时」对这些域名全部生效。启用后**重启客户端**立即生效（否则等它的连接池自然轮换，约 2 分钟）。' +
        '安全措施：只改 hosts 里本插件自己那一段；重启电脑、或宿主退出后监听不在时，计划任务自动删掉这段；停用后排空约 150 秒再关监听，客户端不会断。' +
        '注意：hosts 对一个域名的**所有端口**生效 —— 这个域名上还有非 HTTP 的端口（如行情推送 TCP 长连接）时，要加一行 tcp://域名:端口 原样透传，否则会连不上。'))
      const icForm = el('div', 'apv-rules-form')
      const icHostsIn = el('textarea', 'apv-fin apv-rule-body')
      icHostsIn.placeholder = '要拦截的域名，每行一个：\napi.example.com（= 443 + 80）\nhttps://host:8443（非默认端口写全）\ntcp://host:9000（非 HTTP 端口原样透传）'
      icHostsIn.spellcheck = false
      icHostsIn.style.width = '320px'
      icHostsIn.style.height = '96px'
      icForm.appendChild(icHostsIn)
      const icBtnCol = el('div', 'apv-ic-btns')
      const icSuggestBtn = el('button', 'apv-btn', '从捕获记录填充')
      icSuggestBtn.title = '列出捕获库里出现过的域名：客户端自己的流量（实时捕获来源）排在前面并默认勾上；其它进程的域名标「非客户端流量」，不默认勾'
      const icStartBtn = el('button', 'apv-btn', '启用拦截')
      icStartBtn.title = '解析真实地址 → 起监听 → 最后改 hosts（顺序保证客户端不会被指向一个还没人应答的地址）'
      const icStopBtn = el('button', 'apv-btn apv-btn-danger', '停用拦截')
      icStopBtn.title = '先还原 hosts，再排空约 150 秒后关监听'
      const icCaBtn = el('button', 'apv-btn', '安装根证书')
      icCaBtn.title = '严格校验证书的请求（如量化接口）需要根证书被 Windows 信任；导入当前用户的受信任根（会弹系统确认框）'
      const icRefreshBtn = el('button', 'apv-btn', '刷新状态')
      for (const b of [icSuggestBtn, icStartBtn, icStopBtn, icCaBtn, icRefreshBtn]) icBtnCol.appendChild(b)
      icForm.appendChild(icBtnCol)
      icWrap.appendChild(icForm)
      const icSuggestEl = el('div', 'apv-ic-suggest')
      icWrap.appendChild(icSuggestEl)
      // 操作结果（启用 / 停用 / 装证书 的进度、成功、失败原因）单独一块：状态轮询只重画下面的 icStatusEl，
      // 不碰这里，结果一直留到下一次操作开始（C11）
      const icActionEl = el('div', 'apv-ic-action')
      icWrap.appendChild(icActionEl)
      const icStatusEl = el('div', 'apv-ic-status')
      icWrap.appendChild(icStatusEl)
      view.appendChild(icWrap)

      // ---- 全局延时 / 弱网面板
      const nsWrap = el('div', 'apv-agg')
      nsWrap.hidden = true
      nsWrap.appendChild(el('div', 'apv-note',
        '对经过本插件（本地代理 + 透明拦截）的请求统一加延时和限速，不用写规则（Fiddler「Rules → Performance → Simulate Modem Speeds」）。' +
        '请求延迟=转发前等；回包延迟=拿到响应后再等；抖动=请求延迟 ± 随机；限速单位 KB/s。参数会保存，但宿主重启后开关自动回到「关」。单个接口的延时在「代理规则」或详情里的「Mock ▾」设。'))
      const nsForm = el('div', 'apv-rules-form')
      const nsEnableWrap = el('label', 'apv-autoscroll')
      const nsEnableCb = el('input', '')
      nsEnableCb.type = 'checkbox'
      nsEnableWrap.appendChild(nsEnableCb)
      nsEnableWrap.appendChild(document.createTextNode(' 启用'))
      nsForm.appendChild(nsEnableWrap)
      const nsPresetSel = el('select', 'apv-select')
      nsPresetSel.title = '套用预设（会覆盖下面的数值）'
      nsForm.appendChild(nsPresetSel)
      const mkNum = (ph, title) => {
        const i = el('input', 'apv-fin apv-fin-dur')
        i.type = 'number'
        i.min = '0'
        i.placeholder = ph
        i.title = title
        nsForm.appendChild(i)
        return i
      }
      const nsReqIn = mkNum('请求延迟ms', '转发前等待')
      const nsResIn = mkNum('回包延迟ms', '拿到响应后再等')
      const nsJitIn = mkNum('抖动±ms', '请求延迟随机 ± 这么多')
      const nsDownIn = mkNum('下行KB/s', '下行限速（0=不限）')
      const nsUpIn = mkNum('上行KB/s', '上行限速（0=不限）')
      const nsScopeSel = el('select', 'apv-select')
      ;[['all', '全部流量'], ['intercept', '只透明拦截'], ['proxy', '只本地代理']].forEach(([v, l]) => {
        const o = el('option', '', l)
        o.value = v
        nsScopeSel.appendChild(o)
      })
      nsForm.appendChild(nsScopeSel)
      const nsHostsIn = el('input', 'apv-fin')
      nsHostsIn.placeholder = '只对这些域名（空=全部，支持 *.example.com）'
      nsHostsIn.style.width = '220px'
      nsForm.appendChild(nsHostsIn)
      const nsUrlIn = el('input', 'apv-fin')
      nsUrlIn.placeholder = 'URL 包含…（空=全部）'
      nsForm.appendChild(nsUrlIn)
      const nsApplyBtn = el('button', 'apv-btn', '应用')
      nsForm.appendChild(nsApplyBtn)
      nsWrap.appendChild(nsForm)
      const nsStatusEl = el('div', 'apv-note', '')
      nsWrap.appendChild(nsStatusEl)
      view.appendChild(nsWrap)

      // table
      const body = el('div', 'apv-body')
      const tableWrap = el('div', 'apv-table-wrap')
      const table = el('table', 'apv-table')
      const thead = el('thead')
      const headRow = el('tr')
      headRow.appendChild(el('th', '', '★'))
      ;['时间', '方法', '调用方', 'URL', '状态', '耗时', '来源', '备注'].forEach((h) => headRow.appendChild(el('th', '', h)))
      thead.appendChild(headRow)
      table.appendChild(thead)
      const tbody = el('tbody')
      table.appendChild(tbody)
      tableWrap.appendChild(table)
      body.appendChild(tableWrap)
      // ---- P1 aggregate view (observability)
      const aggWrap = el('div', 'apv-agg')
      aggWrap.hidden = true
      const aggTable = el('table', 'apv-table')
      const aggHead = el('thead')
      const aggHeadRow = el('tr')
      ;['端点', '次数', '错误率', '平均', 'P95', '最大', '最近状态', '样本 URL'].forEach((h) => aggHeadRow.appendChild(el('th', '', h)))
      aggHead.appendChild(aggHeadRow)
      aggTable.appendChild(aggHead)
      const aggBodyEl = el('tbody')
      aggTable.appendChild(aggBodyEl)
      aggWrap.appendChild(aggTable)
      body.appendChild(aggWrap)
      const sessionWrap = el('div', 'apv-agg')
      sessionWrap.hidden = true
      const sessionTable = el('table', 'apv-table')
      const sessionHead = el('thead')
      const sessionHeadRow = el('tr')
      ;['会话', '开始', '最近', '请求数', '错误', '响应字节', '方法', '域名'].forEach((h) => sessionHeadRow.appendChild(el('th', '', h)))
      sessionHead.appendChild(sessionHeadRow)
      sessionTable.appendChild(sessionHead)
      const sessionBodyEl = el('tbody')
      sessionTable.appendChild(sessionBodyEl)
      sessionWrap.appendChild(sessionTable)
      body.appendChild(sessionWrap)
      const timelineWrap = el('div', 'apv-agg')
      timelineWrap.hidden = true
      const timelineSummary = el('div', 'apv-timeline-summary')
      const timelineTitle = el('span', 'apv-timeline-title', '时间分桶明细')
      const timelineHelp = el('span', 'apv-timeline-help', '每一行统计该时间段内符合当前筛选条件的全部接口，不受列表分页影响。P50 是典型耗时，P95/P99 用来观察慢请求尾部。')
      timelineSummary.appendChild(timelineTitle)
      timelineSummary.appendChild(timelineHelp)
      timelineWrap.appendChild(timelineSummary)
      const timelineTable = el('table', 'apv-table apv-timeline-table')
      const timelineHead = el('thead')
      const timelineHeadRow = el('tr')
      ;[
        ['时间范围', '该行覆盖的完整时间段'],
        ['请求数', '该时间段内接口总数'],
        ['错误数', 'HTTP 400 及以上的请求数'],
        ['错误率', '错误数 ÷ 请求数'],
        ['响应总量', '所有响应 body 的字节数'],
        ['平均耗时', '该时间段请求耗时平均值'],
        ['P50 典型', '50% 请求不超过此耗时'],
        ['P95 较慢', '95% 请求不超过此耗时'],
        ['P99 极慢', '99% 请求不超过此耗时'],
      ].forEach(([label, title]) => {
        const th = el('th', '', label)
        th.title = title
        timelineHeadRow.appendChild(th)
      })
      timelineHead.appendChild(timelineHeadRow)
      timelineTable.appendChild(timelineHead)
      const timelineBodyEl = el('tbody')
      timelineTable.appendChild(timelineBodyEl)
      timelineWrap.appendChild(timelineTable)
      body.appendChild(timelineWrap)
      // ---- waterfall view (request-level timeline)
      const waterfallWrap = el('div', 'apv-agg')
      waterfallWrap.hidden = true
      const wfLegend = el('div', 'apv-wf-legend')
      wfLegend.appendChild(el('span', '', '横条位置=开始时间，长度=总耗时；'))
      wfLegend.appendChild(el('span', '', '分段: '))
      const leg1 = el('span', '')
      leg1.appendChild(el('i', 'apv-wf-total'))
      leg1.appendChild(document.createTextNode('传输/处理'))
      wfLegend.appendChild(leg1)
      const leg2 = el('span', '')
      leg2.appendChild(el('i', 'apv-wf-wait'))
      leg2.appendChild(document.createTextNode('等待响应(TTFB)'))
      wfLegend.appendChild(leg2)
       wfLegend.appendChild(el('span', 'apv-note', '代理记录的连接/TLS 分段见横条文字和详情；实时日志未提供 DNS 级耗时'))
      waterfallWrap.appendChild(wfLegend)
      const waterfallList = el('div', 'apv-wf')
      waterfallWrap.appendChild(waterfallList)
      body.appendChild(waterfallWrap)
      // ---- repeats view (timer-storm detection)
      const repeatsWrap = el('div', 'apv-agg')
      repeatsWrap.hidden = true
      const repeatsSummary = el('div', 'apv-timeline-summary')
      const repeatsTitle = el('span', 'apv-timeline-title', '高频重复请求检测')
      const repeatsHelp = el('span', 'apv-timeline-help', '同一「方法+路径」在 10 秒窗口内出现 ≥5 次即上榜（峰值速率=窗口内次数折算每分钟）。定时器风暴、循环拉取的典型特征。点击行过滤出该接口的全部记录。')
      repeatsSummary.appendChild(repeatsTitle)
      repeatsSummary.appendChild(repeatsHelp)
      repeatsWrap.appendChild(repeatsSummary)
      const repeatsTable = el('table', 'apv-table')
      const repeatsHead = el('thead')
      const repeatsHeadRow = el('tr')
      ;['接口', '总次数', '窗口内峰值', '峰值速率/分', '调用方', '最近状态', '首次', '最近'].forEach((h) => repeatsHeadRow.appendChild(el('th', '', h)))
      repeatsHead.appendChild(repeatsHeadRow)
      repeatsTable.appendChild(repeatsHead)
      const repeatsBodyEl = el('tbody')
      repeatsTable.appendChild(repeatsBodyEl)
      repeatsWrap.appendChild(repeatsTable)
      body.appendChild(repeatsWrap)
      // ---- baseline view (contract drift)
      const baselineWrap = el('div', 'apv-agg')
      baselineWrap.hidden = true
      const baselineSummary = el('div', 'apv-timeline-summary')
      const baselineTitle = el('span', 'apv-timeline-title', '契约基线对比')
      const baselineHelp = el('span', 'apv-timeline-help', '')
      baselineSummary.appendChild(baselineTitle)
      baselineSummary.appendChild(baselineHelp)
      baselineWrap.appendChild(baselineSummary)
      const baselineBodyEl = el('div')
      baselineWrap.appendChild(baselineBodyEl)
      body.appendChild(baselineWrap)
      // ---- P1-5 domain/path tree view (Fiddler-style)
      const treeWrap = el('div', 'apv-agg apv-tree')
      treeWrap.hidden = true
      body.appendChild(treeWrap)

      // detail drawer
      const detail = el('div', 'apv-detail')
      detail.hidden = true
      const detailResize = el('div', 'apv-detail-resize')
      detailResize.role = 'separator'
      detailResize.tabIndex = 0
      detailResize.title = '拖动调整详情区高度'
      detailResize.setAttribute('aria-label', '调整详情区高度')
      const detailHead = el('div', 'apv-detail-head')
      const detailTitle = el('span', 'apv-durl', '')
      const copyUrlBtn = el('button', 'apv-btn', '复制 URL')
      copyUrlBtn.title = '复制当前选中记录的 URL'
      const copyAsSel = el('select', 'apv-select')
      ;[['curl', 'cURL (bash)'], ['pwsh', 'Invoke-RestMethod'], ['fetch', 'fetch (JS)']].forEach(([v, label]) => {
        const opt = el('option', '', label)
        opt.value = v
        copyAsSel.appendChild(opt)
      })
      const copyAsBtn = el('button', 'apv-btn', '复制为')
      copyAsBtn.title = '按所选语言复制等价请求（cURL / PowerShell / fetch）'
      const replayBtn = el('button', 'apv-btn', '重放')
      replayBtn.title = '通过接口调试的服务端发送能力重新发送该请求，响应显示在下方对比'
      // 一键 Mock / 延时：按「方法 + 接口路径（忽略查询串）」插一条规则到最前面，同一接口再选会替换上一条
      const mockSel = el('select', 'apv-select')
      mockSel.title = '一键 Mock / 延时：作用于这个接口（方法 + 路径，忽略查询参数）；对本地代理与透明拦截的流量立即生效'
      ;[
        ['', 'Mock ▾'],
        ['empty-object', '返回空对象 {}'],
        ['empty-array', '返回空数组 []'],
        ['empty-lists', '保留外壳·清空所有数组'],
        ['original', '原响应 → 编辑后生效'],
        ['error-500', '返回 HTTP 500'],
        ['not-found', '返回 HTTP 404'],
        ['slow:1000', '延迟 1 秒后正常返回'],
        ['slow:3000', '延迟 3 秒后正常返回'],
        ['slow:5000', '延迟 5 秒后正常返回'],
        ['slow:10000', '延迟 10 秒后正常返回'],
        ['timeout:120000', '挂起不回包（客户端自己超时，最长 2 分钟）'],
        ['reset', '立即断开连接'],
        ['remove', '取消这个接口的一键规则'],
      ].forEach(([v, label]) => {
        const o = el('option', '', label)
        o.value = v
        mockSel.appendChild(o)
      })
      const mockHint = el('span', 'apv-mock-hint apv-note', '')
      const openPmBtn = el('button', 'apv-btn', '在接口调试打开')
      openPmBtn.title = '把该请求预填进「接口调试」面板'
      const setDiffABtn = el('button', 'apv-btn', '设为对比A')
      setDiffABtn.title = '把当前记录设为对比基准 A（再选另一条点「与A对比」并排 diff 请求/响应体）'
      const diffWithABtn = el('button', 'apv-btn', '与A对比')
      diffWithABtn.title = '把当前记录作为 B，与基准 A 并排 diff 请求体/响应体'
      diffWithABtn.disabled = true
      const locateSrcBtn = el('button', 'apv-btn', '定位源码')
      locateSrcBtn.title = '按调用方归因（ViewModel/API 方法）在客户端源码（环境变量 DSH_API_SRC_ROOT 指向的根目录）中查找定义，可一键在 VS Code 打开'
      locateSrcBtn.disabled = true
      const detailClose = el('button', 'apv-btn', '关闭')
      detailHead.appendChild(detailTitle)
      detailHead.appendChild(copyUrlBtn)
      detailHead.appendChild(copyAsSel)
      detailHead.appendChild(copyAsBtn)
      detailHead.appendChild(replayBtn)
      detailHead.appendChild(mockSel)
      detailHead.appendChild(mockHint)
      detailHead.appendChild(openPmBtn)
      detailHead.appendChild(setDiffABtn)
      detailHead.appendChild(diffWithABtn)
      detailHead.appendChild(locateSrcBtn)
      detailHead.appendChild(detailClose)
      const detailBar = el('div', 'apv-detail-bar')
      const bodySearch = el('input', 'apv-in')
      bodySearch.placeholder = '在详情 body 中查找… (Enter)'
      bodySearch.spellcheck = false
      detailBar.appendChild(bodySearch)
      const noteInput = el('input', 'apv-in apv-in-note')
      noteInput.placeholder = '备注…'
      detailBar.appendChild(noteInput)
      const tagInput = el('input', 'apv-in apv-in-tag')
      tagInput.placeholder = '标签…'
      detailBar.appendChild(tagInput)
      const saveNoteBtn = el('button', 'apv-btn', '保存')
      saveNoteBtn.title = '保存备注/标签到该记录'
      detailBar.appendChild(saveNoteBtn)
      const delRecordBtn = el('button', 'apv-btn apv-btn-danger', '删除该条')
      delRecordBtn.title = '删除当前选中的这条记录'
      detailBar.appendChild(delRecordBtn)
      detail.appendChild(detailResize)
      detail.appendChild(detailHead)
      detail.appendChild(detailBar)
      const detailMain = el('div', 'apv-detail-main')
      const detailBody = el('div', 'apv-detail-body')
      const sortPane = el('div', 'apv-sortpane')
      sortPane.hidden = true
      // 响应体与排序视图之间的分隔条：左右拖动调整排序视图宽度，双击恢复默认；跟着排序视图一起显示 / 隐藏
      const sortResize = el('div', 'apv-sort-resize')
      sortResize.hidden = true
      sortResize.role = 'separator'
      sortResize.tabIndex = 0
      sortResize.title = '拖动调整排序视图宽度（双击恢复默认）'
      sortResize.setAttribute('aria-label', '调整排序视图宽度')
      sortResize.setAttribute('aria-orientation', 'vertical')
      detailMain.appendChild(detailBody)
      detailMain.appendChild(sortResize)
      detailMain.appendChild(sortPane)
      detail.appendChild(detailMain)
      body.appendChild(detail)
      view.appendChild(body)
      let selectedUrl = ''
      let currentFull = null
      let bodyQuery = ''
      let selectedId = null // 详情打开的那一行：高亮标记 + 列表继续刷新时保持原位
      let renderedRecords = [] // 当前表格实际渲染的记录（供上下键选行）
      const bodySections = [] // {render(query)}

      // -------------------------------------------------------------- state
      const PREFS_KEY = 'dsh-apiviz.prefs'
      function loadPrefs() {
        try {
          return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {}
        } catch {
          return {}
        }
      }
      function savePrefs() {
        try {
          localStorage.setItem(PREFS_KEY, JSON.stringify({
            autoScroll: state.autoScroll,
            autoCapture: autoCapCb.checked,
            logPath: logPathIn.value.trim(),
            savedFilters: state.savedFilters,
            detailHeight: state.detailHeight,
            sortWidth: state.sortWidth,
            // 当前启用的过滤器：id 为准，快照用来在宿主的列表回来之前先按它查
            activeFilterId: state.activeFilter !== null ? state.activeFilter.id : null,
            activeFilter: state.activeFilter,
            aiBodyLimit: aiBodySel.value,
            aiLimit: aiLimitIn.value,
          }))
        } catch {
          // storage unavailable
        }
      }
      const initialPrefs = loadPrefs()

      const state = {
        open: false,
        q: '',
        method: '',
        status: '',
        source: '',
        flagged: false,
        host: '',
        ct: '',
        minDur: '',
        minBytes: '',
        maxBytes: '',
        fromTs: '',
        toTs: '',
        sessionId: '',
        detailHeight: Number.isFinite(Number(initialPrefs.detailHeight)) ? Number(initialPrefs.detailHeight) : null,
        // 排序视图宽度：占详情区宽度的百分比（窗口缩放时比例不变）；null = 默认 42%
        sortWidth: initialPrefs.sortWidth !== null && Number.isFinite(Number(initialPrefs.sortWidth)) && Number(initialPrefs.sortWidth) > 0 && Number(initialPrefs.sortWidth) < 100
          ? Number(initialPrefs.sortWidth)
          : null,
        errorsOnly: false,
        noNoise: false,
        regex: false,
        bodyQ: '',
        aggView: false,
        sessionView: false,
        timelineView: false,
        waterfallView: false,
        repeatsView: false,
        baselineView: false,
        baselineName: '',
        baselineReport: null,
        savedFilters: Array.isArray(initialPrefs.savedFilters) ? initialPrefs.savedFilters : [],
        // 当前启用的过滤器（Fiddler 式自定义过滤器）：和上面所有筛选 AND
        activeFilter: initialPrefs.activeFilter !== null && typeof initialPrefs.activeFilter === 'object' && initialPrefs.activeFilter.id === initialPrefs.activeFilterId
          ? activeFilterSnapshot(initialPrefs.activeFilter)
          : null,
        timer: null,
        lastRenderKey: '',
        capture: { running: false, status: null, staleCount: 0, prevLogSize: null },
        proxy: { running: false, status: null },
        autoScroll: initialPrefs.autoScroll !== false,
        frozen: false,
      }

      const setDetailHeight = (height, persist = true) => {
        const bodyRect = body.getBoundingClientRect()
        const min = 180
        const max = Math.max(min, bodyRect.height - 140)
        const next = Math.round(Math.max(min, Math.min(max, Number(height))))
        if (!Number.isFinite(next)) return
        state.detailHeight = next
        detail.style.setProperty('--apv-detail-height', `${next}px`)
        if (persist) savePrefs()
      }

      if (state.detailHeight !== null) detail.style.setProperty('--apv-detail-height', `${state.detailHeight}px`)

      let resizeDrag = null
      detailResize.addEventListener('pointerdown', (event) => {
        if (detail.hidden) return
        event.preventDefault()
        detailResize.setPointerCapture?.(event.pointerId)
        resizeDrag = { startY: event.clientY, startHeight: detail.getBoundingClientRect().height }
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'ns-resize'
      })
      detailResize.addEventListener('pointermove', (event) => {
        if (resizeDrag === null) return
        setDetailHeight(resizeDrag.startHeight + resizeDrag.startY - event.clientY, false)
      })
      const finishResize = () => {
        if (resizeDrag === null) return
        resizeDrag = null
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        savePrefs()
      }
      detailResize.addEventListener('pointerup', finishResize)
      detailResize.addEventListener('pointercancel', finishResize)
      detailResize.addEventListener('keydown', (event) => {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const current = detail.getBoundingClientRect().height
        if (event.key === 'ArrowUp') setDetailHeight(current + 24)
        else if (event.key === 'ArrowDown') setDetailHeight(current - 24)
        else if (event.key === 'Home') setDetailHeight(180)
        else setDetailHeight(body.getBoundingClientRect().height - 140)
      })

      // ---------------- 排序视图宽度（分隔条左右拖动）
      /** 排序视图至少 240px；左边的响应体至少留 200px。 */
      const SORT_MIN_PX = 240
      const SORT_BODY_MIN_PX = 200
      const applySortWidth = () => {
        if (state.sortWidth === null) detailMain.style.removeProperty('--apv-sort-width')
        else detailMain.style.setProperty('--apv-sort-width', `${state.sortWidth}%`)
      }
      /** 按像素宽度设置并夹在范围内，存成百分比；详情区还没排版（宽度 0）时不动。 */
      const setSortWidth = (px, persist = true) => {
        const total = detailMain.getBoundingClientRect().width
        if (!(total > 0) || Number.isNaN(Number(px))) return
        const max = Math.max(SORT_MIN_PX, total - SORT_BODY_MIN_PX - sortResize.getBoundingClientRect().width)
        const next = Math.max(SORT_MIN_PX, Math.min(max, Number(px)))
        state.sortWidth = Math.round((next / total) * 1000) / 10
        applySortWidth()
        if (persist) savePrefs()
      }
      applySortWidth()

      let sortDrag = null
      sortResize.addEventListener('pointerdown', (event) => {
        if (sortPane.hidden) return
        event.preventDefault()
        sortResize.setPointerCapture?.(event.pointerId)
        sortDrag = { startX: event.clientX, startWidth: sortPane.getBoundingClientRect().width }
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'ew-resize'
      })
      sortResize.addEventListener('pointermove', (event) => {
        if (sortDrag === null) return
        // 分隔条往左拖 = 排序视图变宽
        setSortWidth(sortDrag.startWidth + sortDrag.startX - event.clientX, false)
      })
      const finishSortResize = () => {
        if (sortDrag === null) return
        sortDrag = null
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        savePrefs()
      }
      sortResize.addEventListener('pointerup', finishSortResize)
      sortResize.addEventListener('pointercancel', finishSortResize)
      sortResize.addEventListener('dblclick', () => {
        state.sortWidth = null
        applySortWidth()
        savePrefs()
      })
      sortResize.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const current = sortPane.getBoundingClientRect().width
        if (event.key === 'ArrowLeft') setSortWidth(current + 24)
        else if (event.key === 'ArrowRight') setSortWidth(current - 24)
        else if (event.key === 'Home') setSortWidth(SORT_MIN_PX)
        else setSortWidth(Infinity)
      })

      // ---------------- oversized-JSON folding
      // 格式化后的响应体可能有 MB 级（单个 `lines` 净值数组就能 900KB+）。一次性全量布局会把
      // 面板冻住，所以超大的块只渲染一行存根，点开时才构建内容，且只构建这一层。

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
       * lines[from..to) 里最外层那些值得折叠的 [open, close] 行区间：元素过多的数组，以及跨行
       * 过多的块。元素数来自一趟缩进感知的扫描，所以 900KB 的 body 仍是 O(lines)，而且持有巨大
       * 数组的对象（data: {list: [...60000 行]}）自己不会被折叠。嵌套命中会被丢掉 —— 展开存根
       * 时会重新分析它自己的内容，所以一次点击永远不会把全部铺开。
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
        // 片段之间补换行：存根保持行内元素，断行只靠真实 "\n"，这样复制出来的还是完整 JSON
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
        const stub = el('span', 'apv-fold', summary)
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

      /**
       * 把格式化 JSON 渲染进 container：超大的块折叠。没有任何大块时退回普通 pre（等价于
       * highlightedPre 在空搜索词下的快速路径），保持既有观感不变。
       */
      function renderFoldableJson(container, pretty) {
        const lines = pretty.split('\n')
        const pre = el('pre', 'apv-sec-pre')
        const top = foldRanges(lines, 0, lines.length)
        const wholeBody = top.length === 1 && top[0].open === 0 && top[0].close === lines.length - 1
        if (top.length === 0) {
          pre.textContent = pretty
        } else if (wholeBody) {
          // 顶层块永不折叠（否则整个 body 塌成一行），但它内部的大块照塌
          pre.appendChild(document.createTextNode(lines[0] + '\n'))
          appendFoldRange(pre, lines, 1, lines.length - 2)
          pre.appendChild(document.createTextNode('\n' + lines[lines.length - 1]))
        } else {
          appendFoldRange(pre, lines, 0, lines.length - 1)
        }
        container.appendChild(pre)
      }

      // ---------------- P0-3 body multi-view sections

      function detectBodyKind(text, contentType) {
        const ct = String(contentType ?? '').toLowerCase()
        if (text.startsWith('base64:')) {
          const semi = text.indexOf(';', 7)
          return { kind: 'base64', mime: semi > 0 ? text.slice(7, semi) : 'application/octet-stream', data: semi > 0 ? text.slice(semi + 1) : text.slice(7) }
        }
        if (text.startsWith('hex:')) return { kind: 'hex', data: text.slice(4) }
        if (ct.includes('image/')) return { kind: 'image', mime: ct.split(';')[0].trim() }
        if (ct.includes('html')) return { kind: 'html' }
        if (ct.includes('json') || /^\s*[[{]/.test(text)) return { kind: 'json' }
        if (ct.includes('xml')) return { kind: 'xml' }
        return { kind: 'text' }
      }

      function hexDumpText(s) {
        const bytes = []
        for (let i = 0; i < s.length; i += 2) {
          const b = Number.parseInt(s.slice(i, i + 2), 16)
          if (!Number.isNaN(b)) bytes.push(b)
        }
        return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ')
      }

      /** Build one body section with Pretty/Raw/树/预览/图片 views; returns re-render fn. */
      function makeBodySection(title, text, contentType, parent) {
        const info = detectBodyKind(text, contentType)
        const truncated = text.endsWith('…(截断)')
        const sec = el('div', 'apv-sec')
        const secTitle = el('div', 'apv-sec-title')
        secTitle.appendChild(el('span', 'apv-t', title + (truncated ? ' (已截断)' : '')))
        const viewBtns = el('div', 'apv-viewbtns')
        secTitle.appendChild(viewBtns)
        const container = el('div', 'apv-sec-body')
        sec.appendChild(secTitle)
        sec.appendChild(container)
        parent.appendChild(sec)

        const base = () => (truncated ? text.slice(0, -5) : text)
        let mode
        if (info.kind === 'json') mode = 'pretty'
        else if (info.kind === 'base64' || info.kind === 'image') mode = 'image'
        else if (info.kind === 'hex') mode = 'hex'
        else mode = 'raw'

        const setMode = (m) => {
          mode = m
          for (const b of viewBtns.children) {
            if (b.dataset.mode === m) b.classList.add('apv-btn-on')
            else b.classList.remove('apv-btn-on')
          }
          render()
        }
        const addBtn = (label, m) => {
          const b = el('button', 'apv-btn', label)
          b.dataset.mode = m
          b.addEventListener('click', () => setMode(m))
          viewBtns.appendChild(b)
        }
        if (info.kind === 'json') {
          addBtn('Pretty', 'pretty')
          addBtn('Raw', 'raw')
          addBtn('树', 'tree')
        } else if (info.kind === 'base64' || info.kind === 'image') {
          addBtn('图片', 'image')
          addBtn('Raw', 'raw')
        } else if (info.kind === 'hex') {
          addBtn('十六进制', 'hex')
          addBtn('Raw', 'raw')
        } else if (info.kind === 'html') {
          addBtn('Raw', 'raw')
          addBtn('预览', 'preview')
        } else {
          addBtn('Raw', 'raw')
        }

        const render = () => {
          container.textContent = ''
          const t = base()
          if (mode === 'raw') {
            container.appendChild(highlightedPre(text, bodyQuery))
          } else if (mode === 'pretty') {
            let pretty = null
            try {
              pretty = JSON.stringify(JSON.parse(t), null, 2)
            } catch {
              pretty = null
            }
            // 有搜索词时保留原来的整段高亮渲染（折叠会把行拆成节点，没法再对整段做高亮）
            if (pretty === null || bodyQuery.trim() !== '') {
              container.appendChild(highlightedPre(pretty ?? (/^\s*[[{]/.test(t) ? prettyJsonFragment(t) : text), bodyQuery))
            } else {
              renderFoldableJson(container, pretty)
            }
          } else if (mode === 'tree') {
            try {
              container.appendChild(jsonTreeEl(JSON.parse(t)))
            } catch {
              container.appendChild(highlightedPre('(JSON 不完整，无法建树，请切到 Pretty)', bodyQuery))
            }
          } else if (mode === 'image') {
            const img = el('img', 'apv-img')
            img.alt = '响应图片'
            img.src = info.kind === 'base64' ? `data:${info.mime};base64,${info.data}` : text
            container.appendChild(img)
          } else if (mode === 'preview') {
            const frame = el('iframe', 'apv-iframe')
            frame.sandbox = ''
            frame.srcdoc = t
            container.appendChild(frame)
          } else if (mode === 'hex') {
            container.appendChild(highlightedPre(info.kind === 'hex' ? hexDumpText(info.data) : 'hex: (无内容)', bodyQuery))
          }
        }
        setMode(mode)
        return render
      }

      /**
       * Meta/headers pre section (no body views). collapsed=true 时默认收起成一整行、点标题展开，
       * 让详情面板的空间留给响应体 JSON；默认（false）保持原来的直接展开。
       */
      function makePreSection(title, content, collapsed = false) {
        const sec = el('div', 'apv-sec')
        const secTitle = el('div', 'apv-sec-title')
        const label = el('span', 'apv-t', title)
        secTitle.appendChild(label)
        sec.appendChild(secTitle)
        const pre = highlightedPre(content, '')
        sec.appendChild(pre)
        if (!collapsed) return sec
        const hint = el('span', 'apv-fold-hint')
        secTitle.appendChild(hint)
        secTitle.classList.add('apv-sec-title-fold')
        secTitle.title = '点击展开 / 收起'
        let open = false
        const sync = () => {
          pre.hidden = !open
          label.textContent = (open ? '▾ ' : '▸ ') + title
          hint.textContent = open ? '' : `已收起 · ${content.length} 字符`
        }
        secTitle.addEventListener('click', () => {
          open = !open
          sync()
        })
        sync()
        return sec
      }

      /** 源码定位结果：文件命中列表 + 打开按钮。 */
      function renderSourceHits(result, caller) {
        const sec = el('div', 'apv-sec')
        const secTitle = el('div', 'apv-sec-title')
        secTitle.appendChild(el('span', 'apv-t', '定位源码'))
        sec.appendChild(secTitle)
        const files = result?.files ?? []
        if (files.length === 0) {
          sec.appendChild(el('div', 'apv-note', `在 ${(result?.roots ?? []).join('; ') || '源码根'} 下未找到 ${caller.viewModel || caller.apiMethod || ''} 的定义（已扫 ${result?.searched ?? 0} 个文件）`))
          return sec
        }
        for (const hit of files) {
          const row = el('div', 'apv-src-hit')
          const pathEl = el('span', 'apv-src-path', `${hit.path}${hit.matches.length > 0 ? ' :' + hit.matches[0].line : ''}`)
          pathEl.title = hit.path + hit.matches.map((m) => `\nL${m.line} ${m.what}`).join('')
          row.appendChild(pathEl)
          const openBtn = el('button', 'apv-btn', '打开')
          openBtn.style.padding = '2px 8px'
          openBtn.style.fontSize = '11px'
          openBtn.title = '在 VS Code 打开（带行号），失败则用资源管理器定位'
          openBtn.addEventListener('click', () => {
            openBtn.disabled = true
            apiFetch('/source/open', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: hit.path, line: hit.matches.length > 0 ? hit.matches[0].line : 1 }),
            })
              .catch((error) => console.error('[dsh-api-visualizer] source open failed:', error))
              .finally(() => {
                openBtn.disabled = false
              })
          })
          row.appendChild(openBtn)
          sec.appendChild(row)
        }
        return sec
      }

      let replayWrap = null

      // -------- 两条记录并排 body diff（设 A → 选 B → 与A对比）
      let diffBaseRecord = null
      const shortUrlText = (u) => { try { return new URL(u).pathname } catch { return String(u ?? '').slice(0, 48) } }
      const updateDiffButtons = () => {
        setDiffABtn.textContent = diffBaseRecord !== null ? '对比A ✓' : '设为对比A'
        diffWithABtn.disabled = diffBaseRecord === null || currentFull === null || (diffBaseRecord !== null && currentFull !== null && diffBaseRecord.id === currentFull.id)
      }
      const bodyTextOf = (rec, which) => {
        const raw = which === 'req' ? rec.reqBody : rec.resBody
        if (typeof raw !== 'string' || raw === '') return ''
        return formatBody(raw) ?? raw
      }
      // 行级 LCS diff（并排对齐）；大文本截断到前 1500 行，避免 O(n*m) 爆炸
      const lineDiffPairs = (aText, bText) => {
        const CAP = 1500
        let a = String(aText ?? '').split('\n')
        let b = String(bText ?? '').split('\n')
        const truncated = a.length > CAP || b.length > CAP
        if (a.length > CAP) a = a.slice(0, CAP)
        if (b.length > CAP) b = b.slice(0, CAP)
        const n = a.length, m = b.length
        const dp = []
        for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
        for (let i = n - 1; i >= 0; i--) {
          for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
          }
        }
        const pairs = []
        let i = 0, j = 0
        while (i < n && j < m) {
          if (a[i] === b[j]) { pairs.push({ a: a[i], b: b[j], type: 'same' }); i++; j++ }
          else if (dp[i + 1][j] >= dp[i][j + 1]) { pairs.push({ a: a[i], b: null, type: 'del' }); i++ }
          else { pairs.push({ a: null, b: b[j], type: 'ins' }); j++ }
        }
        while (i < n) { pairs.push({ a: a[i], b: null, type: 'del' }); i++ }
        while (j < m) { pairs.push({ a: null, b: b[j], type: 'ins' }); j++ }
        return { pairs, truncated }
      }
      const renderDiffPair = (title, aText, bText) => {
        const sec = el('div', 'apv-sec')
        sec.appendChild(el('div', 'apv-sec-title', title))
        if (aText === '' && bText === '') { sec.appendChild(el('div', 'apv-note', '两侧均无内容')); return sec }
        const { pairs, truncated } = lineDiffPairs(aText, bText)
        const changed = pairs.filter((p) => p.type !== 'same').length
        if (changed === 0) { sec.appendChild(el('div', 'apv-note', '无差异')); return sec }
        const table = el('table', 'apv-difftable')
        for (const p of pairs) {
          const tr = el('tr')
          const la = el('td', 'apv-diff-a' + (p.type === 'del' ? ' apv-diff-del' : p.type === 'ins' ? ' apv-diff-blank' : ''))
          la.textContent = p.a ?? ''
          const lb = el('td', 'apv-diff-b' + (p.type === 'ins' ? ' apv-diff-ins' : p.type === 'del' ? ' apv-diff-blank' : ''))
          lb.textContent = p.b ?? ''
          tr.appendChild(la)
          tr.appendChild(lb)
          table.appendChild(tr)
        }
        sec.appendChild(table)
        if (truncated) sec.appendChild(el('div', 'apv-note', '（内容过长，diff 已截断到前 1500 行）'))
        return sec
      }
      const renderRecordDiff = (a, b) => {
        detailBody.querySelectorAll('.apv-diffwrap').forEach((n) => n.remove())
        const wrap = el('div', 'apv-sec apv-diffwrap')
        wrap.appendChild(el('div', 'apv-sec-title', `对比  A: ${a.method} ${shortUrlText(a.url)}   ⇄   B: ${b.method} ${shortUrlText(b.url)}`))
        wrap.appendChild(renderDiffPair('请求体 diff（左 A · 右 B）', bodyTextOf(a, 'req'), bodyTextOf(b, 'req')))
        wrap.appendChild(renderDiffPair('响应体 diff（左 A · 右 B）', bodyTextOf(a, 'res'), bodyTextOf(b, 'res')))
        detailBody.insertBefore(wrap, detailBody.firstChild)
      }
      setDiffABtn.addEventListener('click', () => { if (currentFull !== null) { diffBaseRecord = currentFull; updateDiffButtons() } })
      diffWithABtn.addEventListener('click', () => {
        if (diffBaseRecord === null || currentFull === null || diffBaseRecord.id === currentFull.id) return
        renderRecordDiff(diffBaseRecord, currentFull)
      })

      // ---------------- 排序视图（详情右侧面板）
      // 列表型 JSON 响应（如榜单接口的 data.list）只读原始 JSON 看不出排序，这一栏用表格给出
      // 「第几名、叫什么、各字段多少」。顺序恒为**接口返回顺序**：不重排（客户端榜单的既定口径
      // 就是「排序由后端定、客户端不排序」），后端置顶的行会被标记出来，免得看起来像排错了。
      // 列 = 行对象的**全部字段**，按接口字段顺序；「顺序」和名称两列冻结在左侧，横向滚动时不丢行。

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

      /** 表格最多渲染多少行：几千行的响应只铺前 N 行，避免把面板卡住。 */
      const SORT_ROWS_CAP = 300

      /** 最多铺多少个字段（列）：再多只铺前 N 个并写明，免得几百列把面板卡住。 */
      const SORT_COLS_CAP = 150

      /** 单元格 / 名称格最多显示多少字，更长的截断；完整内容（上限 SORT_TITLE_CHARS 字）放在悬停提示里。 */
      const SORT_CELL_CHARS = 60
      const SORT_NAME_CHARS = 24
      const SORT_TITLE_CHARS = 2000

      /**
       * 字段名有没有比率语义：按驼峰、下划线、数字切词，某个词以 rate / yield / ratio / return /
       * percent / pct 结尾才算（yearYieldRate、changerate5day、volratio、pct_chg 算；generatedTime
       * 词中间的 rate 不算）。只用来挑加粗的排序值列。数字一律按接口原值显示、不换算：
       * 同样叫 rate，有的接口给小数（0.0125），有的已经是百分数（1.25 表示 +1.25%），乘 100 只会显示错。
       */
      function isRateKey(key) {
        return key
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .split(/[^a-z]+/)
          .some((word) => /(rate|yield|ratio|return|percent|pct)$/.test(word))
      }

      /** 文本百分比（`+53.44%`）：原样返回，用来认排序值列。 */
      function percentText(value) {
        return typeof value === 'string' && /^[+-]?\d+(\.\d+)?%$/.test(value.trim()) ? value.trim() : null
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

      /** 行集里的一项是不是普通对象（null、数字、数组都不算一行）。 */
      const isPlainRow = (row) => row !== null && typeof row === 'object' && !Array.isArray(row)

      /**
       * 名称列：先认名字类字段（name / title / label，或以 name 结尾，如 stockName、strategyName），
       * 再认代码类（symbol，或以 code 结尾，如 code、stockCode）。都认不出就不放名称列，
       * 不再拿第一个短字符串（例如某个状态字段的 "0"）冒充名称。
       */
      function pickNameKey(rows, keys) {
        const sample = rows.slice(0, 20).filter(isPlainRow)
        const hasText = (k) => sample.some((row) => typeof row[k] === 'string' && row[k] !== '')
        const hasCode = (k) => hasText(k) || sample.some((row) => typeof row[k] === 'number' && Number.isFinite(row[k]))
        return keys.find((k) => /^(title|label)$|name$/i.test(k) && hasText(k))
          ?? keys.find((k) => /^symbol$|code$/i.test(k) && hasCode(k))
          ?? null
      }

      /** 加粗的「排序值」列，口径沿用旧版：第一个数值型的比率字段；没有就取第一个百分比文本字段。 */
      function pickKeyColumn(rows, columns) {
        const sample = rows.slice(0, 20).filter(isPlainRow)
        const candidates = columns.filter((k) => !/id$/i.test(k))
        return candidates.find((k) => isRateKey(k) && sample.some((row) => typeof row[k] === 'number' && Number.isFinite(row[k])))
          ?? candidates.find((k) => sample.some((row) => percentText(row[k]) !== null))
          ?? null
      }

      /** 这一列按文本左对齐：非空值里不像数字的多于像数字的（"+1.25%"、"12.5万"、"3天" 都算像数字）。 */
      function isTextColumn(rows, key) {
        let numeric = 0
        let text = 0
        for (const row of rows.slice(0, 50)) {
          if (!isPlainRow(row)) continue
          const value = row[key]
          if (value === undefined || value === null || value === '') continue
          if ((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^\s*[+-]?\.?\d/.test(value))) numeric += 1
          else text += 1
        }
        return text > numeric
      }

      /**
       * 行集 → 列模型：行对象的**全部字段**，按接口字段顺序（取前 SORT_ROWS_CAP 行出现过的字段，
       * 各行字段不齐也不漏）。名称列冻结在最左侧，不在后面重复。
       */
      function buildSortColumns(rows) {
        const shown = rows.slice(0, SORT_ROWS_CAP)
        const seen = new Set()
        const keys = []
        for (const row of shown) {
          if (!isPlainRow(row)) continue
          for (const k of Object.keys(row)) {
            if (seen.has(k)) continue
            seen.add(k)
            keys.push(k)
          }
        }
        if (keys.length === 0) return null
        const nameKey = pickNameKey(shown, keys)
        const columns = keys.filter((k) => k !== nameKey).slice(0, SORT_COLS_CAP)
        return {
          nameKey,
          columns,
          keyColumn: pickKeyColumn(shown, columns),
          textColumns: new Set(columns.filter((k) => isTextColumn(shown, k))),
          fieldCount: keys.length,
          shownFieldCount: columns.length + (nameKey === null ? 0 : 1),
        }
      }

      /** 行上的置顶标记：后端把「精选 / 已订阅」排在最前，标出来才不会看着像排序坏了。 */
      function sortRowTags(row) {
        const tags = []
        if (typeof row.handpick === 'string' && row.handpick !== '') tags.push(row.handpick)
        if (row.isSubscribed === true) tags.push('已订阅')
        return tags
      }

      /** 截断过长的文本；完整内容（上限 SORT_TITLE_CHARS 字）给悬停提示，没截断时 title 为空。 */
      function clipCell(text, max) {
        if (text.length <= max) return { text, title: '' }
        return { text: `${text.slice(0, max)}…`, title: text.length > SORT_TITLE_CHARS ? `${text.slice(0, SORT_TITLE_CHARS)}…` : text }
      }

      /**
       * 单元格如实显示接口给的值：这一行没有该字段就留空，null 和空字符串用淡色写出来，
       * 对象和数组显示紧凑 JSON，数字和文本都按原值显示（不换算百分比，见 isRateKey 的说明）。
       */
      function sortCell(row, key) {
        if (!Object.prototype.hasOwnProperty.call(row, key)) return { text: '', title: `这一行没有 ${key} 字段`, dim: true }
        const value = row[key]
        if (value === null) return { text: 'null', title: '', dim: true }
        if (value === '') return { text: '""', title: '空字符串', dim: true }
        if (typeof value === 'string') return { ...clipCell(value, SORT_CELL_CHARS), dim: false }
        if (typeof value === 'number' || typeof value === 'boolean') return { text: String(value), title: '', dim: false }
        return { ...clipCell(JSON.stringify(value), SORT_CELL_CHARS), dim: false }
      }

      /** 名称列冻结在「顺序」列右边，left 要跟着「顺序」列的实际宽度走：表格换掉时停掉旧的观察。 */
      let sortPinObserver = null

      const clearSortPane = () => {
        if (sortPinObserver !== null) {
          sortPinObserver.disconnect()
          sortPinObserver = null
        }
        sortPane.textContent = ''
        sortPane.hidden = true
        sortResize.hidden = true
      }

      function renderSortPane(full) {
        clearSortPane()
        const text = typeof full.resBody === 'string' ? full.resBody : ''
        // 截断的 body 无法整体解析，如实不显示（与响应体区块「已截断」口径一致）
        if (text === '' || text.endsWith('…(截断)')) return
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          return
        }
        const rows = pickListRows(json)
        if (rows === null) return
        const model = buildSortColumns(rows)
        if (model === null) return
        const params = sortParamsOf(full.url)

        const head = el('div', 'apv-sort-head')
        head.appendChild(el('div', 'apv-t', `排序视图 · 共 ${rows.length} 行 · ${model.fieldCount} 个字段`))
        const basis = ['顺序 = 接口返回顺序（未重排）', '列 = 全部字段（接口字段顺序）']
        if (params.field !== null) basis.push(`sortField=${params.field}${params.period === null ? '' : `(${params.period})`}`)
        if (params.dir !== null) basis.push(`sortType=${params.dir}`)
        head.appendChild(el('div', '', basis.join(' · ')))
        sortPane.appendChild(head)

        const scroll = el('div', 'apv-sort-scroll')
        const table = el('table', 'apv-sort-table')
        const headRow = el('tr')
        const rankClass = model.nameKey === null ? 'apv-sort-rank apv-sort-pin apv-sort-pin-last' : 'apv-sort-rank apv-sort-pin'
        const rankTh = el('th', rankClass, '顺序')
        headRow.appendChild(rankTh)
        if (model.nameKey !== null) {
          const nameTh = el('th', 'apv-sort-name apv-sort-pin apv-sort-pin-last', SORT_NAME_LABELS[model.nameKey] ?? model.nameKey)
          nameTh.title = `${model.nameKey}（名称列，冻结在左侧）`
          headRow.appendChild(nameTh)
        }
        for (const key of model.columns) {
          const th = el('th', model.textColumns.has(key) ? 'apv-sort-txt' : '', key === 'sortYieldRate' && params.period !== null ? `sort(${params.period})` : SORT_COLUMN_LABELS[key] ?? key)
          th.dataset.key = key
          th.title = key === model.keyColumn ? `${key}（加粗：认作排序值的第一个比率 / 百分比字段）` : key
          headRow.appendChild(th)
        }
        table.appendChild(headRow)

        const span = model.columns.length + (model.nameKey === null ? 0 : 1)
        const body = el('tbody')
        rows.slice(0, SORT_ROWS_CAP).forEach((row, index) => {
          const tr = el('tr')
          const rankTd = el('td', rankClass, String(index + 1))
          tr.appendChild(rankTd)
          if (!isPlainRow(row)) {
            // 行集里混进了非对象（null / 数字 / 数组）：整行如实写出它的 JSON，不硬拆成列
            const td = el('td', 'apv-sort-txt apv-sort-dim', clipCell(JSON.stringify(row), SORT_CELL_CHARS).text)
            td.colSpan = span
            td.title = '这一项不是对象'
            tr.appendChild(td)
            body.appendChild(tr)
            return
          }
          const tagHost = model.nameKey === null ? rankTd : el('td', 'apv-sort-name apv-sort-pin apv-sort-pin-last')
          if (model.nameKey !== null) {
            const raw = row[model.nameKey]
            const name = clipCell(raw === undefined || raw === null ? '' : String(raw), SORT_NAME_CHARS)
            tagHost.textContent = name.text
            if (name.title !== '') tagHost.title = name.title
            tr.appendChild(tagHost)
          }
          for (const tag of sortRowTags(row)) tagHost.appendChild(el('span', 'apv-sort-tag', tag))
          for (const key of model.columns) {
            const cell = sortCell(row, key)
            const classes = [model.textColumns.has(key) ? 'apv-sort-txt' : '', key === model.keyColumn ? 'apv-sort-key' : '', cell.dim ? 'apv-sort-dim' : '']
            const td = el('td', classes.filter((c) => c !== '').join(' '), cell.text)
            if (cell.title !== '') td.title = cell.title
            tr.appendChild(td)
          }
          body.appendChild(tr)
        })
        table.appendChild(body)
        scroll.appendChild(table)
        sortPane.appendChild(scroll)
        if (model.shownFieldCount < model.fieldCount) sortPane.appendChild(el('div', 'apv-sort-head', `字段太多：只显示前 ${model.shownFieldCount} 个（共 ${model.fieldCount} 个）`))
        if (rows.length > SORT_ROWS_CAP) sortPane.appendChild(el('div', 'apv-sort-head', `只渲染前 ${SORT_ROWS_CAP} 行（共 ${rows.length} 行）`))
        sortPane.hidden = false
        sortResize.hidden = false
        if (model.nameKey !== null) {
          // 名称列的 left = 「顺序」列的实际宽度（随字号、行数位数变化），量出来写进 CSS 变量
          const syncPinLeft = () => table.style.setProperty('--apv-sort-pin-left', `${rankTh.getBoundingClientRect().width}px`)
          if (typeof ResizeObserver === 'function') {
            sortPinObserver = new ResizeObserver(syncPinLeft)
            sortPinObserver.observe(rankTh)
          } else {
            syncPinLeft()
          }
        }
      }

      function renderDetail(full) {
        currentFull = full
        updateDiffButtons()
        selectedUrl = full.url
        detailTitle.textContent = `${full.method} ${full.url}`
        locateSrcBtn.disabled = full.caller === undefined || full.caller === null
        bodySections.length = 0
        detailBody.textContent = ''
        replayWrap = null
        const meta = {
          method: full.method,
          url: full.url,
          status: full.status,
          time: Number.isFinite(full.ts) ? new Date(full.ts).toLocaleString() : undefined,
          source: full.source,
          channel: channelOf(full) || undefined,
          durationMs: full.durationMs,
          process: full.process,
          clientProcess: full.clientProcess,
          clientPid: full.clientPid,
          id: full.id,
        }
        detailBody.appendChild(makePreSection('基本信息', JSON.stringify(meta, null, 2), true))
        if (full.caller !== undefined && full.caller !== null) {
          const c = full.caller
          const lines = []
          if (c.viewModel) lines.push('ViewModel : ' + c.viewModel)
          if (c.view) lines.push('View(约定): ' + c.view)
          if (c.apiMethod) lines.push('Api       : ' + c.apiMethod)
          if (c.trigger) lines.push('触发方法  : ' + c.trigger)
          const chain = normalizeStack(c.stack).slice().reverse()
          if (chain.length > 0) {
            lines.push('调用链(入口→接口):')
            chain.forEach((f, i) => lines.push('    ' + String(i + 1).padStart(2, ' ') + '. ' + f))
          }
          if (lines.length > 0) detailBody.appendChild(makePreSection('调用方', lines.join('\n')))
        }
        if (full.reqHeaders !== undefined) detailBody.appendChild(makePreSection('请求头', JSON.stringify(full.reqHeaders, null, 2), true))
        if (typeof full.reqBody === 'string' && full.reqBody !== '') {
          bodySections.push(makeBodySection('请求体', full.reqBody, headerValue(full.reqHeaders, 'content-type'), detailBody))
        }
        if (full.resHeaders !== undefined) detailBody.appendChild(makePreSection('响应头', JSON.stringify(full.resHeaders, null, 2), true))
        if (typeof full.resBody === 'string' && full.resBody !== '') {
          bodySections.push(makeBodySection('响应体', full.resBody, headerValue(full.resHeaders, 'content-type'), detailBody))
        }
        noteInput.value = full.note ?? ''
        tagInput.value = full.tag ?? ''
        const streamMeta = {
          complete: full.complete,
          streaming: full.streaming,
          firstByteMs: full.firstByteMs,
          ttfbMs: full.ttfbMs,
          connectMs: full.connectMs,
          tlsMs: full.tlsMs,
          bytesReq: full.bytesReq,
          bytesRes: full.bytesRes,
          chunkCount: full.chunkCount,
          sessionId: full.sessionId,
          traceId: full.traceId,
          parentId: full.parentId,
          ruleId: full.ruleId,
        }
        if (Object.values(streamMeta).some((v) => v !== undefined)) detailBody.insertBefore(makePreSection('流式/关联元数据', JSON.stringify(streamMeta, null, 2), true), detailBody.firstChild)
        if (full.ws !== undefined && full.ws !== null) {
          const ws = {
            closeCode: full.ws.closeCode,
            closeReason: full.ws.closeReason,
            frameCount: full.ws.frameCount,
            msgCount: full.ws.msgCount,
            frames: full.ws.frames,
          }
          detailBody.insertBefore(makePreSection('WebSocket 帧记录', JSON.stringify(ws, null, 2), true), detailBody.firstChild)
        }
        detailBody.insertBefore(buildProcLine(full), detailBody.firstChild)
        renderSortPane(full)
      }

      /** 详情里的「进程」一行（始终可见，基本信息默认收起）：本地代理 / 透明拦截的连接按端口查出进程名和 PID，实时捕获只有进程名。 */
      function buildProcLine(full) {
        const procName = typeof full.clientProcess === 'string' ? full.clientProcess : ''
        const procPid = Number.isInteger(full.clientPid) ? full.clientPid : null
        const procLine = el('div', 'apv-dproc')
        procLine.appendChild(el('span', 'apv-t', '进程'))
        procLine.appendChild(document.createTextNode(procName !== '' || procPid !== null
          ? ` ${procName !== '' ? procName : '-'}${procPid !== null ? `（PID ${procPid}）` : ''}`
          : ' 未知'))
        const channel = channelOf(full)
        if (channel !== '') procLine.appendChild(el('span', 'apv-note', ` · 渠道 ${channel}`))
        procLine.title = procName !== '' || procPid !== null
          ? '发起这个请求的进程（本地代理 / 透明拦截按连接端口查到；实时捕获来自客户端进程名配置）'
          : channel === 'intercept' || channel === 'local-proxy'
            // R5-05：这两种记录先落库，进程按连接端口查到后再补上（详情跟着轮询刷新）
            ? '还没有进程信息：本地代理 / 透明拦截按连接端口查进程，可能还在查，查到后这里会自动补上；一直没有 = 查进程时连接已经断开'
            : '没有进程信息：旧记录、导入的记录，或查进程时连接已经断开'
        return procLine
      }

      function renderReplayResult(response, original) {
        if (replayWrap === null) {
          replayWrap = el('div', 'apv-sec')
          replayWrap.appendChild(el('div', 'apv-sec-title', '重放结果'))
          detailBody.insertBefore(replayWrap, detailBody.firstChild)
        }
        replayWrap.querySelectorAll('.apv-replay-bar, .apv-sec-body').forEach((n) => n.remove())
        const bar = el('div', 'apv-replay-bar')
        if (response && response.ok) {
          bar.appendChild(statusBadge(response.status))
          bar.appendChild(el('span', 'apv-note', `${response.statusText ?? ''} · ${fmtDur(response.durationMs)} · ${response.truncated ? '已截断' : ''}`))
        } else {
          bar.appendChild(el('span', 'apv-note', `失败: ${(response && response.error) || '未知错误'}`))
        }
        replayWrap.appendChild(bar)
        const diffs = replayDiff(original, response)
        if (diffs.length > 0) {
          const diffPre = highlightedPre(JSON.stringify(diffs, null, 2), '')
          replayWrap.appendChild(el('div', 'apv-sec-title', `响应差异 (${diffs.length})`))
          replayWrap.appendChild(diffPre)
        } else if (response?.ok && original !== null) {
          replayWrap.appendChild(el('div', 'apv-note', '响应 body 未发现结构差异'))
        }
        if (typeof response?.body === 'string' && response.body !== '') {
          const container = el('div', 'apv-sec-body')
          const kind = detectBodyKind(response.body, response.contentType ?? '')
          try {
            if (kind.kind === 'json') container.appendChild(highlightedPre(JSON.stringify(JSON.parse(response.body), null, 2), bodyQuery))
            else container.appendChild(highlightedPre(response.body, bodyQuery))
          } catch {
            container.appendChild(highlightedPre(response.body, bodyQuery))
          }
          replayWrap.appendChild(container)
        }
      }

      const closeDetail = () => {
        detail.hidden = true
        selectedId = null
        detailBody.textContent = ''
        bodySections.length = 0
        currentFull = null
        replayWrap = null
        clearSortPane()
      }
      detailClose.addEventListener('click', closeDetail)

      copyUrlBtn.addEventListener('click', () => {
        if (selectedUrl !== '') copyText(selectedUrl, copyUrlBtn, '复制 URL')
      })
      copyAsBtn.addEventListener('click', () => {
        if (currentFull === null) return
        copyText(buildSnippet(copyAsSel.value, currentFull), copyAsBtn, '复制为')
      })
      replayBtn.addEventListener('click', () => {
        if (currentFull === null) return
        replayBtn.disabled = true
        replayBtn.textContent = '重放中…'
        const payload = {
          method: currentFull.method,
          url: currentFull.url,
          headers: currentFull.reqHeaders ?? {},
          body: currentFull.reqBody ?? '',
          timeoutMs: 30000,
        }
        fetch('/api/dsh-postman/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((r) => r.json())
          .then((data) => renderReplayResult(data.response, currentFull))
          .catch((error) => renderReplayResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, currentFull))
          .finally(() => {
            replayBtn.disabled = false
            replayBtn.textContent = '重放'
          })
      })
      openPmBtn.addEventListener('click', () => {
        if (currentFull === null) return
        window.dispatchEvent(
          new CustomEvent('dsh-postman:prefill', {
            detail: {
              method: currentFull.method,
              url: currentFull.url,
              headers: currentFull.reqHeaders ?? {},
              body: currentFull.reqBody ?? '',
            },
          }),
        )
      })
      bodySearch.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        bodyQuery = bodySearch.value
        for (const render of bodySections) render()
        const firstMark = detailBody.querySelector('.apv-mark')
        if (firstMark !== null) firstMark.scrollIntoView({ block: 'center' })
      })
      saveNoteBtn.addEventListener('click', () => {
        if (currentFull === null) return
        const patch = { note: noteInput.value, tag: tagInput.value }
        saveNoteBtn.disabled = true
        apiFetch(`/records/${encodeURIComponent(currentFull.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
          .then((rec) => {
            currentFull = rec
            renderDetail(rec)
            refresh()
          })
          .catch((error) => {
            console.error('[dsh-api-visualizer] patch failed:', error)
          })
          .finally(() => {
            saveNoteBtn.disabled = false
          })
      })
      delRecordBtn.addEventListener('click', () => {
        if (currentFull === null) return
        if (!window.confirm(`删除这条记录？\n${currentFull.method} ${currentFull.url}`)) return
        delRecordBtn.disabled = true
        apiFetch(`/records/${encodeURIComponent(currentFull.id)}`, { method: 'DELETE' })
          .then(() => {
            closeDetail()
            refresh()
          })
          .catch((error) => {
            console.error('[dsh-api-visualizer] delete record failed:', error)
          })
          .finally(() => {
            delRecordBtn.disabled = false
          })
      })

      async function toggleFlag(rec, starBtn) {
        try {
          const updated = await apiFetch(`/records/${encodeURIComponent(rec.id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ flag: !isFlagged(rec) }),
          })
          rec.flag = isFlagged(updated)
          starBtn.textContent = rec.flag ? '★' : '☆'
          starBtn.dataset.on = rec.flag ? '1' : '0'
          if (currentFull !== null && currentFull.id === rec.id) currentFull.flag = rec.flag
        } catch (error) {
          console.error('[dsh-api-visualizer] flag failed:', error)
        }
      }

      const renderStats = (s) => {
        stats.textContent = ''
        stats.appendChild(document.createTextNode(`共 ${s.total} 条`))
        if (s.lastTs !== null) stats.appendChild(document.createTextNode(` · 最新 ${fmtTime(s.lastTs)}`))
        for (const [m, n] of Object.entries(s.byMethod)) {
          stats.appendChild(document.createTextNode(' · '))
          const chip = el('span', 'apv-statchip' + (state.method === m ? ' apv-statchip-on' : ''), `${m} ${n}`)
          chip.title = `点击按方法 ${m} 筛选（再点清除）`
          chip.addEventListener('click', () => {
            const next = state.method === m ? '' : m
            state.method = next
            methodSel.value = next
            refresh()
          })
          stats.appendChild(chip)
        }
        // source filter options from live data
        const keys = Object.keys(s.bySource)
        const current = sourceSel.value
        const want = keys.includes(current) ? current : ''
        sourceSel.textContent = ''
        const all = el('option', '', '来源:全部')
        all.value = ''
        sourceSel.appendChild(all)
        for (const k of keys.sort()) {
          const opt = el('option', '', `${k} (${s.bySource[k]})`)
          opt.value = k
          sourceSel.appendChild(opt)
        }
        if (want !== '') sourceSel.value = want
        state.source = want
      }

      /** Render the capture-engine chip + toggle + sidebar live dot. */
      const renderCapture = (cap) => {
        state.capture.status = cap
        const running = cap !== null && cap.running === true
        state.capture.running = running
        if (running) {
          const counters = cap.counters ?? {}
          const size = typeof cap.logSize === 'number' ? `${(cap.logSize / 1048576).toFixed(1)}MB` : '-'
          captureChip.textContent =
            `● 监听中 · 实时入库 ${cap.storeRealtime ?? counters.emitted ?? 0} 条 · 日志 ${size}`
          captureChip.className = 'apv-stats apv-live-on'
          captureBtn.textContent = '停止实时捕获'
          captureBtn.classList.add('apv-capture-on')
          // 健康检查：日志 3 个轮询周期无增长 → 提示注入可能未生效
          if (typeof cap.logSize === 'number' && cap.logSize === state.capture.prevLogSize && cap.logSize > 0) {
            state.capture.staleCount += 1
          } else {
            state.capture.staleCount = 0
          }
          state.capture.prevLogSize = cap.logSize
          if (state.capture.staleCount >= 3) {
            captureChip.className = 'apv-stats'
            captureChip.style.color = '#fbbf24'
            healthHint.textContent = '警告：跟踪日志近几秒没有增长——客户端 system.diagnostics 注入可能未生效（改配置后需重启客户端；原始日志在 %TEMP%\\uiprobe-net-trace.log）。'
            healthHint.style.color = '#fbbf24'
          } else {
            healthHint.textContent = ''
          }
        } else {
          captureChip.style.color = ''
          captureChip.textContent = cap === null ? '○ 捕获引擎不可用' : `○ 已停止 · 实时共 ${cap.storeRealtime ?? 0} 条`
          captureChip.className = 'apv-stats'
          captureBtn.textContent = '开始实时捕获'
          captureBtn.classList.remove('apv-capture-on')
          healthHint.textContent = ''
          state.capture.staleCount = 0
          state.capture.prevLogSize = null
        }
        if (liveDot !== null) liveDot.dataset.on = running ? '1' : '0'
      }

      /** Render the local-proxy chip + toggles. */
      const renderProxy = (cap) => {
        state.proxy.status = cap
        const running = cap !== null && cap.running === true
        state.proxy.running = running
        if (running) {
          proxyChip.textContent =
            `代理 ● 127.0.0.1:${cap.port} · 上游 ${cap.upstream ?? '直连'} · 已抓 ${cap.counters?.requests ?? 0} · HTTPS解密 ${cap.counters?.mitm ?? 0} · WS ${cap.counters?.ws ?? 0} · 规则 ${cap.rules?.enabled ?? 0}/${cap.rules?.total ?? 0}`
          proxyChip.className = 'apv-stats apv-live-on'
          proxyBtn.textContent = '停止代理'
          proxyBtn.classList.add('apv-capture-on')
        } else {
          proxyChip.textContent = cap === null
            ? '代理引擎不可用'
            : `代理 ○ 未启动${cap.error ? ` · ${cap.error}` : (cap.caReady ? ' · 证书就绪' : '')}`
          proxyChip.className = 'apv-stats'
          proxyBtn.textContent = '启动代理'
          proxyBtn.classList.remove('apv-capture-on')
        }
        const sysActive = cap !== null && cap.systemProxyActive === true
        sysProxyBtn.textContent = sysActive ? '取消系统代理' : '设为系统代理'
        sysProxyBtn.classList.toggle('apv-capture-on', sysActive)
        state.proxy.interceptListening = cap !== null && cap.intercept !== undefined && cap.intercept.listening === true
        renderInterceptChip(cap !== null ? cap.intercept ?? null : null)
        if (cap !== null && cap.breakpoints !== undefined && bpWrap.hidden) {
          bpBtn.textContent = cap.breakpoints.enabled ? `断点 ●${cap.breakpoints.paused > 0 ? ` ${cap.breakpoints.paused} 挂起` : ''}` : '断点'
        }
        if (cap !== null && cap.netsim !== null && typeof cap.netsim === 'object') {
          setNetsimBtn(cap.netsim.enabled === true, typeof cap.netsim.summary === 'string' ? cap.netsim.summary : '')
        }
      }

      // 行内容签名：涵盖该行展示的全部字段；两次渲染签名一致 = 行可原样复用（无需重建）。
      // 进程是连接建立后才查到的（宿主用同一 id 再发一次记录），签名里要有它，行才会跟着更新。
      const rowSig = (r) => [
        r.id, r.ts, r.method, r.status, r.durationMs, r.source, r.process, r.clientProcess, r.clientPid, r.note, isFlagged(r) ? 1 : 0, r.url,
        r.caller ? `${formatCallChain(r.caller.stack)}|${r.caller.viewModel ?? ''}|${r.caller.apiMethod ?? ''}` : '',
      ].join('')
      let renderedSig = [] // 与 tbody 中数据行一一对应的签名（供增量对齐）

      // 域名树的展开态：默认「只展开最近命中的域」，用户点过的节点记进后者并覆盖默认值。
      // 不存 prefs —— 展开态是操作出来的临时状态，跨会话残留只会让人以为树丢了。
      const treeState = { open: new Set(), overrides: new Map() }
      let pendingTreeRecords = [] // 树视图当前这份记录（refresh 填，renderTree 读）

      /** 缩进 + 命名空间，避免把 depth 与固定尺寸绑死。 */
      const treeIndent = (node) => `padding-left:${6 + (Number(node.depth) || 0) * 14}px`

      /** 建一条请求叶子：点开的是跟列表同一套详情（不复制详情逻辑）。 */
      const buildTreeLeaf = (record, parent) => {
        const row = el('div', 'apv-tree-leaf')
        row.dataset.recordId = String(record.id)
        row.style.cssText = treeIndent({ depth: parent.depth + 1 })
        row.appendChild(methodBadge(record.method))
        const path = el('span', 'apv-tree-path', record.url)
        path.title = record.url
        row.appendChild(path)
        const meta = el('div', 'apv-tree-meta')
        meta.appendChild(statusBadge(record.status))
        meta.appendChild(document.createTextNode(` ${fmtDur(record.durationMs)} · ${fmtTime(record.ts)}`))
        row.appendChild(meta)
        row.title = `${record.method} ${record.url}\n${fmtTime(record.ts)} · ${fmtDur(record.durationMs)} · 状态 ${record.status ?? '-'}`
        row.addEventListener('click', () => {
          selectedId = record.id
          treeWrap.querySelectorAll('.apv-tree-leaf.apv-selected').forEach((n) => n.classList.remove('apv-selected'))
          row.classList.add('apv-selected')
          apiFetch(`/records/${encodeURIComponent(record.id)}`).then((full) => {
            renderDetail(full)
            detail.hidden = false
          }).catch((error) => { console.error('[dsh-api-visualizer] detail failed:', error) })
        })
        return row
      }

      /** 建一个分支节点（域名/路径段），返回行元素；点击切换展开。 */
      const buildTreeNode = (node) => {
        const wrap = el('div', 'apv-tree-node')
        wrap.dataset.depth = String(node.depth ?? 0)
        const row = el('div', 'apv-tree-branch')
        row.dataset.kind = node.kind ?? 'path'
        row.dataset.nodeKey = node.key
        row.dataset.label = node.label
        row.style.cssText = treeIndent(node)
        const open = treeState.open.has(node.key)
        row.appendChild(el('span', 'apv-tree-caret', open ? '▾' : '▸'))
        row.appendChild(el('span', 'apv-tree-label', node.label))
        row.appendChild(el('span', 'apv-tree-note', `(${node.count})`))
        if (node.errors > 0) {
          const err = el('span', 'apv-tree-note', `✕${node.errors}`)
          err.style.color = '#f87171'
          row.appendChild(err)
        }
        if (node.kind === 'domain' && node.noHost === true) row.appendChild(el('span', 'apv-tree-note', '未识别出域名/路径'))
        row.title = `${node.label} · ${node.count} 条请求${node.errors > 0 ? ` · ${node.errors} 个 4xx/5xx` : ''}\n点击${open ? '收起' : '展开'}`
        row.addEventListener('click', () => {
          treeState.overrides.set(node.key, !treeState.open.has(node.key))
          renderTree()
        })
        wrap.appendChild(row)
        if (!open) return wrap
        for (const child of node.children ?? []) wrap.appendChild(buildTreeNode(child))
        for (const record of node.records ?? []) wrap.appendChild(buildTreeLeaf(record, node))
        return wrap
      }

      /** 建一条记录行（含星标/点击/详情打开）。 */
      const makeRow = (r) => {
        const tr = el('tr')
        if (r.id === selectedId) tr.classList.add('apv-selected')
        const starTd = el('td')
        const starred = isFlagged(r)
        const starBtn = el('button', 'apv-star', starred ? '★' : '☆')
        starBtn.dataset.on = starred ? '1' : '0'
        starBtn.title = '标记/取消标记'
        starBtn.addEventListener('click', (event) => {
          event.stopPropagation()
          toggleFlag(r, starBtn)
        })
        starTd.appendChild(starBtn)
        tr.appendChild(starTd)
        tr.appendChild(el('td', '', fmtTime(r.ts)))
        const methodTd = el('td')
        methodTd.appendChild(methodBadge(r.method))
        tr.appendChild(methodTd)
        tr.appendChild(callerCell(r.caller))
        const urlTd = el('td', '', r.url)
        urlTd.title = r.url
        tr.appendChild(urlTd)
        const statusTd = el('td')
        statusTd.appendChild(statusBadge(r.status))
        tr.appendChild(statusTd)
        tr.appendChild(el('td', '', fmtDur(r.durationMs)))
        // 来源：捕获渠道（realtime / intercept / local-proxy …）+ 发起请求的进程（进程名:PID，查到了才有）
        const channel = channelOf(r)
        const proc = clientProcText(r)
        const sourceTd = el('td', 'apv-note apv-src', (channel || '-') + (proc !== '' ? ` · ${proc}` : ''))
        sourceTd.title = `来源 ${r.source ?? '-'}${channel !== '' && channel !== r.source ? ` · 渠道 ${channel}` : ''}` +
          (proc !== '' ? `\n进程 ${typeof r.clientProcess === 'string' && r.clientProcess !== '' ? r.clientProcess : '-'}${Number.isInteger(r.clientPid) ? `（PID ${r.clientPid}）` : ''}` : '')
        tr.appendChild(sourceTd)
        tr.appendChild(el('td', 'apv-note', r.note ?? ''))
        tr.addEventListener('click', () => {
          selectedId = r.id
          tbody.querySelectorAll('tr.apv-selected').forEach((node) => node.classList.remove('apv-selected'))
          tr.classList.add('apv-selected')
          apiFetch(`/records/${encodeURIComponent(r.id)}`).then((full) => {
            renderDetail(full)
            detail.hidden = false
          }).catch((error) => { console.error('[dsh-api-visualizer] detail failed:', error) })
        })
        return tr
      }

      const renderRows = (records) => {
        renderedRecords = records
        if (records.length === 0) {
          tbody.textContent = ''
          renderedSig = []
          const row = el('tr')
          const cell = el('td', 'apv-empty', '暂无记录 — 点击「开始实时捕获」，客户端流量会像 Fiddler 一样实时流进来；也可用 api_capture_append 手动上报')
          cell.colSpan = 9
          row.appendChild(cell)
          tbody.appendChild(row)
          return
        }
        const newSig = records.map(rowSig)
        // 增量渲染：实时新记录出现在列表头部（最新在前），旧行整体下移、超出 LIMIT 的尾部被裁掉。
        // 若旧渲染首行仍在新列表中且其后与旧渲染逐项一致 → 只在顶部插入新增行、删掉尾部裁掉的行，
        // 避免每秒整表（约 300 行）重建。任何不一致（含内容变化）都回退整表重建，保证正确。
        let incremental = false
        if (renderedSig.length > 0 && tbody.querySelector('.apv-empty') === null && tbody.childNodes.length === renderedSig.length) {
          const p = newSig.indexOf(renderedSig[0])
          const shared = p >= 0 ? newSig.length - p : -1
          if (p >= 0 && shared <= renderedSig.length) {
            let ok = true
            for (let i = 0; i < shared; i++) { if (newSig[p + i] !== renderedSig[i]) { ok = false; break } }
            if (ok) {
              for (let i = renderedSig.length - 1; i >= shared; i--) tbody.removeChild(tbody.childNodes[i]) // 裁掉尾部
              for (let i = p - 1; i >= 0; i--) tbody.insertBefore(makeRow(records[i]), tbody.firstChild) // 顶部插新增
              incremental = true
            }
          }
        }
        if (!incremental) {
          tbody.textContent = ''
          for (const r of records) tbody.appendChild(makeRow(r))
        }
        renderedSig = newSig
        if (state.autoScroll && detail.hidden) tableWrap.scrollTop = tableWrap.scrollHeight
      }

      /** Render the aggregate (endpoints) view. */
      const renderAgg = (data) => {
        aggBodyEl.textContent = ''
        if (data.items.length === 0) {
          aggBodyEl.appendChild(el('tr'))
          aggBodyEl.lastChild.appendChild(el('td', 'apv-empty', '暂无数据'))
          aggBodyEl.lastChild.firstChild.colSpan = 8
          return
        }
        for (const e of data.items) {
          const tr = el('tr')
          const epTd = el('td')
          const m = el('span', 'apv-badge apv-m-' + (e.method === 'GET' ? 'get' : e.method === 'POST' ? 'post' : 'other'), e.method)
          epTd.appendChild(m)
          epTd.appendChild(document.createTextNode(' ' + e.path))
          tr.appendChild(epTd)
          tr.appendChild(el('td', '', String(e.count)))
          const errTd = el('td')
          errTd.textContent = e.errors > 0 ? `${(e.errorRate * 100).toFixed(1)}% (${e.errors})` : '0'
          if (e.errors > 0) errTd.style.color = '#f87171'
          tr.appendChild(errTd)
          tr.appendChild(el('td', '', e.avgMs === null ? '-' : fmtDur(e.avgMs)))
          tr.appendChild(el('td', '', e.p95Ms === null ? '-' : fmtDur(e.p95Ms)))
          tr.appendChild(el('td', '', e.maxMs === null ? '-' : fmtDur(e.maxMs)))
          tr.appendChild(el('td', '', e.lastStatus === null || e.lastStatus === undefined ? '-' : String(e.lastStatus)))
          const sampleTd = el('td', '', e.sampleUrl ?? '')
          sampleTd.title = e.sampleUrl ?? ''
           tr.appendChild(sampleTd)
           tr.addEventListener('click', () => {
             q.value = e.path
             state.q = e.path
             setView('table')
           })
          aggBodyEl.appendChild(tr)
        }
      }

      const VIEW_MODES = ['tree', 'agg', 'session', 'timeline', 'waterfall', 'repeats', 'baseline']
      const viewWraps = { tree: treeWrap, agg: aggWrap, session: sessionWrap, timeline: timelineWrap, waterfall: waterfallWrap, repeats: repeatsWrap, baseline: baselineWrap }
      const viewButtons = { tree: treeBtn, agg: aggBtn, session: sessionBtn, timeline: timelineBtn, waterfall: waterfallBtn, repeats: repeatsBtn, baseline: baselineBtn }
      const activeView = () => VIEW_MODES.find((m) => state[m + 'View'] === true) ?? null
      const setView = (mode) => {
        for (const m of VIEW_MODES) state[m + 'View'] = m === mode
        const active = activeView()
        for (const [m, wrap] of Object.entries(viewWraps)) wrap.hidden = m !== active
        for (const [m, btn] of Object.entries(viewButtons)) btn.classList.toggle('apv-btn-on', m === active)
        tableWrap.hidden = active !== null
        if (active !== null) closeDetail()
        refresh()
      }

      const renderSessions = (data) => {
        sessionBodyEl.textContent = ''
        for (const s of data?.items ?? []) {
          const tr = el('tr')
          tr.appendChild(el('td', '', `${s.explicit ? '◆ ' : ''}${s.sessionId}`))
          tr.appendChild(el('td', '', fmtTime(s.firstTs)))
          tr.appendChild(el('td', '', fmtTime(s.lastTs)))
          tr.appendChild(el('td', '', String(s.count)))
          const err = el('td', '', String(s.errors))
          if (s.errors > 0) err.style.color = '#f87171'
          tr.appendChild(err)
          tr.appendChild(el('td', '', String(s.bytesRes ?? 0)))
          tr.appendChild(el('td', '', Object.entries(s.methods ?? {}).map(([k, v]) => `${k}:${v}`).join(' ')))
          tr.appendChild(el('td', '', Object.keys(s.hosts ?? {}).join(', ')))
          tr.title = (s.records ?? []).map((r) => `${r.method} ${r.status ?? '-'} ${r.url}`).join('\n')
          tr.addEventListener('click', () => {
            state.sessionId = s.sessionId
            q.value = ''
            state.q = ''
            setView('table')
          })
          sessionBodyEl.appendChild(tr)
        }
        if ((data?.items ?? []).length === 0) sessionBodyEl.appendChild(el('tr')).appendChild(el('td', 'apv-empty', '暂无会话'))
      }

      const renderTimeline = (data) => {
        const items = data?.items ?? []
        const totalRequests = items.reduce((sum, bucket) => sum + (Number(bucket.count) || 0), 0)
        const totalErrors = items.reduce((sum, bucket) => sum + (Number(bucket.errors) || 0), 0)
        const totalBytes = items.reduce((sum, bucket) => sum + (Number(bucket.bytesRes) || 0), 0)
        timelineTitle.textContent = items.length === 0
          ? '时间分桶明细 · 暂无数据'
          : `时间分桶明细 · 每 ${fmtBucket(data.bucketMs)} · ${items.length} 个时间段 · ${totalRequests} 个请求`
        timelineHelp.textContent = items.length === 0
          ? '当前筛选条件和时间范围内没有接口记录。'
          : `合计 ${totalRequests} 个请求，${totalErrors} 个错误，响应 ${fmtBytes(totalBytes)}。每一行统计该时间段内符合当前筛选条件的全部接口，不受列表分页影响。P50 是典型耗时，P95/P99 用来观察慢请求尾部。`
        timelineBodyEl.textContent = ''
        for (const bucket of items) {
          const row = el('tr')
          const range = el('td', 'apv-timeline-range', `${fmtTime(bucket.start)} - ${fmtTime(bucket.end)}`)
          range.title = `${new Date(bucket.start).toLocaleString()} 至 ${new Date(bucket.end).toLocaleString()}`
          row.appendChild(range)
          row.appendChild(el('td', '', String(bucket.count ?? 0)))
          const errorCell = el('td', bucket.errors > 0 ? 'apv-timeline-error' : 'apv-timeline-muted', String(bucket.errors ?? 0))
          row.appendChild(errorCell)
          const rateCell = el('td', bucket.errors > 0 ? 'apv-timeline-error' : 'apv-timeline-muted', `${((Number(bucket.errorRate) || 0) * 100).toFixed(1)}%`)
          row.appendChild(rateCell)
          const bytesCell = el('td', '', fmtBytes(Number(bucket.bytesRes) || 0))
          bytesCell.title = `${Number(bucket.bytesRes) || 0} 字节`
          row.appendChild(bytesCell)
          row.appendChild(el('td', '', fmtDur(bucket.avgMs)))
          row.appendChild(el('td', 'apv-timeline-muted', fmtDur(bucket.p50Ms)))
          row.appendChild(el('td', 'apv-timeline-tail', fmtDur(bucket.p95Ms)))
          row.appendChild(el('td', 'apv-timeline-tail', fmtDur(bucket.p99Ms)))
          timelineBodyEl.appendChild(row)
        }
        if (items.length === 0) {
          const row = el('tr')
          const cell = el('td', 'apv-empty', '暂无时间分析数据')
          cell.colSpan = 9
          row.appendChild(cell)
          timelineBodyEl.appendChild(row)
        }
      }

      /** Waterfall: one bar per request on a shared time axis; green=TTFB, blue=transfer. */
      const renderWaterfall = (records) => {
        waterfallList.textContent = ''
        if (records.length === 0) {
          waterfallList.appendChild(el('div', 'apv-empty', '暂无数据 — 当前筛选条件下没有请求（实时捕获的请求自带 TTFB 分段）'))
          return
        }
        const times = records.map((r) => Number(r.ts)).filter(Number.isFinite)
        const ends = records.map((r) => Number(r.ts) + (Number(r.durationMs) || 0)).filter(Number.isFinite)
        if (times.length === 0) return
        const t0 = Math.min(...times)
        const t1 = Math.max(...ends)
        const span = Math.max(t1 - t0, 1)
        const pct = (v) => ((v / span) * 100).toFixed(3) + '%'
        for (const r of records) {
          const row = el('div', 'apv-wf-row')
          const c = r.caller ?? {}
          const who = c.viewModel || c.view || ''
           const connectMs = Number(r.connectMs)
           const tlsMs = Number(r.tlsMs)
           const ttfb = Number(r.firstByteMs ?? r.ttfbMs)
           const phaseText = [
             Number.isFinite(connectMs) ? `连接 ${fmtDur(connectMs)}` : '',
             Number.isFinite(tlsMs) ? `TLS ${fmtDur(tlsMs)}` : '',
             Number.isFinite(ttfb) ? `TTFB ${fmtDur(ttfb)}` : '',
           ].filter(Boolean).join(' · ')
           const meta = el('div', 'apv-wf-meta', `${fmtTime(r.ts)} · ${r.method} ${statusBadge(r.status).textContent} · ${fmtDur(r.durationMs)}${phaseText !== '' ? ' · ' + phaseText : ''}${who !== '' ? ' · ' + who : ''}`)
          row.appendChild(meta)
          const track = el('div', 'apv-wf-track')
          const bar = el('div', 'apv-wf-bar')
          bar.style.left = pct(Number(r.ts) - t0)
          const dur = Math.max(Number(r.durationMs) || 0, 1)
          bar.style.width = pct(dur)
           if (Number.isFinite(ttfb) && ttfb > 0 && ttfb < dur) {
            const seg = el('div', 'apv-wf-ttfb')
            seg.style.width = ((ttfb / dur) * 100).toFixed(1) + '%'
            bar.appendChild(seg)
          }
           bar.title = `${r.method} ${r.url}\n开始: ${fmtTime(r.ts)}\n连接: ${fmtDur(connectMs)}\nTLS: ${fmtDur(tlsMs)}\n等待响应(TTFB): ${fmtDur(ttfb)}\n总耗时: ${fmtDur(r.durationMs)}\n${who !== '' ? '调用方: ' + who : ''}`
          bar.addEventListener('click', () => {
            selectedId = r.id
            apiFetch(`/records/${encodeURIComponent(r.id)}`).then((full) => {
              renderDetail(full)
              detail.hidden = false
            }).catch((error) => { console.error('[dsh-api-visualizer] detail failed:', error) })
          })
          track.appendChild(bar)
          row.appendChild(track)
          waterfallList.appendChild(row)
        }
      }

      /** Repeats: burst detection table. */
      const renderRepeats = (data) => {
        repeatsBodyEl.textContent = ''
        const items = data?.items ?? []
        repeatsTitle.textContent = items.length === 0
          ? '高频重复请求检测 · 未发现'
          : `高频重复请求检测 · ${items.length} 个接口存在 ${data.windowMs}ms 窗口内 ≥${data.minCount} 次的突发`
        if (items.length === 0) {
          const row = el('tr')
          const cell = el('td', 'apv-empty', '当前筛选范围内没有高频重复请求')
          cell.colSpan = 8
          row.appendChild(cell)
          repeatsBodyEl.appendChild(row)
          return
        }
        for (const e of items) {
          const tr = el('tr')
          const epTd = el('td')
          epTd.appendChild(methodBadge(e.method))
          epTd.appendChild(document.createTextNode(' ' + e.path))
          epTd.title = e.lastUrl ?? ''
          tr.appendChild(epTd)
          tr.appendChild(el('td', '', String(e.count)))
          const peak = el('td', '', String(e.maxInWindow))
          peak.style.color = '#fbbf24'
          tr.appendChild(peak)
          tr.appendChild(el('td', '', e.peakRatePerMin === null ? '-' : `≈${e.peakRatePerMin}/分`))
          tr.appendChild(el('td', 'apv-caller', e.caller ?? ''))
          tr.appendChild(el('td', '', e.lastStatus === null || e.lastStatus === undefined ? '-' : String(e.lastStatus)))
          tr.appendChild(el('td', '', fmtTime(e.firstTs)))
          tr.appendChild(el('td', '', fmtTime(e.lastTs)))
          tr.addEventListener('click', () => {
            q.value = e.path
            state.q = e.path
            setView('table')
          })
          repeatsBodyEl.appendChild(tr)
        }
      }

      /**
       * 域名树视图（P1-5）。数据源是 refresh 里那次 /records（与列表同一份、同一上限）：
       * 树上没有的东西 = 这次列表里没有它。所以表头必须把覆盖范围写在脸上，
       * 否则会被读成「整库就这些」——那正是这个面板最忌讳的读数（"截断"冒充"没有"）。
       */
      const renderTree = () => {
        // 自己清自己的容器，不靠外面先清过：展开/收起与轮询刷新都会重入这个函数，
        // 只依赖"上一步清过"的话重入就会叠出一棵树（DOM 里多份、行数翻倍）。
        treeWrap.textContent = ''
        const records = pendingTreeRecords
        if (records.length === 0) {
          treeWrap.appendChild(el('div', 'apv-empty', '暂无数据 — 当前筛选条件下没有请求；点「开始实时捕获」后再看'))
          return
        }
        const tree = buildUrlTree(records)
        // 展开态：本次重建先按默认（最近命中的域），再用用户点过的覆盖值盖上去。
        // 这样默认值始终跟着数据走，而用户手动的收起/展开在轮询刷新后仍然有效。
        const open = new Set()
        for (const domain of tree.domains) {
          if (domain.defaultOpen !== true) continue
          const stack = [domain]
          while (stack.length > 0) {
            const node = stack.pop()
            open.add(node.key)
            for (const child of node.children ?? []) stack.push(child)
          }
        }
        for (const [key, want] of treeState.overrides) {
          if (want) open.add(key)
          else open.delete(key)
        }
        treeState.open = open
        const expandAll = () => {
          treeState.overrides.clear()
          for (const domain of tree.domains) {
            const stack = [domain]
            while (stack.length > 0) {
              const node = stack.pop()
              treeState.overrides.set(node.key, true)
              for (const child of node.children ?? []) stack.push(child)
            }
          }
          renderTree()
        }
        const collapseAll = () => {
          treeState.overrides.clear()
          for (const domain of tree.domains) {
            const stack = [domain]
            while (stack.length > 0) {
              const node = stack.pop()
              treeState.overrides.set(node.key, false)
              for (const child of node.children ?? []) stack.push(child)
            }
          }
          renderTree()
        }
        const leaves = []
        for (const domain of tree.domains) {
          const stack = [domain]
          while (stack.length > 0) {
            const node = stack.pop()
            for (const record of node.records ?? []) leaves.push(record)
            for (const child of node.children ?? []) stack.push(child)
          }
        }
        const hosts = tree.domains.length
        const errors = leaves.reduce((sum, r) => sum + (Number.isInteger(r.status) && r.status >= 400 ? 1 : 0), 0)
        const range = tree.newestTs === null || tree.oldestTs === null
          ? '时间未知'
          : `${fmtTime(tree.oldestTs)} – ${fmtTime(tree.newestTs)}`
        const head = el('div', 'apv-tree-head')
        head.appendChild(el('b', '', `域名树 · ${hosts} 个域名 / ${leaves.length} 条请求`))
        head.appendChild(el('span', '', `覆盖 ${range}${errors > 0 ? ` · ${errors} 个 4xx/5xx` : ''}`))
        head.appendChild(el('span', '', '点域名/路径段展开收起，点请求行看详情'))
        if (tree.unparsableUrls > 0) {
          const warn = el('span', '', `⚠ ${tree.unparsableUrls} 条 URL 解析不出域名/路径，已按整串挂在「(无法归簇)」下（不是丢掉）`)
          warn.style.color = '#fbbf24'
          head.appendChild(warn)
        }
        const actions = el('div', 'apv-tree-actions')
        const expandBtn = el('button', 'apv-btn', '全部展开')
        expandBtn.addEventListener('click', expandAll)
        const collapseBtn = el('button', 'apv-btn', '全部收起')
        collapseBtn.addEventListener('click', collapseAll)
        actions.appendChild(expandBtn)
        actions.appendChild(collapseBtn)
        head.appendChild(actions)
        treeWrap.appendChild(head)
        for (const domain of tree.domains) treeWrap.appendChild(buildTreeNode(domain))
        const note = el('div', 'apv-note', '⚠ 只覆盖上面这次列表请求拉回的记录（当前 300 条，同表格视图的上限），不是整库；要收窄时间窗请用「更多 ▾」里的时间范围或域名筛选。')
        note.style.padding = '8px 0 0'
        treeWrap.appendChild(note)
      }

      const renderBaselineSel = (items) => {
        const current = baselineSel.value
        baselineSel.textContent = ''
        const all = el('option', '', items.length === 0 ? '(无基线)' : '选择基线…')
        all.value = ''
        baselineSel.appendChild(all)
        for (const b of items) {
          const opt = el('option', '', `${b.name} (${b.endpoints}端点 · ${b.records}条)`)
          opt.value = b.name
          baselineSel.appendChild(opt)
        }
        baselineSel.value = items.some((b) => b.name === current) ? current : ''
      }

      const renderBaselineReport = (report) => {
        const wrap = el('div')
        const head = el('div', 'apv-note', `基线「${report.name}」· 保存于 ${report.savedAt ? fmtTime(report.savedAt) : '-'} · 基线 ${report.baselineRecords} 条 / 当前 ${report.currentRecords} 条 · 端点 ${report.baselineEndpoints} → ${report.currentEndpoints}`)
        head.style.padding = '6px 0'
        wrap.appendChild(head)
        if ((report.changes ?? []).length === 0) {
          wrap.appendChild(el('div', 'apv-note', '✔ 契约无变化：状态码、Content-Type、响应字段结构一致'))
          return wrap
        }
        const table = el('table', 'apv-table')
        const thead = el('thead')
        const headRow = el('tr')
        ;['端点', '变化', '详情'].forEach((h) => headRow.appendChild(el('th', '', h)))
        thead.appendChild(headRow)
        table.appendChild(thead)
        const tbody = el('tbody')
        for (const ch of report.changes) {
          const tr = el('tr')
          tr.appendChild(el('td', '', ch.endpoint))
          const kindTd = el('td', '', ch.kind)
          if (ch.kind === '新增端点') kindTd.style.color = '#4ade80'
          else if (ch.kind === '端点缺失') kindTd.style.color = '#f87171'
          else kindTd.style.color = '#fbbf24'
          tr.appendChild(kindTd)
          const detailTd = el('td', 'apv-note', ch.detail)
          detailTd.style.whiteSpace = 'normal'
          tr.appendChild(detailTd)
          tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        wrap.appendChild(table)
        return wrap
      }

      const renderBaselineList = (items) => {
        baselineBodyEl.textContent = ''
        baselineTitle.textContent = `契约基线 · ${items.length} 个`
        baselineHelp.textContent = '在「更多」里用当前筛选保存基线，之后随时对比。对比会重新按基线保存时的筛选条件计算当前契约。'
        const table = el('table', 'apv-table')
        const thead = el('thead')
        const headRow = el('tr')
        ;['名称', '保存时间', '端点数', '记录数', '操作'].forEach((h) => headRow.appendChild(el('th', '', h)))
        thead.appendChild(headRow)
        table.appendChild(thead)
        const tbody = el('tbody')
        if (items.length === 0) {
          const row = el('tr')
          const cell = el('td', 'apv-empty', '还没有基线 — 在「更多 ▾」筛选区点「保存基线」，把当前筛选的接口契约存为快照')
          cell.colSpan = 5
          row.appendChild(cell)
          tbody.appendChild(row)
        }
        for (const b of items) {
          const tr = el('tr')
          tr.appendChild(el('td', '', b.name))
          tr.appendChild(el('td', '', b.savedAt ? fmtTime(b.savedAt) : '-'))
          tr.appendChild(el('td', '', String(b.endpoints)))
          tr.appendChild(el('td', '', String(b.records)))
          const opTd = el('td')
          const diffBtn = el('button', 'apv-btn', '对比')
          diffBtn.style.padding = '2px 8px'
          diffBtn.style.fontSize = '11px'
          diffBtn.addEventListener('click', (event) => {
            event.stopPropagation()
            diffBaselineBtn.disabled = true
            apiFetch('/baseline/diff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: b.name }) })
              .then((report) => {
                state.baselineReport = report
                baselineBodyEl.insertBefore(renderBaselineReport(report), baselineBodyEl.firstChild)
              })
              .catch((error) => { console.error('[dsh-api-visualizer] baseline diff failed:', error) })
              .finally(() => { diffBaselineBtn.disabled = false })
          })
          opTd.appendChild(diffBtn)
          const delBtn = el('button', 'apv-btn apv-btn-danger', '删除')
          delBtn.style.padding = '2px 8px'
          delBtn.style.fontSize = '11px'
          delBtn.addEventListener('click', (event) => {
            event.stopPropagation()
            if (!window.confirm(`删除基线「${b.name}」？`)) return
            apiFetch(`/baseline/${encodeURIComponent(b.name)}`, { method: 'DELETE' })
              .then(() => refresh())
              .catch((error) => { console.error('[dsh-api-visualizer] baseline delete failed:', error) })
          })
          opTd.appendChild(delBtn)
          tr.appendChild(opTd)
          tbody.appendChild(tr)
        }
        table.appendChild(tbody)
        baselineBodyEl.appendChild(table)
        if (state.baselineReport !== null && items.some((b) => b.name === state.baselineReport.name)) {
          baselineBodyEl.insertBefore(renderBaselineReport(state.baselineReport), baselineBodyEl.firstChild)
        }
      }

      /** AutoResponder rules panel. */
      const URL_TYPE_LABEL = { contains: '包含', path: '接口路径', glob: '通配', regex: '正则' }
      const actionText = (r) => {
        const a = r.action ?? {}
        const lat = [
          a.latencyMs > 0 && a.type !== 'hang' ? `请求延迟 ${a.latencyMs}ms` : '',
          a.responseDelayMs > 0 ? `回包延迟 ${a.responseDelayMs}ms` : '',
          a.jitterMs > 0 ? `±${a.jitterMs}ms` : '',
          a.throttleKbps > 0 ? `限速 ${a.throttleKbps}KB/s` : '',
        ].filter(Boolean).join(' · ')
        const base = a.type === 'mock' ? `mock ${a.status ?? 200}`
          : a.type === 'map-local' ? 'Map Local'
            : a.type === 'map-remote' ? 'Map Remote'
              : a.type === 'rewrite' ? `改写 ${(a.ops ?? []).length} 条`
                : a.type === 'hang' ? `挂起 ${Math.round((a.latencyMs || 60000) / 1000)}s`
                  : a.type === 'block' ? (a.latencyMs > 0 ? `${a.latencyMs}ms 后阻断` : '阻断')
                    : a.type === 'rewrite-status' ? `重写状态 ${a.status ?? '-'}`
                      : '延迟'
        return lat !== '' && a.type !== 'block' ? `${base} · ${lat}` : base
      }
      const ruleDetailText = (r) => {
        const a = r.action ?? {}
        if (a.type === 'map-local') return a.file ?? ''
        if (a.type === 'map-remote') return a.target ?? ''
        if (a.type === 'rewrite') return a.script ?? ''
        return a.body ?? ''
      }
      let rulesList = []
      let rulesRevision = null // 面板当前显示的规则集版本；/proxy/status 报的 rules.revision 变了就重拉（C12）
      let rulesLoading = 0
      let editingRule = null // 「编辑」模式：开始编辑时的那条规则（提交时以列表里最新的同 id 规则为底）
      let quickPrefill = null // 「原响应」模式：带进正文框的原文（用户没改就原样提交）
      let quickRecordId = null // 「原响应」模式：原记录 id（宿主据此沿用原响应的 Content-Type / 编码）
      const rulesGate = latestGate()
      const RULE_ACTION_LABEL = Object.fromEntries(RULE_ACTIONS)
      /** 规则面板的提示行；text 为 null = 恢复帮助文字。 */
      const setRulesNote = (text, kind) => {
        rulesHelp.textContent = text === null ? RULES_HELP_TEXT : text
        rulesHelp.classList.toggle('apv-warn', kind === 'warn')
        rulesHelp.classList.toggle('apv-ok', kind === 'ok')
      }
      /** 下拉里没有的方法（HEAD / OPTIONS …）临时加一项，免得 select 把它悄悄变成「任意」（C39）。 */
      const setRuleMethod = (method) => {
        const m = String(method ?? '').toUpperCase()
        for (const o of [...ruleMethodSel.options]) {
          if (o.dataset.apvTemp === '1' && o.value !== m) o.remove()
        }
        if (m !== '' && ![...ruleMethodSel.options].some((o) => o.value === m)) {
          const o = el('option', '', m)
          o.value = m
          o.dataset.apvTemp = '1'
          ruleMethodSel.appendChild(o)
        }
        ruleMethodSel.value = m
      }
      /** 回到「添加」：清空输入框（方法 / 匹配方式 / 动作 三个下拉保留，方便连着加同类规则），退出编辑 / 原响应模式。 */
      const resetRuleForm = () => {
        ruleFormMode = 'add'
        ruleAddTemplate = null
        editingRule = null
        quickPrefill = null
        quickRecordId = null
        const curMethod = ruleMethodSel.options[ruleMethodSel.selectedIndex]
        setRuleMethod(curMethod !== undefined && curMethod.dataset.apvTemp === '1' ? '' : ruleMethodSel.value)
        ruleNameIn.value = ''
        ruleUrlIn.value = ''
        ruleDelayIn.value = ''
        ruleRespDelayIn.value = ''
        ruleJitterIn.value = ''
        ruleThrottleIn.value = ''
        ruleStatusIn.value = ''
        ruleArgIn.value = ''
        ruleBodyIn.value = ''
        syncRuleForm()
      }
      const fillRuleForm = (r) => {
        const a = r.action ?? {}
        const m = r.match ?? {}
        ruleFormMode = 'edit'
        ruleAddTemplate = null
        editingRule = r
        quickPrefill = null
        quickRecordId = null
        ruleNameIn.value = r.name ?? ''
        setRuleMethod(m.method ?? '')
        ruleUrlIn.value = m.url ?? ''
        ruleTypeSel.value = m.urlType ?? 'contains'
        ruleActionSel.value = a.type ?? 'mock'
        ruleDelayIn.value = a.latencyMs > 0 ? String(a.latencyMs) : ''
        ruleRespDelayIn.value = a.responseDelayMs > 0 ? String(a.responseDelayMs) : ''
        ruleJitterIn.value = a.jitterMs > 0 ? String(a.jitterMs) : ''
        ruleThrottleIn.value = a.throttleKbps > 0 ? String(a.throttleKbps) : ''
        ruleStatusIn.value = Number.isInteger(a.status) ? String(a.status) : ''
        ruleArgIn.value = a.type === 'map-local' ? (a.file ?? '') : a.type === 'map-remote' ? (a.target ?? '') : ''
        ruleBodyIn.value = a.type === 'rewrite' ? (a.script ?? '') : (a.body ?? '')
        syncRuleForm()
        setRulesNote(null)
      }
      const renderRules = (data) => {
        rulesBodyEl.textContent = ''
        const rules = data?.rules ?? []
        if (rules.length === 0) {
          const row = el('tr')
          const cell = el('td', 'apv-empty', '还没有规则 — 在上方填写后点「添加规则」，或在请求详情里用「Mock ▾」一键生成')
          cell.colSpan = 8
          row.appendChild(cell)
          rulesBodyEl.appendChild(row)
          return
        }
        const matchText = (r) => {
          const m = r.match ?? {}
          const parts = []
          if (m.method) parts.push(m.method)
          if (m.url) parts.push(`${m.url} (${URL_TYPE_LABEL[m.urlType] ?? '包含'})`)
          if (m.host) parts.push(`host=${m.host}`)
          return parts.join(' ') || '全部'
        }
        for (const r of rules) {
          const tr = el('tr')
          const onTd = el('td')
          const onCb = el('input', '')
          onCb.type = 'checkbox'
          onCb.checked = r.enabled !== false
          onCb.title = '启用/停用'
          onCb.addEventListener('change', () => {
            onCb.disabled = true
            ruleOp({ op: onCb.checked ? 'enable' : 'disable', id: r.id }).then((res) => {
              if (!res.ok) onCb.checked = !onCb.checked
              onCb.disabled = false
            })
          })
          onTd.appendChild(onCb)
          tr.appendChild(onTd)
          tr.appendChild(el('td', '', (r.quick ? '⚡ ' : '') + r.name))
          tr.appendChild(el('td', '', matchText(r)))
          tr.appendChild(el('td', '', actionText(r)))
          const lat = r.action.type === 'hang' ? `${r.action.latencyMs || 60000}ms` : (r.action.latencyMs > 0 || r.action.responseDelayMs > 0 ? `${r.action.latencyMs || 0}+${r.action.responseDelayMs || 0}ms` : '-')
          tr.appendChild(el('td', '', lat))
          const dt = ruleDetailText(r)
          const bodyTd = el('td', 'apv-note', dt ? dt.slice(0, 60) + (dt.length > 60 ? '…' : '') : '-')
          bodyTd.title = dt
          tr.appendChild(bodyTd)
          tr.appendChild(el('td', '', String(r.hits ?? 0)))
          const opTd = el('td')
          const editBtn = el('button', 'apv-btn', '编辑')
          editBtn.style.padding = '2px 8px'
          editBtn.style.fontSize = '11px'
          editBtn.addEventListener('click', () => fillRuleForm(r))
          opTd.appendChild(editBtn)
          const delBtn = el('button', 'apv-btn apv-btn-danger', '删除')
          delBtn.style.padding = '2px 8px'
          delBtn.style.fontSize = '11px'
          delBtn.addEventListener('click', () => {
            delBtn.disabled = true
            if (editingRule !== null && editingRule.id === r.id) resetRuleForm()
            ruleOp({ op: 'remove', id: r.id }, `已删除：${r.name}`).then(() => { delBtn.disabled = false })
          })
          opTd.appendChild(delBtn)
          tr.appendChild(opTd)
          rulesBodyEl.appendChild(tr)
        }
      }
      const applyRulesData = (data) => {
        rulesList = Array.isArray(data?.rules) ? data.rules : []
        rulesRevision = typeof data?.revision === 'string' ? data.revision : null
        renderRules(data)
        // 导入选择开着（R5-01 / R3-03）：按钮上的条数跟着最新列表重画；提交用的 baseRevision 仍是用户选文件时看到的那一版，
        // 只有还没拿到版本号、或冲突后重新展示时才换成这一版。期间规则被改过 ⇒ 宿主回 409，提示后按新列表重新展示，再点一次才导入
        if (pendingRulesImport !== null) {
          if (pendingRulesImport.revision === null || pendingRulesImport.reshow === true) {
            pendingRulesImport.revision = rulesRevision
            pendingRulesImport.reshow = false
          }
          renderRulesImportChoice()
        }
      }
      const loadRules = () => {
        const seq = rulesGate.next()
        rulesLoading++
        return apiFetch('/proxy/rules').then((data) => {
          if (rulesGate.accept(seq)) applyRulesData(data)
        }).catch((error) => {
          console.error('[dsh-api-visualizer] load rules failed:', error)
          if (!rulesGate.accept(seq)) return
          rulesBodyEl.textContent = ''
          const row = el('tr')
          const cell = el('td', 'apv-empty', `读取规则失败：${errText(error)}（宿主没在跑，或是旧版本需要重启 DSH？）`)
          cell.colSpan = 8
          row.appendChild(cell)
          rulesBodyEl.appendChild(row)
        }).finally(() => { rulesLoading-- })
      }
      /** 规则操作失败时给用户看的话：区分「这条规则已经不在了」「内容太大」「宿主还是旧版本」。 */
      const ruleErrorText = (error) => {
        if (error?.code === 'RULE_NOT_FOUND') return `这条规则已经不在了（可能刚被智能体删除）：${errText(error)}`
        if (error?.code === 'BODY_TOO_LARGE' || error?.status === 413) return `保存失败：内容太大，宿主拒收（${errText(error)}）`
        if (error?.status === 404) return `保存失败：${errText(error)}（宿主是旧版本？需要重启 DSH 加载新插件）`
        return `保存失败：${errText(error)}`
      }
      /**
       * 单条规则操作（POST /proxy/rules/op：add / update / remove / enable / disable）：只动这一条，不再把面板手里
       * 可能已过期的整张列表写回去 —— 那会悄悄删掉智能体刚加的规则（C12），整表还可能超过请求体上限（C3）。
       * 返回 { ok:true, data } / { ok:false, error }，不抛错；失败时重新拉一次真实列表。
       */
      const ruleOp = (payload, okText) => {
        const seq = rulesGate.next()
        return apiFetch('/proxy/rules/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then((data) => {
          if (rulesGate.accept(seq)) applyRulesData(data)
          setRulesNote(okText ?? null, okText ? 'ok' : undefined)
          return { ok: true, data }
        }).catch((error) => {
          setRulesNote(ruleErrorText(error), 'warn')
          loadRules()
          return { ok: false, error }
        })
      }
      /** 一键规则返回的 reach（宿主按规则 URL 判断现在能不能命中、为什么，C9）；旧宿主没有 reach 就退回 takesEffect。 */
      const reachOf = (r) => {
        const reach = r !== null && typeof r === 'object' && r.reach !== null && typeof r.reach === 'object' ? r.reach : null
        return {
          takesEffect: reach !== null ? reach.takesEffect === true : r?.takesEffect === true,
          note: reach !== null && typeof reach.note === 'string' ? reach.note : '',
        }
      }
      /** textarea 会把 \r\n 规范成 \n：用户没动过的正文原样提交，不让「改一下延迟」顺手改掉正文里的换行。 */
      const textareaValue = (ta, original) => (typeof original === 'string' && ta.value === original.replace(/\r\n?/g, '\n') ? original : ta.value)
      /**
       * 由表单生成规则。base = 正在改的那条（或它被删后留下的模板）：以它为底，只覆盖表单管的字段；
       * quick / matchAll / match.host / action.headers / action.charset 以及不认识的字段原样保留（C39）。
       */
      const buildRuleFromForm = (base) => {
        const type = ruleActionSel.value
        const prevAction = base?.action ?? {}
        const action = { ...prevAction, type }
        action.latencyMs = Number(ruleDelayIn.value) || 0
        action.responseDelayMs = Number(ruleRespDelayIn.value) || 0
        action.jitterMs = Number(ruleJitterIn.value) || 0
        action.throttleKbps = Number(ruleThrottleIn.value) || 0
        // 隐藏的框（例如「延迟」规则的状态码框）里残留的值不提交
        if (ruleStatusIn.hidden || ruleStatusIn.value === '') delete action.status
        else action.status = Number(ruleStatusIn.value)
        // 参数框 / 正文框管的字段：换了动作类型就不再带旧类型的；ops 由宿主按 script 重新编译
        delete action.file
        delete action.target
        delete action.script
        delete action.ops
        if (type === 'map-local') action.file = ruleArgIn.value.trim()
        if (type === 'map-remote') action.target = ruleArgIn.value.trim()
        if (type === 'rewrite') action.script = textareaValue(ruleBodyIn, prevAction.type === 'rewrite' ? prevAction.script : undefined)
        action.body = type === 'mock' ? textareaValue(ruleBodyIn, prevAction.type === 'mock' ? prevAction.body : undefined) : ''
        return {
          ...(base ?? {}),
          name: ruleNameIn.value.trim() || '未命名规则',
          match: { ...(base?.match ?? {}), method: ruleMethodSel.value, url: ruleUrlIn.value.trim(), urlType: ruleTypeSel.value },
          action,
        }
      }
      const submitRuleForm = () => {
        const type = ruleActionSel.value
        const url = ruleUrlIn.value.trim()
        const prev = ruleFormMode === 'edit' && editingRule !== null
          ? (rulesList.find((x) => x.id === editingRule.id) ?? editingRule)
          : null
        const base = prev ?? ruleAddTemplate
        const host = String(base?.match?.host ?? '').trim()
        // 除「延迟」外都要限定 URL（或原规则带的域名）：空匹配会接管所有请求，登录、行情也会被它回包 / 挂起 / 断开（C13）
        if (type !== 'delay' && url === '' && host === '' && base?.matchAll !== true) {
          setRulesNote(`「${RULE_ACTION_LABEL[type] ?? type}」规则要填 URL 匹配：留空会接管经过本地代理 / 透明拦截的所有请求（登录、行情接口也会被它接管）。只有「延迟」规则可以留空、作用于全部请求。`, 'warn')
          ruleUrlIn.focus()
          return
        }
        if (ruleNameIn.value.trim() === '' && url === '') {
          setRulesNote('请至少填写规则名称或 URL 匹配', 'warn')
          return
        }
        const rule = buildRuleFromForm(base)
        const payload = prev !== null ? { op: 'update', id: prev.id, rule } : { op: 'add', rule }
        ruleAddBtn.disabled = true
        ruleOp(payload, prev !== null ? `已保存修改：${rule.name}` : `已添加：${rule.name}（排在最前面，先匹配先生效）`).then((res) => {
          if (res.ok) {
            resetRuleForm()
            return
          }
          if (prev !== null && res.error?.code === 'RULE_NOT_FOUND') {
            // 原规则被删了：表单内容保留、改成「添加」；原规则里表单管不到的字段作为模板带上（不带 id / 命中数 / 一键标记）
            const template = { ...prev }
            delete template.id
            delete template.hits
            delete template.quick
            ruleFormMode = 'add'
            ruleAddTemplate = template
            editingRule = null
            syncRuleForm()
            setRulesNote('要修改的这条规则已经不在了（可能刚被智能体删除）：表单内容还在，再点「添加规则」会把它作为新规则加入；不要了就点「取消编辑」。', 'warn')
          }
        }).finally(() => { ruleAddBtn.disabled = false })
      }
      /** 「原响应 → 编辑后生效」：写成这个接口的一键规则（替换旧的、排最前），和详情里其它 Mock 选项同一条路（C38）。 */
      const submitQuickOriginal = () => {
        const url = ruleUrlIn.value.trim()
        if (!/^https?:\/\/[^/?#]+/i.test(url)) {
          setRulesNote('一键规则的 URL 要写完整地址（https://host/path）：按「方法 + 接口路径」匹配，忽略查询参数。', 'warn')
          ruleUrlIn.focus()
          return
        }
        const status = Number(ruleStatusIn.value)
        const latency = Number(ruleDelayIn.value)
        const name = ruleNameIn.value.trim()
        const payload = {
          url,
          method: ruleMethodSel.value,
          // preset=original + 显式正文：正文用编辑后的，Content-Type / 编码沿用原响应（GBK 接口照样按 GBK 回）
          preset: 'original',
          ...(typeof quickRecordId === 'string' && quickRecordId !== '' ? { recordId: quickRecordId } : {}),
          body: textareaValue(ruleBodyIn, quickPrefill ?? undefined),
          ...(ruleStatusIn.value !== '' && Number.isInteger(status) ? { status } : {}),
          ...(latency > 0 ? { latencyMs: latency } : {}),
          ...(name !== '' ? { name } : {}),
        }
        const seq = rulesGate.next()
        ruleAddBtn.disabled = true
        apiFetch('/proxy/rules/quick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          .then((r) => {
            if (rulesGate.accept(seq)) applyRulesData(r)
            resetRuleForm()
            const reach = reachOf(r)
            setRulesNote(`${r.replaced ? '已替换这个接口原来的一键规则' : '已写成这个接口的一键规则'}（排在最前面）：${r.rule?.name ?? ''}${reach.note !== '' ? ' · ' + reach.note : ''}`, reach.takesEffect ? 'ok' : 'warn')
          })
          .catch((error) => setRulesNote(`保存失败：${errText(error)}`, 'warn'))
          .finally(() => { ruleAddBtn.disabled = false })
      }
      ruleCancelBtn.addEventListener('click', () => {
        resetRuleForm()
        setRulesNote(null)
      })
      ruleAddBtn.addEventListener('click', () => {
        if (ruleFormMode === 'quick-original') submitQuickOriginal()
        else submitRuleForm()
      })

      // ---- 规则集导出 / 导入
      // 导出：宿主给的原文只重排缩进就下载（数字、字符串一个字不改）。
      // 导入：先在面板里认一遍文件（有没有规则列表、几条），再让用户选 合并 / 替换；提交带 baseRevision，
      // 规则集在这期间被智能体改过就 409，刷新列表后让用户再点一次（C12 的同一套版本号）。
      let pendingRulesImport = null // { text, count, fileName, revision（用户选文件时看到的规则集版本，提交时作 baseRevision）, reshow }
      let rulesImportBusy = false
      const rulesImportErrText = (error) => {
        if (error?.status === 413 || error?.code === 'BODY_TOO_LARGE') return `导入失败：文件太大，宿主拒收（${errText(error)}）`
        if (error?.status === 404 && error?.code === undefined) return '导入失败：宿主是旧版本，没有导入接口（需要重启 DSH 加载新插件）'
        return `导入失败：${errText(error)}`
      }
      const renderRulesImportChoice = () => {
        rulesImportChoice.textContent = ''
        const pending = pendingRulesImport
        rulesImportChoice.hidden = pending === null
        if (pending === null) return
        rulesImportChoice.appendChild(el('span', '', `「${pending.fileName}」里有 ${pending.count} 条规则：`))
        const mergeBtn = el('button', 'apv-btn', '合并（加在最前，跳过完全相同的）')
        mergeBtn.title = '导入的规则放到最前面（规则按顺序匹配，先到先得，导入的 mock 立即生效）；和现有规则完全相同的跳过'
        const replaceBtn = el('button', 'apv-btn apv-btn-danger', `替换（清空现有 ${rulesList.length} 条）`)
        replaceBtn.title = '规则集变成文件里的这些规则，现有规则全部删除'
        const cancelBtn = el('button', 'apv-btn', '取消')
        for (const b of [mergeBtn, replaceBtn, cancelBtn]) {
          b.disabled = rulesImportBusy
          rulesImportChoice.appendChild(b)
        }
        mergeBtn.addEventListener('click', () => submitRulesImport('merge'))
        replaceBtn.addEventListener('click', () => submitRulesImport('replace'))
        cancelBtn.addEventListener('click', () => {
          pendingRulesImport = null
          renderRulesImportChoice()
          setRulesNote(null)
        })
      }
      const submitRulesImport = (mode) => {
        const pending = pendingRulesImport
        if (pending === null || rulesImportBusy) return
        rulesImportBusy = true
        renderRulesImportChoice()
        const before = rulesList.length
        const seq = rulesGate.next()
        apiFetch('/proxy/rules/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // data 用文件原文（宿主自己解析）：不经浏览器 JSON.parse 再 stringify
          // baseRevision 用选文件（或冲突后重新展示）时那一版，不用轮询刚拉到的最新版：期间被改过就该 409（R5-01 / R3-03）
          body: JSON.stringify({ data: pending.text, mode, ...(pending.revision !== null ? { baseRevision: pending.revision } : {}) }),
        })
          .then((data) => {
            if (rulesGate.accept(seq)) applyRulesData(data)
            pendingRulesImport = null
            const imported = Number(data?.imported) || 0
            const skipped = Number(data?.skipped) || 0
            const warnings = Array.isArray(data?.warnings) ? data.warnings.filter((w) => typeof w === 'string' && w !== '') : []
            const head = mode === 'replace'
              ? `已导入 ${imported} 条，原来的 ${before} 条已替换掉`
              : `已导入 ${imported} 条，跳过 ${skipped} 条相同的${imported > 0 ? '（导入的排在最前面，先匹配先生效）' : ''}`
            setRulesNote([head, ...warnings.map((w) => '⚠ ' + w)].join('\n'), warnings.length > 0 ? 'warn' : 'ok')
          })
          .catch((error) => {
            if (error?.code === 'RULES_CONFLICT') {
              // 规则集在用户选文件之后被别处改过：重新拉列表，按新列表（「替换」按钮上的新条数、新版本号）重新展示选择，
              // 文件还留着，看过新条数后再点一次；列表拉回来之前按钮保持禁用（finally 等这次重拉完）
              setRulesNote('规则集刚被改过（你选文件之后，可能是智能体加 / 删了规则），列表和「替换」按钮上的条数已按最新的刷新；看一眼没问题再点一次「合并」或「替换」。', 'warn')
              pending.reshow = true
              return loadRules()
            }
            setRulesNote(rulesImportErrText(error), 'warn')
          })
          .finally(() => {
            rulesImportBusy = false
            renderRulesImportChoice()
          })
      }
      rulesExportBtn.addEventListener('click', () => {
        rulesExportBtn.disabled = true
        apiFetchText('/proxy/rules/export')
          .then((text) => {
            let count = null
            try {
              const env = JSON.parse(text)
              count = Array.isArray(env?.rules) ? env.rules.length : Array.isArray(env) ? env.length : null
            } catch {
              count = null
            }
            const name = `api-rules-${fileStamp()}.json`
            downloadBlob(name, prettyJsonText(text) + '\n', 'application/json')
            setRulesNote(`已导出${count !== null ? ` ${count} 条规则` : ''} → ${name}（浏览器下载）`, 'ok')
          })
          .catch((error) => setRulesNote(error?.status === 404 && error?.code === undefined
            ? '导出失败：宿主是旧版本，没有导出接口（需要重启 DSH 加载新插件）'
            : `导出失败：${errText(error)}`, 'warn'))
          .finally(() => { rulesExportBtn.disabled = false })
      })
      rulesImportBtn.addEventListener('click', () => rulesImportFile.click())
      rulesImportFile.addEventListener('change', () => {
        const file = rulesImportFile.files && rulesImportFile.files[0]
        rulesImportFile.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onerror = () => setRulesNote('读取文件失败', 'warn')
        reader.onload = () => {
          const text = String(reader.result ?? '').replace(/^\uFEFF/, '')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            setRulesNote(`「${file.name}」不是有效的 JSON 文件`, 'warn')
            return
          }
          const list = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.rules) ? parsed.rules : null
          if (list === null) {
            setRulesNote(`「${file.name}」里没有规则列表：要用「导出规则」导出的文件（或规则数组）`, 'warn')
            return
          }
          pendingRulesImport = { text, count: list.length, fileName: file.name, revision: rulesRevision, reshow: false }
          setRulesNote(null)
          if (rulesRevision === null && rulesLoading === 0) loadRules() // 还没拿到版本号（面板刚打开）：先拉一次，「替换」按钮的条数也准
          renderRulesImportChoice()
        }
        reader.readAsText(file)
      })
      sessionBtn.addEventListener('click', () => setView(state.sessionView ? 'table' : 'session'))
      timelineBtn.addEventListener('click', () => setView(state.timelineView ? 'table' : 'timeline'))
      waterfallBtn.addEventListener('click', () => setView(state.waterfallView ? 'table' : 'waterfall'))
      repeatsBtn.addEventListener('click', () => setView(state.repeatsView ? 'table' : 'repeats'))
      baselineBtn.addEventListener('click', () => setView(state.baselineView ? 'table' : 'baseline'))

      /** 上方筛选栏（工具栏 + 「更多 ▾」）的查询参数：列表、导出、删除筛选集、AI 分析包共用这一份。 */
      const setQuickParams = (params) => {
        if (state.q !== '') params.set('q', state.q)
        if (state.method !== '') params.set('method', state.method)
        if (state.status !== '') params.set('status', state.status)
        if (state.source !== '') params.set('source', state.source)
        if (state.flagged) params.set('flag', '1')
        if (state.host !== '') params.set('host', state.host)
        if (state.ct !== '') params.set('contentType', state.ct)
        if (state.minDur !== '') params.set('minDurationMs', state.minDur)
        if (state.minBytes !== '') params.set('minBytes', state.minBytes)
        if (state.maxBytes !== '') params.set('maxBytes', state.maxBytes)
        if (state.fromTs !== '') params.set('fromTs', state.fromTs)
        if (state.toTs !== '') params.set('toTs', state.toTs)
        if (state.sessionId !== '') params.set('sessionId', state.sessionId)
        if (state.errorsOnly) params.set('errors', '1')
        if (state.noNoise) params.set('noNoise', '1')
        if (state.regex) params.set('regex', '1')
        if (state.bodyQ !== '') params.set('bodyQ', state.bodyQ)
        return params
      }
      /**
       * 把当前启用的过滤器加进查询参数（和上面的筛选 AND）：一般带条件本身（conditions=），
       * 条件长到放不进查询串时改带 filterId（宿主按 id 取已存的过滤器）；POST 体里总是带条件。
       * 返回 { filter, key } 或 null（没有启用过滤器）。
       */
      const setFilterParam = (params, { forPost = false } = {}) => {
        const f = state.activeFilter
        if (f === null) return null
        const json = JSON.stringify(filterPayload(f, fd.opsById))
        if (forPost || encodeURIComponent(json).length <= FILTER_QUERY_MAX) {
          params.set('conditions', json)
          return { filter: f, key: 'conditions' }
        }
        params.set('filterId', f.id)
        return { filter: f, key: 'filterId' }
      }

      // ---- 提示条（AI 分析包的保存路径 + 复制按钮、过滤器被别处删除…）：一直留着，直到用户关掉或下一条提示
      const hideNotice = () => {
        noticeBar.hidden = true
        noticeBar.textContent = ''
      }
      const showNotice = (kind, text, actions = []) => {
        noticeBar.textContent = ''
        noticeBar.appendChild(el('span', 'apv-notice-text ' + (kind === 'ok' ? 'apv-ok' : kind === 'warn' ? 'apv-warn' : 'apv-note'), text))
        for (const action of actions) {
          const b = el('button', 'apv-btn', action.label)
          b.type = 'button'
          if (action.title) b.title = action.title
          b.addEventListener('click', () => action.onClick(b))
          noticeBar.appendChild(b)
        }
        const x = el('button', 'apv-btn', '×')
        x.type = 'button'
        x.title = '关闭这条提示'
        x.setAttribute('aria-label', '关闭这条提示')
        x.addEventListener('click', hideNotice)
        noticeBar.appendChild(x)
        noticeBar.hidden = false
      }

      // ---- 过滤器对话框（Fiddler 式）：左边是已存的过滤器，右边是条件构造器，底部实时显示匹配条数
      const fd = {
        fields: BUILTIN_FILTER_FIELDS,
        ops: BUILTIN_FILTER_OPS,
        fieldsById: new Map(BUILTIN_FILTER_FIELDS.map((f) => [f.id, f])),
        opsById: new Map(BUILTIN_FILTER_OPS.map((o) => [o.id, o])),
        hostSupport: null, // null = 还不知道；false = 旧宿主（没有 /filters 接口）
        loaded: false,
        syncing: false,
        lastSync: 0,
        saved: [], // 宿主上的过滤器（GET /filters 的 filters，宿主的顺序）
        drafts: new Map(), // key → 编辑中的副本：已存过滤器的副本以 id 为 key，新建的以 'new:N' 为 key
        selected: '', // '' = 默认（不过滤）
        newSeq: 0,
        serverError: null, // 宿主对某个草稿的校验错误 { key, index, sig, message }（index -1 = 不是某一个条件的错）
        serverOk: null, // 宿主最近一次接受了的条件 { key, sigs:Set }（实时统计成功时记下）
        busy: false,
        pendingImport: null, // { data, count, fileName }
        confirmDelete: false,
      }
      const fdOverlay = el('div', 'apv-fd-overlay')
      fdOverlay.hidden = true
      const fdBox = el('div', 'apv-fd')
      fdBox.setAttribute('role', 'dialog')
      fdBox.setAttribute('aria-modal', 'true')
      fdBox.setAttribute('aria-label', '过滤器')
      fdBox.tabIndex = -1
      fdOverlay.appendChild(fdBox)
      const fdHead = el('div', 'apv-fd-head')
      fdHead.appendChild(el('span', 'apv-fd-title', '过滤器'))
      const fdHostNote = el('span', 'apv-fd-hostnote apv-note', '')
      fdHead.appendChild(fdHostNote)
      const fdX = el('button', 'apv-btn apv-fd-x', '×')
      fdX.type = 'button'
      fdX.title = '关闭（Esc）'
      fdX.setAttribute('aria-label', '关闭')
      fdHead.appendChild(fdX)
      fdBox.appendChild(fdHead)
      const fdMain = el('div', 'apv-fd-main')
      const fdSide = el('div', 'apv-fd-side')
      const fdList = el('div', 'apv-fd-list')
      fdList.setAttribute('role', 'listbox')
      fdList.setAttribute('aria-label', '过滤器列表')
      fdSide.appendChild(fdList)
      const fdSideBtns = el('div', 'apv-fd-side-btns')
      const fdNewBtn = el('button', 'apv-btn', '新建')
      fdNewBtn.title = '新建一个过滤器（保存或应用后才存到宿主上）'
      const fdImportBtn = el('button', 'apv-btn', '导入')
      fdImportBtn.title = '从「导出」得到的过滤器文件（.json）导入'
      const fdExportBtn = el('button', 'apv-btn', '导出')
      fdExportBtn.title = '把全部已保存的过滤器导出成 .json 文件（交给同事导入）'
      for (const b of [fdNewBtn, fdImportBtn, fdExportBtn]) {
        b.type = 'button'
        fdSideBtns.appendChild(b)
      }
      fdSide.appendChild(fdSideBtns)
      const fdImportFile = el('input', '')
      fdImportFile.type = 'file'
      fdImportFile.accept = '.json,application/json'
      fdImportFile.style.display = 'none'
      fdSide.appendChild(fdImportFile)
      const fdImportBox = el('div', 'apv-fd-import')
      fdImportBox.hidden = true
      fdSide.appendChild(fdImportBox)
      fdMain.appendChild(fdSide)
      const fdEdit = el('div', 'apv-fd-edit')
      const fdNameRow = el('div', 'apv-fd-namerow')
      const fdNameLabel = el('label', '', '名称 *')
      const fdNameIn = el('input', 'apv-fin apv-fd-name')
      fdNameIn.id = 'apv-fd-name'
      fdNameLabel.htmlFor = 'apv-fd-name'
      fdNameIn.spellcheck = false
      fdNameIn.placeholder = '给过滤器起个名字，例如「客户端全部接口」'
      const fdSaveBtn = iconButton(ICON_SAVE, '保存')
      const fdDupBtn = iconButton(ICON_COPY, '复制为新过滤器')
      const fdRevertBtn = iconButton(ICON_REVERT, '还原未保存的修改')
      const fdDeleteBtn = iconButton(ICON_TRASH, '删除', 'apv-btn-danger')
      for (const node of [fdNameLabel, fdNameIn, fdSaveBtn, fdDupBtn, fdRevertBtn, fdDeleteBtn]) fdNameRow.appendChild(node)
      fdEdit.appendChild(fdNameRow)
      const fdNameErr = el('div', 'apv-fd-msg apv-warn', '')
      fdEdit.appendChild(fdNameErr)
      const fdMsg = el('div', 'apv-fd-msg', '')
      fdEdit.appendChild(fdMsg)
      const fdConfirm = el('div', 'apv-fd-confirm')
      fdConfirm.hidden = true
      fdEdit.appendChild(fdConfirm)
      const fdModeRow = el('div', 'apv-fd-moderow')
      fdModeRow.appendChild(el('span', '', '当'))
      const fdModeSel = el('select', 'apv-select apv-fd-mode')
      fdModeSel.setAttribute('aria-label', '条件怎么组合')
      ;[['all', '满足全部条件'], ['any', '满足任一条件']].forEach(([v, label]) => {
        const o = el('option', '', label)
        o.value = v
        fdModeSel.appendChild(o)
      })
      fdModeRow.appendChild(fdModeSel)
      fdModeRow.appendChild(el('span', '', '时显示'))
      fdModeRow.appendChild(el('span', 'apv-fd-spacer'))
      const fdClearCondsBtn = el('button', 'apv-btn', '清空全部条件')
      fdClearCondsBtn.type = 'button'
      const fdAddCondBtn = el('button', 'apv-btn', '+ 添加条件')
      fdAddCondBtn.type = 'button'
      fdModeRow.appendChild(fdClearCondsBtn)
      fdModeRow.appendChild(fdAddCondBtn)
      fdEdit.appendChild(fdModeRow)
      const fdConds = el('div', 'apv-fd-conds')
      fdEdit.appendChild(fdConds)
      const fdDefaultNote = el('div', 'apv-fd-default-note',
        '不使用自定义过滤器：列表只按上方工具栏和「更多 ▾」里的筛选显示。选它再点「应用」，就取消当前启用的过滤器。' +
        '过滤器存在宿主上，智能体查询（capture_query 的 filter 参数）和同事导入的都是同一份。')
      fdDefaultNote.hidden = true
      fdEdit.appendChild(fdDefaultNote)
      fdMain.appendChild(fdEdit)
      fdBox.appendChild(fdMain)
      const fdFoot = el('div', 'apv-fd-foot')
      const fdCount = el('span', 'apv-fd-count', '')
      fdCount.setAttribute('aria-live', 'polite')
      const fdCloseBtn = el('button', 'apv-btn', '关闭')
      fdCloseBtn.type = 'button'
      const fdApplyBtn = el('button', 'apv-btn apv-btn-primary', '应用')
      fdApplyBtn.type = 'button'
      fdFoot.appendChild(fdCount)
      fdFoot.appendChild(fdCloseBtn)
      fdFoot.appendChild(fdApplyBtn)
      fdBox.appendChild(fdFoot)
      view.appendChild(fdOverlay)
      // 模态：Tab 只在对话框里转；点遮罩不把焦点交给后面的面板（遮罩不关对话框，关用 Esc / 关闭）
      fdOverlay.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return
        const focusable = [...fdBox.querySelectorAll('button, input, select, textarea')].filter((n) => !n.disabled && n.offsetParent !== null)
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const at = document.activeElement
        if (event.shiftKey ? at === first || at === fdBox || !fdBox.contains(at) : at === last) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        }
      })
      fdOverlay.addEventListener('mousedown', (event) => {
        if (event.target !== fdOverlay) return
        event.preventDefault()
        fdBox.focus()
      })

      const fdIsOpen = () => !fdOverlay.hidden
      const savedById = (id) => fd.saved.find((f) => f.id === id)
      const draftFromSaved = (f) => ({
        key: f.id,
        savedId: f.id,
        name: String(f.name ?? ''),
        mode: f.mode === 'any' ? 'any' : 'all',
        conditions: cloneConditions(f.conditions),
        baseSig: filterSignature(f, fd.opsById),
      })
      const isDirty = (d) => d.savedId === null || filterSignature(d, fd.opsById) !== d.baseSig
      /** 选中项的编辑副本（按需从已存版本建一份）；'' = 默认，返回 null。 */
      const draftFor = (key) => {
        if (key === '') return null
        const existing = fd.drafts.get(key)
        if (existing !== undefined) return existing
        const s = savedById(key) ?? (state.activeFilter !== null && state.activeFilter.id === key ? state.activeFilter : undefined)
        if (s === undefined) return null
        const d = draftFromSaved(s)
        fd.drafts.set(key, d)
        return d
      }
      const currentDraft = () => draftFor(fd.selected)
      const newCondition = () => {
        const field = fd.fieldsById.get('url') ?? fd.fields[0]
        const usable = opsForField(field, fd.ops)
        const op = usable.find((o) => o.id === 'contains') ?? usable[0]
        return { enabled: true, field: field?.id ?? 'url', op: op?.id ?? 'contains', value: '', caseSensitive: false, header: '' }
      }
      const uniqueFilterName = (base) => {
        const stem = [...cleanFilterName(base)].slice(0, FILTER_NAME_MAX - 8).join('').trim() || '过滤器'
        const taken = new Set([
          ...fd.saved.map((f) => cleanFilterName(f.name).toLowerCase()),
          ...[...fd.drafts.values()].filter((d) => d.savedId === null).map((d) => cleanFilterName(d.name).toLowerCase()),
        ])
        if (!taken.has(stem.toLowerCase())) return stem
        for (let i = 2; i < 1000; i++) {
          const name = `${stem} (${i})`
          if (!taken.has(name.toLowerCase())) return name
        }
        return `${stem} ${Date.now()}`
      }
      const nameProblem = (d) => {
        const name = cleanFilterName(d.name)
        if (name === '') return '名称必填'
        if (codePoints(name) > FILTER_NAME_MAX) return `名称最多 ${FILTER_NAME_MAX} 个字符`
        const lower = name.toLowerCase()
        if (fd.saved.some((f) => f.id !== d.savedId && cleanFilterName(f.name).toLowerCase() === lower)) return '已有同名的过滤器（名称不区分大小写），换一个名字'
        return null
      }
      /**
       * 每个条件的问题（null = 没问题）：本地检查 + 宿主报的那一条（条件内容没变时才算数）。
       * 宿主刚接受过的条件（实时统计成功）不再用本地检查标红：两边对正则的理解不一致时以宿主为准。
       */
      const condProblems = (d) => {
        const accepted = fd.serverOk !== null && fd.serverOk.key === d.key ? fd.serverOk.sigs : null
        const out = d.conditions.map((c) => {
          const p = condProblem(c, fd.fieldsById, fd.opsById, fd.ops)
          return p !== null && accepted !== null && accepted.has(condSig(c, fd.opsById)) ? null : p
        })
        const se = fd.serverError
        if (se !== null && se.key === d.key && se.index >= 0 && se.index < d.conditions.length && condSig(d.conditions[se.index], fd.opsById) === se.sig) out[se.index] = se.message
        return out
      }
      /** 还没填值的条件（下标）：不标红，但不能统计、保存、应用。 */
      const incompleteConds = (d) => d.conditions.map((c, i) => (condIncomplete(c, fd.opsById) ? i : -1)).filter((i) => i >= 0)
      const generalProblem = (d) => {
        const se = fd.serverError
        return se !== null && se.key === d.key && se.index < 0 && se.sig === filterSignature(d, fd.opsById) ? se.message : null
      }
      const draftValid = (d) => nameProblem(d) === null && generalProblem(d) === null && incompleteConds(d).length === 0 && condProblems(d).every((p) => p === null)
      const setFdMsg = (kind, text) => {
        fdMsg.textContent = text ?? ''
        fdMsg.className = 'apv-fd-msg ' + (kind === 'ok' ? 'apv-ok' : kind === 'warn' ? 'apv-warn' : 'apv-note')
      }
      const hostMissingText = '宿主是旧版本，没有过滤器接口：需要重启 DSH 加载新插件。'

      // 当前启用的过滤器：存 prefs（id + 快照），列表 / 统计 / 导出 / AI 分析包都带上它
      const renderFilterButton = () => {
        const f = state.activeFilter
        filterLabel.textContent = f === null ? '过滤器' : `过滤器：${f.name}`
        filterGroup.classList.toggle('apv-fgroup-on', f !== null)
        filterClearBtn.hidden = f === null
        filterBtn.setAttribute('aria-pressed', f !== null ? 'true' : 'false')
        filterBtn.title = f === null
          ? '自定义过滤器（Fiddler 式）：按 进程 / URL / 状态码 / 请求头 … 组合条件，存成过滤器反复用；和这一排的筛选同时生效'
          : `当前过滤器「${f.name}」：${describeFilterText(f, fd.fieldsById, fd.opsById)}\n列表、统计、导出、AI 分析包都按它过滤。点击编辑，点 × 取消`
      }
      const setActiveFilter = (f) => {
        state.activeFilter = f === null ? null : activeFilterSnapshot(f)
        savePrefs()
        renderFilterButton()
        if (fdIsOpen()) renderFdList()
        refresh()
      }
      const dropActiveFilter = (note) => {
        setActiveFilter(null)
        if (note) showNotice('warn', note)
      }

      /** 宿主给的字段 / 比较方式表（GET /filters）；旧宿主没有就一直用内置的那份。 */
      const adoptFilterLists = (data) => {
        const fields = Array.isArray(data?.fields) ? data.fields.filter((f) => f !== null && typeof f === 'object' && typeof f.id === 'string' && f.id !== '') : []
        const ops = Array.isArray(data?.ops) ? data.ops.filter((o) => o !== null && typeof o === 'object' && typeof o.id === 'string' && o.id !== '') : []
        if (fields.length > 0) {
          fd.fields = fields
          fd.fieldsById = new Map(fields.map((f) => [f.id, f]))
        }
        if (ops.length > 0) {
          fd.ops = ops
          fd.opsById = new Map(ops.map((o) => [o.id, o]))
        }
      }
      /**
       * 宿主上的过滤器列表变了（读到新列表 / 保存 / 删除 / 导入后）：对齐编辑副本和当前启用的过滤器。
       * 别处删掉的：改过的副本留下（变成没保存的新过滤器），没改过的去掉；启用中的被删 → 恢复为不过滤并提示。
       * 返回选中项的编辑内容是否被换掉了（要不要重画右边）。
       */
      const syncSaved = (list) => {
        fd.saved = list.filter((f) => f !== null && typeof f === 'object' && typeof f.id === 'string' && f.id !== '')
        const byId = new Map(fd.saved.map((f) => [f.id, f]))
        let selectedChanged = false
        for (const [key, d] of [...fd.drafts]) {
          if (d.savedId === null) continue
          const s = byId.get(d.savedId)
          if (s === undefined) {
            fd.drafts.delete(key)
            if (isDirty(d)) {
              const nk = `new:${++fd.newSeq}`
              fd.drafts.set(nk, { ...d, key: nk, savedId: null, baseSig: '' })
              if (fd.selected === key) {
                fd.selected = nk
                selectedChanged = true
              }
            } else if (fd.selected === key) {
              fd.selected = ''
              selectedChanged = true
            }
            continue
          }
          const sig = filterSignature(s, fd.opsById)
          if (sig !== d.baseSig && (!isDirty(d) || filterSignature(d, fd.opsById) === sig)) {
            fd.drafts.set(key, draftFromSaved(s))
            if (fd.selected === key) selectedChanged = true
          }
        }
        if (fd.selected !== '' && !fd.drafts.has(fd.selected) && !byId.has(fd.selected)) {
          fd.selected = ''
          selectedChanged = true
        }
        const act = state.activeFilter
        if (act !== null) {
          const s = byId.get(act.id)
          if (s === undefined) dropActiveFilter(`过滤器「${act.name}」在宿主上已经没有了（可能在别的窗口里删除了，或被导入替换掉），列表已恢复为不过滤。`)
          else if (filterSignature(s, fd.opsById) !== filterSignature(act, fd.opsById) || (Number(s.updatedAt) || 0) !== act.updatedAt) setActiveFilter(s)
        }
        return selectedChanged
      }
      const filtersGate = latestGate()
      const loadFilters = ({ renderEditor = false } = {}) => {
        const seq = filtersGate.next()
        fd.syncing = true
        let selectedChanged = false
        return apiFetch('/filters')
          .then((data) => {
            if (!filtersGate.accept(seq)) return
            if (!Array.isArray(data?.filters)) {
              fd.hostSupport = false
              return
            }
            fd.hostSupport = true
            adoptFilterLists(data)
            selectedChanged = syncSaved(data.filters)
          })
          .catch((error) => {
            if (!filtersGate.accept(seq)) return
            if (error?.status === 404 && error?.code === undefined) fd.hostSupport = false
            else if (fdIsOpen()) setFdMsg('warn', `读取过滤器列表失败：${errText(error)}`)
          })
          .finally(() => {
            fd.syncing = false
            fd.loaded = true
            fd.lastSync = Date.now()
            renderFilterButton()
            if (fdIsOpen()) renderFd({ editor: renderEditor || selectedChanged })
          })
      }

      // ---- 对话框渲染
      let condRows = [] // [{ row, cond, errEl, valIn }]
      const renderFdList = () => {
        fdList.textContent = ''
        const activeId = state.activeFilter !== null ? state.activeFilter.id : null
        const addItem = (key, name, { check = false, dirty = false, note = '', title = '' } = {}) => {
          const item = el('button', 'apv-fd-item' + (key === '' ? ' apv-fd-item-default' : ''))
          item.type = 'button'
          item.setAttribute('role', 'option')
          item.setAttribute('aria-selected', fd.selected === key ? 'true' : 'false')
          item.dataset.key = key
          const checkEl = el('span', 'apv-fd-mark apv-fd-check', check ? '✓' : '')
          if (check) checkEl.title = '正在使用'
          item.appendChild(checkEl)
          item.appendChild(el('span', 'apv-fd-item-name', name))
          if (note !== '') item.appendChild(el('span', 'apv-note', note))
          const dirtyEl = el('span', 'apv-fd-mark apv-fd-dirty', dirty ? '●' : '')
          if (dirty) dirtyEl.title = '有没保存的修改'
          item.appendChild(dirtyEl)
          item.title = title !== '' ? title : name
          item.addEventListener('click', () => selectFd(key))
          fdList.appendChild(item)
        }
        addItem('', '默认（不过滤）', { check: activeId === null, title: '不使用自定义过滤器' })
        for (const f of fd.saved) {
          const d = fd.drafts.get(f.id)
          const dirty = d !== undefined && isDirty(d)
          addItem(f.id, String(f.name ?? ''), {
            check: activeId === f.id,
            dirty,
            title: `${f.name}\n${describeFilterText(f, fd.fieldsById, fd.opsById)}${dirty ? '\n● 有没保存的修改' : ''}`,
          })
        }
        if (activeId !== null && !fd.saved.some((f) => f.id === activeId)) {
          // 宿主的列表还没回来（或宿主是旧版本）：先按 prefs 里的快照显示当前启用的过滤器
          const d = fd.drafts.get(activeId)
          addItem(activeId, state.activeFilter.name, {
            check: true,
            dirty: d !== undefined && isDirty(d),
            note: fd.hostSupport === false ? '（宿主读不到）' : fd.loaded ? '' : '…',
            title: describeFilterText(state.activeFilter, fd.fieldsById, fd.opsById),
          })
        }
        for (const d of fd.drafts.values()) {
          if (d.savedId !== null) continue
          addItem(d.key, d.name.trim() || '（未命名）', { dirty: true, note: '未保存', title: `${d.name.trim() || '（未命名）'}\n还没保存：点「保存」或「应用」才存到宿主上` })
        }
      }
      const updateFdState = () => {
        const d = currentDraft()
        const hostOk = fd.hostSupport !== false
        fdHostNote.textContent = !hostOk ? `${hostMissingText}字段 / 比较方式先用内置的一份，现在不能保存。` : fd.loaded ? '' : '读取中…'
        fdHostNote.className = 'apv-fd-hostnote ' + (hostOk ? 'apv-note' : 'apv-warn')
        fdNewBtn.disabled = fd.busy
        fdImportBtn.disabled = fd.busy || !hostOk
        fdExportBtn.disabled = fd.busy || !hostOk
        if (d === null) {
          fdNameErr.textContent = ''
          fdApplyBtn.disabled = fd.busy
          fdApplyBtn.title = state.activeFilter === null ? '现在就是不过滤' : '取消当前过滤器，恢复为不过滤'
          return
        }
        const problems = condProblems(d)
        const incomplete = new Set(incompleteConds(d))
        condRows.forEach((r, i) => {
          const p = problems[i] ?? null
          r.errEl.textContent = p ?? ''
          r.row.classList.toggle('apv-fd-cond-bad', p !== null)
          r.row.classList.toggle('apv-fd-cond-todo', p === null && incomplete.has(i))
        })
        const dirty = isDirty(d)
        const np = nameProblem(d)
        const gp = generalProblem(d)
        fdNameErr.textContent = (dirty && np !== null ? np : '') + (gp !== null ? (dirty && np !== null ? '\n' : '') + gp : '')
        fdNameIn.classList.toggle('apv-fd-bad', dirty && np !== null)
        const red = np !== null || gp !== null || problems.some((p) => p !== null)
        const valid = !red && incomplete.size === 0
        const why = red ? '有标红的问题' : incomplete.size > 0 ? `第 ${[...incomplete].map((i) => i + 1).join('、')} 个条件还没填值` : ''
        fdSaveBtn.disabled = fd.busy || !hostOk || !dirty || !valid
        const saveTitle = !hostOk ? '保存（宿主是旧版本，现在不能保存）' : !dirty ? '保存（没有要保存的修改）' : !valid ? `保存（${why}，改好才能保存）` : '保存（不改变当前启用的过滤器）'
        fdSaveBtn.title = saveTitle
        fdSaveBtn.setAttribute('aria-label', saveTitle)
        fdDupBtn.disabled = fd.busy
        fdRevertBtn.disabled = fd.busy || !dirty
        fdDeleteBtn.disabled = fd.busy || (!hostOk && d.savedId !== null)
        fdAddCondBtn.disabled = d.conditions.length >= FILTER_COND_LIMIT
        fdAddCondBtn.title = d.conditions.length >= FILTER_COND_LIMIT ? `一个过滤器最多 ${FILTER_COND_LIMIT} 个条件` : '加一个条件'
        fdClearCondsBtn.disabled = d.conditions.length === 0
        fdApplyBtn.disabled = fd.busy || !valid || (!hostOk && (dirty || d.savedId === null))
        fdApplyBtn.title = !valid ? `${why}，改好才能应用` : dirty ? '保存修改并启用这个过滤器' : '启用这个过滤器（和上面的筛选同时生效）'
      }
      const renderFdConfirm = () => {
        fdConfirm.textContent = ''
        const d = currentDraft()
        const show = fd.confirmDelete && d !== null && d.savedId !== null
        fdConfirm.hidden = !show
        if (!show) return
        const name = savedById(d.savedId)?.name ?? d.name
        const inUse = state.activeFilter !== null && state.activeFilter.id === d.savedId
        fdConfirm.appendChild(el('span', '', `删除过滤器「${name}」？删除后不能恢复${inUse ? '；它正在使用，删除后列表恢复为不过滤' : ''}。`))
        const yes = el('button', 'apv-btn apv-btn-danger', '确认删除')
        yes.type = 'button'
        const no = el('button', 'apv-btn', '取消')
        no.type = 'button'
        yes.disabled = fd.busy
        yes.addEventListener('click', () => { fdDeleteNow(d) })
        no.addEventListener('click', () => {
          fd.confirmDelete = false
          renderFdConfirm()
        })
        fdConfirm.appendChild(yes)
        fdConfirm.appendChild(no)
      }
      const renderFdImport = () => {
        fdImportBox.textContent = ''
        const p = fd.pendingImport
        fdImportBox.hidden = p === null
        if (p === null) return
        fdImportBox.appendChild(el('div', '', `「${p.fileName}」里有 ${p.count} 个过滤器：`))
        const mergeBtn = el('button', 'apv-btn', '合并（同名不同内容的自动改名）')
        mergeBtn.title = '加到现有过滤器里：完全相同的跳过，同名但条件不同的改名为「名称 (2)」'
        const replaceBtn = el('button', 'apv-btn apv-btn-danger', `替换（清空现有 ${fd.saved.length} 个）`)
        replaceBtn.title = '过滤器列表变成文件里的这些，现有的全部删除'
        const cancelBtn = el('button', 'apv-btn', '取消')
        for (const b of [mergeBtn, replaceBtn, cancelBtn]) {
          b.type = 'button'
          b.disabled = fd.busy
          fdImportBox.appendChild(b)
        }
        mergeBtn.addEventListener('click', () => { fdSubmitImport('merge') })
        replaceBtn.addEventListener('click', () => { fdSubmitImport('replace') })
        cancelBtn.addEventListener('click', () => {
          fd.pendingImport = null
          renderFdImport()
        })
      }
      const buildCondRow = (d, cond) => {
        const row = el('div', 'apv-fd-cond')
        const main = el('div', 'apv-fd-cond-main')
        const onCb = el('input', 'apv-fd-cond-on')
        onCb.type = 'checkbox'
        onCb.checked = cond.enabled
        onCb.title = '启用这个条件（不勾 = 先不用，留在过滤器里）'
        onCb.setAttribute('aria-label', '启用这个条件')
        const fieldSel = el('select', 'apv-select apv-fd-field')
        fieldSel.setAttribute('aria-label', '字段')
        for (const f of fd.fields) {
          const o = el('option', '', f.label ?? f.id)
          o.value = f.id
          if (f.hint) o.title = f.hint
          fieldSel.appendChild(o)
        }
        if (!fd.fieldsById.has(cond.field)) {
          const o = el('option', '', `${cond.field}（未知字段）`)
          o.value = cond.field
          fieldSel.appendChild(o)
        }
        fieldSel.value = cond.field
        const headerIn = el('input', 'apv-fin apv-fd-header')
        headerIn.placeholder = '头名称（空 = 所有头）'
        headerIn.spellcheck = false
        headerIn.setAttribute('aria-label', '头名称')
        headerIn.value = cond.header
        const opSel = el('select', 'apv-select apv-fd-op')
        opSel.setAttribute('aria-label', '比较方式')
        const valWrap = el('span', 'apv-fd-valwrap')
        const valIn = el('input', 'apv-fin apv-fd-value')
        valIn.spellcheck = false
        valIn.setAttribute('aria-label', '值')
        valIn.value = cond.value
        const valClear = el('button', 'apv-fd-valclear', '×')
        valClear.type = 'button'
        valClear.title = '清空这个值'
        valClear.setAttribute('aria-label', '清空这个值')
        valWrap.appendChild(valIn)
        valWrap.appendChild(valClear)
        const caseBtn = el('button', 'apv-btn apv-fd-case', 'Aa')
        caseBtn.type = 'button'
        caseBtn.title = '区分大小写（默认不区分）'
        const delBtn = iconButton(ICON_TRASH, '删除这个条件', 'apv-btn-danger apv-fd-cdel')
        for (const node of [onCb, fieldSel, headerIn, opSel, valWrap, caseBtn, delBtn]) main.appendChild(node)
        const errEl = el('div', 'apv-fd-cond-err', '')
        row.appendChild(main)
        row.appendChild(errEl)
        const fillOps = () => {
          const usable = opsForField(fd.fieldsById.get(cond.field), fd.ops)
          opSel.textContent = ''
          for (const op of usable) {
            const o = el('option', '', op.label ?? op.id)
            o.value = op.id
            opSel.appendChild(o)
          }
          if (!usable.some((op) => op.id === cond.op)) {
            const o = el('option', '', `${fd.opsById.get(cond.op)?.label ?? cond.op}（不适用）`)
            o.value = cond.op
            opSel.appendChild(o)
          }
          opSel.value = cond.op
        }
        const sync = () => {
          const field = fd.fieldsById.get(cond.field)
          const op = fd.opsById.get(cond.op)
          headerIn.hidden = field?.header !== true
          valWrap.hidden = op !== undefined && op.needsValue === false
          caseBtn.hidden = !isTextOp(op)
          caseBtn.setAttribute('aria-pressed', cond.caseSensitive ? 'true' : 'false')
          caseBtn.setAttribute('aria-label', cond.caseSensitive ? '区分大小写（已打开）' : '区分大小写（已关闭）')
          valIn.placeholder = op !== undefined && isNumberOp(op) ? '数字' : isRegexOp(cond.op) ? '正则，例如 a|b（不用加 / /）' : field?.hint ? `值（${field.hint}）` : '值'
          valIn.inputMode = op !== undefined && isNumberOp(op) ? 'decimal' : 'text'
          valClear.hidden = cond.value === ''
          row.classList.toggle('apv-fd-cond-off', !cond.enabled)
          fieldSel.title = field?.hint ? `${field.label ?? field.id}：${field.hint}` : '字段'
        }
        fillOps()
        sync()
        onCb.addEventListener('change', () => {
          cond.enabled = onCb.checked
          sync()
          onDraftChanged()
        })
        fieldSel.addEventListener('change', () => {
          const prevKind = fieldKind(fd.fieldsById.get(cond.field))
          cond.field = fieldSel.value
          const field = fd.fieldsById.get(cond.field)
          if (field?.header !== true) {
            cond.header = ''
            headerIn.value = ''
          }
          // 换了字段：文本 ↔ 数字时换成新字段的默认比较方式（数字 =、文本 包含）；原来的比较方式不适用时也换
          const usable = opsForField(field, fd.ops)
          if (usable.length > 0 && (fieldKind(field) !== prevKind || !usable.some((op) => op.id === cond.op))) cond.op = usable[0].id
          if (!isTextOp(fd.opsById.get(cond.op))) cond.caseSensitive = false
          fillOps()
          sync()
          onDraftChanged()
        })
        headerIn.addEventListener('input', () => {
          cond.header = headerIn.value
          onDraftChanged()
        })
        opSel.addEventListener('change', () => {
          cond.op = opSel.value
          if (!isTextOp(fd.opsById.get(cond.op))) cond.caseSensitive = false
          sync()
          onDraftChanged()
        })
        valIn.addEventListener('input', () => {
          cond.value = valIn.value
          valClear.hidden = cond.value === ''
          onDraftChanged()
        })
        valClear.addEventListener('click', () => {
          cond.value = ''
          valIn.value = ''
          valClear.hidden = true
          valIn.focus()
          onDraftChanged()
        })
        caseBtn.addEventListener('click', () => {
          cond.caseSensitive = !cond.caseSensitive
          sync()
          onDraftChanged()
        })
        delBtn.addEventListener('click', () => {
          const i = d.conditions.indexOf(cond)
          if (i >= 0) d.conditions.splice(i, 1)
          renderConds()
          onDraftChanged()
        })
        return { row, cond, errEl, valIn }
      }
      const renderConds = () => {
        fdConds.textContent = ''
        condRows = []
        const d = currentDraft()
        if (d === null) return
        if (d.conditions.length === 0) {
          fdConds.appendChild(el('div', 'apv-fd-empty', '没有条件：这个过滤器匹配全部记录。点「+ 添加条件」加一条。'))
          return
        }
        for (const cond of d.conditions) {
          const r = buildCondRow(d, cond)
          condRows.push(r)
          fdConds.appendChild(r.row)
        }
      }
      const renderFdEditor = () => {
        const d = currentDraft()
        const isDefault = d === null
        fdNameRow.hidden = isDefault
        fdModeRow.hidden = isDefault
        fdConds.hidden = isDefault
        fdDefaultNote.hidden = !isDefault
        if (!isDefault) {
          if (fdNameIn.value !== d.name) fdNameIn.value = d.name
          fdModeSel.value = d.mode
        }
        renderConds()
        updateFdState()
      }
      const renderFd = ({ editor = true } = {}) => {
        renderFdList()
        if (editor) renderFdEditor()
        else updateFdState()
        renderFdConfirm()
        renderFdImport()
      }

      // ---- 实时匹配条数（GET /records?limit=1&conditions=…，防抖 300ms；只认最后一次的结果）
      const countGate = latestGate()
      let countTimer = null
      const setCount = (parts) => {
        fdCount.textContent = ''
        for (const p of parts) fdCount.appendChild(typeof p === 'string' ? document.createTextNode(p) : p)
      }
      const runCount = () => {
        if (!fdIsOpen()) return
        const seq = countGate.next()
        const d = currentDraft()
        const params = new URLSearchParams({ limit: '1' })
        let sentSigs = []
        let sentWhole = ''
        const settle = (parts) => {
          countGate.accept(seq) // 让还在路上的旧统计作废
          if (countTimer === null) fdCount.classList.remove('apv-fd-counting')
          setCount(parts)
        }
        if (d !== null) {
          const todo = incompleteConds(d)
          if (todo.length > 0) {
            // 空值宿主会拒（值不能为空），先不问：等填好再统计
            settle([`第 ${todo.map((i) => i + 1).join('、')} 个条件还没填值，填好后显示匹配条数`])
            return
          }
          const json = JSON.stringify(filterPayload(d, fd.opsById))
          if (encodeURIComponent(json).length > FILTER_QUERY_MAX) {
            settle(['条件太长，放不进查询串，没法实时统计；保存后列表照常按它过滤（宿主按 id 取）'])
            return
          }
          params.set('conditions', json)
          sentSigs = d.conditions.map((c) => condSig(c, fd.opsById))
          sentWhole = filterSignature(d, fd.opsById)
        }
        const key = d === null ? '' : d.key
        apiFetch(`/records?${params.toString()}`)
          .then((data) => {
            if (!countGate.accept(seq) || !fdIsOpen()) return
            if (countTimer === null) fdCount.classList.remove('apv-fd-counting')
            if (fd.serverError !== null && fd.serverError.key === key) fd.serverError = null
            // 宿主接受了这一组条件：其中本地检查和宿主看法不一致的（例如宿主认的正则写法）以宿主为准
            if (d !== null) fd.serverOk = { key, sigs: new Set(sentSigs) }
            const total = Number(data?.total)
            const totalEl = el('b', '', Number.isFinite(total) ? String(total) : '?')
            if (d === null) setCount(['当前库中匹配 ', totalEl, ' 条（默认：不过滤）'])
            else if (!Array.isArray(data?.filterApplied) && enabledCondCount(d) > 0) setCount(['当前库中匹配 ', totalEl, ' 条 · ', el('span', 'apv-warn', '宿主没有应用这些条件（旧版本？需要重启 DSH），这是全部记录数')])
            else setCount(['当前库中匹配 ', totalEl, ' 条'])
            updateFdState()
          })
          .catch((error) => {
            if (!countGate.accept(seq) || !fdIsOpen()) return
            if (countTimer === null) fdCount.classList.remove('apv-fd-counting')
            if (error?.code === 'FILTER_INVALID' && d !== null) {
              const index = filterErrorIndex(error)
              const known = index >= 0 && index < sentSigs.length
              fd.serverError = { key, index: known ? index : -1, sig: known ? sentSigs[index] : sentWhole, message: errText(error) }
              setCount([el('span', 'apv-warn', known ? `第 ${index + 1} 个条件有问题，改好才能统计和应用` : `条件有问题：${errText(error)}`)])
              updateFdState()
              return
            }
            setCount([el('span', 'apv-warn', `统计失败：${errText(error)}`)])
          })
      }
      const scheduleCount = (delay = 300) => {
        if (countTimer !== null) clearTimeout(countTimer)
        fdCount.classList.add('apv-fd-counting')
        countTimer = setTimeout(() => {
          countTimer = null
          runCount()
        }, delay)
      }

      // ---- 对话框操作
      const onDraftChanged = ({ count = true } = {}) => {
        if (fd.confirmDelete) {
          fd.confirmDelete = false
          renderFdConfirm()
        }
        renderFdList()
        updateFdState()
        if (count) scheduleCount()
      }
      const selectFd = (key) => {
        if (fd.selected === key) return
        fd.selected = key
        fd.confirmDelete = false
        setFdMsg(null)
        renderFd()
        scheduleCount(0)
      }
      const setFdBusy = (busy) => {
        fd.busy = busy
        updateFdState()
        renderFdConfirm()
        renderFdImport()
      }
      const fdSavePayload = (d) => ({
        ...(d.savedId !== null ? { id: d.savedId } : {}),
        name: d.name.trim(),
        mode: d.mode === 'any' ? 'any' : 'all',
        conditions: d.conditions.map((c) => ({ ...(typeof c.id === 'string' && c.id !== '' ? { id: c.id } : {}), ...canonCond(c, fd.opsById) })),
      })
      /** POST /filters：成功后换成宿主规范化过的版本（id、条件 id、去空白的名称…），返回保存后的过滤器。 */
      const saveDraft = async (d) => {
        const data = await apiFetch('/filters', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filter: fdSavePayload(d) }),
        })
        const saved = data?.filter
        if (saved === null || typeof saved !== 'object' || typeof saved.id !== 'string' || saved.id === '') throw new Error('宿主没有返回保存后的过滤器')
        fd.drafts.delete(d.key)
        if (fd.serverError !== null && fd.serverError.key === d.key) fd.serverError = null
        if (fd.selected === d.key) fd.selected = saved.id
        syncSaved(Array.isArray(data.filters) ? data.filters : [...fd.saved.filter((f) => f.id !== saved.id), saved])
        return saved
      }
      const showSaveError = (d, error) => {
        const msg = errText(error)
        if (error?.code === 'FILTER_INVALID') {
          const index = filterErrorIndex(error)
          const known = index >= 0 && index < d.conditions.length
          fd.serverError = { key: d.key, index: known ? index : -1, sig: known ? condSig(d.conditions[index], fd.opsById) : filterSignature(d, fd.opsById), message: msg }
          setFdMsg('warn', `保存失败：${msg}`)
        } else if (error?.code === 'FILTER_NAME_TAKEN') {
          setFdMsg('warn', `保存失败：${msg}（换一个名字）`)
        } else if (error?.status === 404 && error?.code === undefined) {
          fd.hostSupport = false
          setFdMsg('warn', `保存失败：${hostMissingText}`)
        } else if (error?.status === 413 || error?.code === 'BODY_TOO_LARGE') {
          setFdMsg('warn', `保存失败：过滤器太大，宿主拒收（${msg}）`)
        } else {
          setFdMsg('warn', `保存失败：${msg}`)
        }
        updateFdState()
      }
      const fdSave = async () => {
        const d = currentDraft()
        if (d === null || fd.busy || !draftValid(d) || !isDirty(d)) return
        setFdBusy(true)
        setFdMsg('note', '正在保存…')
        try {
          const saved = await saveDraft(d)
          const inUse = state.activeFilter !== null && state.activeFilter.id === saved.id
          setFdMsg('ok', `已保存「${saved.name}」${inUse ? '（正在使用，列表已按新条件刷新）' : '（还没启用：点「应用」才用它过滤列表）'}`)
          renderFd()
          scheduleCount(0)
        } catch (error) {
          showSaveError(d, error)
        } finally {
          setFdBusy(false)
        }
      }
      const closeFilterDialog = () => {
        if (fdOverlay.hidden) return
        fdOverlay.hidden = true
        fd.confirmDelete = false
        fd.pendingImport = null
        if (countTimer !== null) {
          clearTimeout(countTimer)
          countTimer = null
        }
        // 没改过的副本不留（下次打开按宿主的最新版本显示）；改过没保存的留着，列表里带 ●
        for (const [key, d] of [...fd.drafts]) {
          if (!isDirty(d)) fd.drafts.delete(key)
        }
        if (fdBox.contains(document.activeElement)) filterBtn.focus()
      }
      const fdApply = async () => {
        if (fd.busy) return
        const d = currentDraft()
        if (d === null) {
          closeFilterDialog()
          if (state.activeFilter !== null) setActiveFilter(null)
          return
        }
        if (!draftValid(d)) {
          updateFdState()
          return
        }
        let target = d.savedId !== null ? savedById(d.savedId) : undefined
        // 旧宿主读不到列表时，没改过的「当前过滤器」就用快照
        if (target === undefined && !isDirty(d) && state.activeFilter !== null && state.activeFilter.id === d.savedId) target = state.activeFilter
        if (isDirty(d) || target === undefined) {
          setFdBusy(true)
          setFdMsg('note', '正在保存…')
          try {
            target = await saveDraft(d)
          } catch (error) {
            showSaveError(d, error)
            return
          } finally {
            setFdBusy(false)
          }
        }
        setFdMsg(null)
        closeFilterDialog()
        setActiveFilter(target)
      }
      const fdDeleteNow = async (d) => {
        if (fd.busy || d.savedId === null) return
        const id = d.savedId
        const name = savedById(id)?.name ?? d.name
        setFdBusy(true)
        try {
          const data = await apiFetch(`/filters?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
          fd.confirmDelete = false
          fd.drafts.delete(d.key)
          if (fd.selected === d.key) fd.selected = ''
          // 删的是正在用的：这里删的，提示说清楚（不走「被别处删除」那句）
          if (state.activeFilter !== null && state.activeFilter.id === id) dropActiveFilter(`已删除过滤器「${name}」，列表恢复为不过滤。`)
          syncSaved(Array.isArray(data?.filters) ? data.filters : fd.saved.filter((f) => f.id !== id))
          setFdMsg('ok', `已删除「${name}」`)
        } catch (error) {
          if (error?.code === 'FILTER_NOT_FOUND') {
            fd.confirmDelete = false
            setFdMsg('warn', `「${name}」在宿主上已经没有了（可能在别处删除了），列表已刷新`)
            loadFilters({ renderEditor: true })
          } else {
            setFdMsg('warn', `删除失败：${errText(error)}`)
          }
        } finally {
          setFdBusy(false)
          renderFd()
          scheduleCount(0)
        }
      }
      const renamedText = (x) => {
        if (typeof x === 'string') return x
        if (x !== null && typeof x === 'object') return `${x.from ?? x.name ?? x.original ?? '?'} → ${x.to ?? x.renamed ?? x.newName ?? '?'}`
        return String(x)
      }
      const fdSubmitImport = async (mode) => {
        const p = fd.pendingImport
        if (p === null || fd.busy) return
        setFdBusy(true)
        try {
          const r = await apiFetch('/filters/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: p.data, mode }) })
          fd.pendingImport = null
          // renamed 是个数、renames 是 [{ from, to }]（旧写法 renamed 直接是列表也认）
          const renameList = Array.isArray(r?.renames) ? r.renames : Array.isArray(r?.renamed) ? r.renamed : []
          const renamed = renameList.map(renamedText)
          const renamedCount = Number.isFinite(Number(r?.renamed)) && !Array.isArray(r?.renamed) ? Number(r.renamed) : renameList.length
          syncSaved(Array.isArray(r?.filters) ? r.filters : fd.saved)
          setFdMsg('ok', `已导入 ${Number(r?.imported) || 0} 个，跳过 ${Number(r?.skipped) || 0} 个相同的` +
            (renamedCount > 0 ? `，${renamedCount} 个重名的改了名${renamed.length > 0 ? '：' + renamed.join('、') : ''}` : '') +
            (mode === 'replace' ? '（原来的过滤器已替换掉）' : ''))
        } catch (error) {
          setFdMsg('warn', error?.status === 404 && error?.code === undefined
            ? `导入失败：${hostMissingText}`
            : error?.status === 413 || error?.code === 'BODY_TOO_LARGE' ? `导入失败：文件太大，宿主拒收（${errText(error)}）` : `导入失败：${errText(error)}`)
        } finally {
          setFdBusy(false)
          renderFd()
          scheduleCount(0)
        }
      }
      const openFilterDialog = () => {
        if (state.activeFilter !== null) fd.selected = state.activeFilter.id
        else if (fd.selected !== '' && draftFor(fd.selected) === null) fd.selected = ''
        fd.confirmDelete = false
        fd.pendingImport = null
        setFdMsg(null)
        fdOverlay.hidden = false
        renderFd()
        loadFilters({ renderEditor: true })
        scheduleCount(0)
        fdBox.focus()
      }

      filterBtn.addEventListener('click', openFilterDialog)
      filterClearBtn.addEventListener('click', () => {
        if (state.activeFilter !== null) setActiveFilter(null)
      })
      fdX.addEventListener('click', closeFilterDialog)
      fdCloseBtn.addEventListener('click', closeFilterDialog)
      fdApplyBtn.addEventListener('click', () => { fdApply() })
      fdSaveBtn.addEventListener('click', () => { fdSave() })
      fdNameIn.addEventListener('input', () => {
        const d = currentDraft()
        if (d === null) return
        d.name = fdNameIn.value
        onDraftChanged({ count: false })
      })
      fdModeSel.addEventListener('change', () => {
        const d = currentDraft()
        if (d === null) return
        d.mode = fdModeSel.value === 'any' ? 'any' : 'all'
        onDraftChanged()
      })
      fdAddCondBtn.addEventListener('click', () => {
        const d = currentDraft()
        if (d === null || d.conditions.length >= FILTER_COND_LIMIT) return
        d.conditions.push(newCondition())
        renderConds()
        onDraftChanged()
        const last = condRows[condRows.length - 1]
        if (last !== undefined) {
          last.row.scrollIntoView({ block: 'nearest' })
          last.valIn.focus()
        }
      })
      fdClearCondsBtn.addEventListener('click', () => {
        const d = currentDraft()
        if (d === null || d.conditions.length === 0) return
        d.conditions = []
        renderConds()
        onDraftChanged()
      })
      fdNewBtn.addEventListener('click', () => {
        const key = `new:${++fd.newSeq}`
        fd.drafts.set(key, { key, savedId: null, name: uniqueFilterName('新过滤器'), mode: 'all', conditions: [newCondition()], baseSig: '' })
        fd.selected = key
        fd.confirmDelete = false
        setFdMsg('note', '新过滤器（还没保存）：填好名称和条件，点「保存」或「应用」')
        renderFd()
        scheduleCount(0)
        fdNameIn.focus()
        fdNameIn.select()
      })
      fdDupBtn.addEventListener('click', () => {
        const d = currentDraft()
        if (d === null || fd.busy) return
        const key = `new:${++fd.newSeq}`
        const conditions = cloneConditions(d.conditions).map((c) => {
          const copy = { ...c }
          delete copy.id
          return copy
        })
        fd.drafts.set(key, { key, savedId: null, name: uniqueFilterName(`${d.name.trim() || '过滤器'} 副本`), mode: d.mode, conditions, baseSig: '' })
        fd.selected = key
        fd.confirmDelete = false
        setFdMsg('note', '已复制为新过滤器（还没保存）：改好名称点「保存」或「应用」')
        renderFd()
        scheduleCount(0)
        fdNameIn.focus()
        fdNameIn.select()
      })
      fdRevertBtn.addEventListener('click', () => {
        const d = currentDraft()
        if (d === null || !isDirty(d)) return
        fd.drafts.delete(d.key)
        if (fd.serverError !== null && fd.serverError.key === d.key) fd.serverError = null
        if (d.savedId === null || draftFor(d.key) === null) fd.selected = state.activeFilter !== null ? state.activeFilter.id : ''
        fd.confirmDelete = false
        setFdMsg('note', d.savedId === null ? '已丢弃这个没保存的新过滤器' : '已还原为保存的版本')
        renderFd()
        scheduleCount(0)
      })
      fdDeleteBtn.addEventListener('click', () => {
        const d = currentDraft()
        if (d === null || fd.busy) return
        if (d.savedId === null) {
          // 没保存过的新过滤器：直接丢掉，不用确认
          fd.drafts.delete(d.key)
          fd.selected = state.activeFilter !== null ? state.activeFilter.id : ''
          setFdMsg('note', '已丢弃这个没保存的新过滤器')
          renderFd()
          scheduleCount(0)
          return
        }
        fd.confirmDelete = true
        renderFdConfirm()
      })
      fdImportBtn.addEventListener('click', () => fdImportFile.click())
      fdImportFile.addEventListener('change', () => {
        const file = fdImportFile.files && fdImportFile.files[0]
        fdImportFile.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onerror = () => setFdMsg('warn', '读取文件失败')
        reader.onload = () => {
          let text = String(reader.result ?? '')
          if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            setFdMsg('warn', `「${file.name}」不是有效的 JSON 文件`)
            return
          }
          const list = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.filters) ? parsed.filters : null
          if (list === null) {
            setFdMsg('warn', `「${file.name}」里没有过滤器列表：要用「导出」得到的文件（或过滤器数组）`)
            return
          }
          fd.pendingImport = { data: parsed, count: list.length, fileName: file.name }
          setFdMsg(null)
          renderFdImport()
        }
        reader.readAsText(file)
      })
      fdExportBtn.addEventListener('click', () => {
        if (fd.busy) return
        fdExportBtn.disabled = true
        apiFetchText('/filters/export')
          .then((text) => {
            let count = null
            try {
              const env = JSON.parse(text)
              count = Array.isArray(env?.filters) ? env.filters.length : Array.isArray(env) ? env.length : null
            } catch {
              count = null
            }
            const name = `api-filters-${fileStamp()}.json`
            downloadBlob(name, prettyJsonText(text) + '\n', 'application/json')
            const unsaved = [...fd.drafts.values()].filter(isDirty).length
            setFdMsg('ok', `已导出${count !== null ? ` ${count} 个过滤器` : ''} → ${name}${unsaved > 0 ? `（${unsaved} 个没保存的修改不在文件里）` : ''}`)
          })
          .catch((error) => setFdMsg('warn', error?.status === 404 && error?.code === undefined ? `导出失败：${hostMissingText}` : `导出失败：${errText(error)}`))
          .finally(() => updateFdState())
      })

      // ---- 统计行里的过滤器说明 + 统计类视图的提醒
      const renderFilterStat = (sent, list) => {
        if (sent === null) return
        const appliedList = Array.isArray(list?.filterApplied) ? list.filterApplied : null
        const applied = appliedList !== null || enabledCondCount(sent.filter) === 0
        stats.appendChild(document.createTextNode(' · '))
        const chip = el('span', 'apv-statchip apv-statfilter' + (applied ? '' : ' apv-warn'), applied
          ? `过滤器「${sent.filter.name}」· 匹配 ${Number.isFinite(Number(list?.total)) ? Number(list.total) : '?'} 条`
          : `⚠ 过滤器「${sent.filter.name}」没生效（宿主旧版本？需要重启 DSH）`)
        const desc = appliedList !== null
          ? appliedList.map((a) => (a !== null && typeof a === 'object' ? `${a.name ?? ''}：${a.description ?? ''}` : '')).filter((s) => s !== '').join('\n')
          : ''
        chip.title = `${desc !== '' ? desc : describeFilterText(sent.filter, fd.fieldsById, fd.opsById)}\n点击编辑过滤器`
        chip.addEventListener('click', openFilterDialog)
        stats.appendChild(chip)
      }
      const listGate = latestGate()
      // ---- 多客户端捕获库：工具栏「客户端」下拉
      // 宿主的 /capture/status 带 captureClient（当前客户端 / 模式 / 记录目录）；客户端列表与「是否在跑」来自 GET /capture-clients。
      const clientsUi = { key: '', info: null, view: null, loadedAt: 0, loading: false, posting: false }
      const CLIENTS_RELOAD_MS = 15000
      const renderClientSel = () => {
        const info = clientsUi.info
        const view = clientsUi.view
        if (info === null || info.configured !== true) {
          clientSel.hidden = true
          return
        }
        clientSel.hidden = false
        // 正在操作这个下拉时不重建选项（会把展开的列表收起来）
        if (document.activeElement === clientSel) return
        const list = view !== null && Array.isArray(view.clients) ? view.clients : []
        const manual = info.mode === 'manual'
        clientSel.textContent = ''
        const auto = el('option', '', `客户端：自动（${info.client ?? '无'}）`)
        auto.value = '__auto__'
        auto.title = '跟随最近启动的客户端（关掉客户端后仍显示它的记录）'
        clientSel.appendChild(auto)
        const names = list.length > 0 ? list.map((c) => c.name) : (info.client !== null ? [info.client] : [])
        for (const name of names) {
          const c = list.find((x) => x.name === name)
          const running = c !== undefined && c.running === true
          const locked = manual && name === info.client
          const opt = el('option', '', `客户端：${name}${locked ? '（锁定）' : ''}${running ? ' ●' : ''}`)
          opt.value = name
          opt.title = `${c !== undefined ? `进程 ${c.processes.join(' / ')} · 记录目录 ${c.dir}` : name}${running ? ' · 正在运行' : ''}`
          clientSel.appendChild(opt)
        }
        clientSel.value = manual && info.client !== null ? info.client : '__auto__'
      }
      const loadClientsView = () => {
        if (clientsUi.loading) return
        clientsUi.loading = true
        apiFetch('/capture-clients')
          .then((view) => {
            clientsUi.view = view
            clientsUi.loadedAt = Date.now()
            renderClientSel()
          })
          .catch(() => { clientsUi.loadedAt = Date.now() }) // 宿主太旧没有这个路由：下拉只显示当前客户端
          .finally(() => { clientsUi.loading = false })
      }
      /** 轮询拿到的 captureClient；当前客户端变了（自动跟随切换，或在别的窗口锁定）⇒ 关详情、整表重画、马上再拉一次列表。返回是否切换了。 */
      const applyClientInfo = (info) => {
        const next = info !== null && typeof info === 'object' ? info : null
        const key = next === null || next.configured !== true ? '' : `${next.client}|${next.mode}|${next.recordsDir}`
        const switched = clientsUi.key !== '' && key !== '' && key !== clientsUi.key && clientsUi.key.split('|')[2] !== key.split('|')[2]
        clientsUi.key = key
        clientsUi.info = next
        if (key !== '' && (clientsUi.view === null || switched || Date.now() - clientsUi.loadedAt > CLIENTS_RELOAD_MS)) loadClientsView()
        renderClientSel()
        if (switched) {
          closeDetail()
          state.lastRenderKey = ''
        }
        return switched
      }
      clientSel.addEventListener('mousedown', () => {
        if (Date.now() - clientsUi.loadedAt > 3000) loadClientsView()
      })
      clientSel.addEventListener('change', () => {
        if (clientsUi.posting) return
        const value = clientSel.value
        const body = value === '__auto__' ? { mode: 'auto' } : { active: value, mode: 'manual' }
        clientsUi.posting = true
        clientSel.disabled = true
        apiFetch('/capture-clients', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then((view) => {
            clientsUi.view = view
            clientsUi.loadedAt = Date.now()
            const switched = applyClientInfo(view)
            if (!switched) state.lastRenderKey = ''
            clientSel.blur()
            renderClientSel()
            refresh()
          })
          .catch((error) => {
            stats.textContent = `切换客户端失败: ${error instanceof Error ? error.message : String(error)}`
            renderClientSel()
          })
          .finally(() => {
            clientsUi.posting = false
            clientSel.disabled = false
          })
      })

      const refresh = async () => {
        const seq = listGate.next()
        let filterSent = null
        try {
          const params = setQuickParams(new URLSearchParams({ limit: String(LIMIT) }))
          filterSent = setFilterParam(params)
          // 启用着过滤器：隔一阵和宿主对一次（在别的窗口里删了 / 改了要跟上）
          if (state.activeFilter !== null && !fd.syncing && Date.now() - fd.lastSync > FILTER_SYNC_MS) loadFilters()
          const [listRes, stat, cap, prox] = await Promise.all([
            apiFetch(`/records?${params.toString()}`).then((value) => ({ value }), (error) => ({ error })),
            apiFetch('/stats'),
            apiFetch('/capture/status').catch(() => null),
            apiFetch('/proxy/status').catch(() => null),
          ])
          if (listRes.error !== undefined) {
            if (filterSent !== null && listRes.error?.code === 'FILTER_NOT_FOUND' && listGate.accept(seq)) {
              dropActiveFilter(`过滤器「${filterSent.filter.name}」在宿主上已经没有了（可能在别处删除了），列表已恢复为不过滤。`)
              return
            }
            throw listRes.error
          }
          const list = listRes.value
          const active = activeView()
          let viewData = null
          if (active === 'session') {
            viewData = await apiFetch(`/stats/sessions?${params.toString()}`).catch(() => null)
          } else if (active === 'timeline') {
            viewData = await apiFetch(`/stats/timeline?bucketMs=60000&${params.toString()}`).catch(() => null)
          } else if (active === 'waterfall') {
            const wp = new URLSearchParams(params.toString())
            wp.set('limit', '500')
            viewData = await apiFetch(`/records?${wp.toString()}`).catch(() => null)
          } else if (active === 'tree') {
            // Same filter and limit: reuse this refresh's snapshot instead of querying it twice.
            viewData = list
          } else if (active === 'repeats') {
            viewData = await apiFetch(`/stats/repeats?windowMs=10000&minCount=5&${params.toString()}`).catch(() => null)
          } else if (active === 'baseline') {
            viewData = await apiFetch('/baseline/list').catch(() => null)
          }
          // 并发的几次刷新只认最后发出的那次：晚到的旧响应（例如切换过滤器之前发出的轮询）不覆盖新列表
          if (!listGate.accept(seq)) return
          // 当前客户端刚切换：这一轮的列表可能还是旧库的 —— 不画它，马上按新库再拉一次
          if (applyClientInfo(cap !== null && cap !== undefined ? cap.captureClient : null)) {
            renderCapture(cap)
            renderProxy(prox)
            setTimeout(() => { refresh() }, 0)
            return
          }
          renderStats(stat)
          renderFilterStat(filterSent, list)
          renderCapture(cap)
          renderProxy(prox)
          if (!bpWrap.hidden) loadBreakpoints() // 断点面板打开时随轮询刷新挂起列表
          if (!icWrap.hidden) loadIntercept({ poll: true }) // 透明拦截面板打开时刷新计数/告警（证书/计划任务部分宿主缓存 30 秒）
          // 规则面板打开时：规则集版本变了（智能体加/删了规则）就重拉列表；只重画表格，不动正在填的表单（C12）
          const rulesRev = prox !== null && prox !== undefined && prox.rules !== undefined && prox.rules !== null ? prox.rules.revision : undefined
          if (!rulesWrap.hidden && typeof rulesRev === 'string' && rulesRev !== rulesRevision && rulesLoading === 0) loadRules()
          if (!nsWrap.hidden) loadNetsim() // 弱网面板打开时跟着刷新（正在改的输入框不覆盖，C43）
          if (active === 'baseline') renderBaselineSel(viewData?.items ?? [])
          // 渲染键用这次请求真正带出去的参数（含过滤条件），不用此刻的 state：否则切换筛选前发出的旧响应会顶着新键渲染，
          // 新响应回来时键相同反而不渲染。表格视图再带上行内容签名：同一 id 的记录后来补上了进程 / 耗时也会重画（增量，不整表重建）。
          const items = Array.isArray(list?.items) ? list.items : []
          // R5-05：打开着的详情：列表里同一条记录后来补上了进程（本地代理 / 透明拦截按端口查进程是异步的）⇒ 只重画「进程」一行
          if (currentFull !== null) {
            const fresh = items.find((r) => r !== null && typeof r === 'object' && r.id === currentFull.id)
            const hasProc = fresh !== undefined && ((typeof fresh.clientProcess === 'string' && fresh.clientProcess !== '') || Number.isInteger(fresh.clientPid))
            if (hasProc && (fresh.clientProcess !== currentFull.clientProcess || fresh.clientPid !== currentFull.clientPid)) {
              currentFull.clientProcess = fresh.clientProcess
              currentFull.clientPid = fresh.clientPid
              const oldLine = detailBody.querySelector('.apv-dproc')
              if (oldLine !== null) oldLine.replaceWith(buildProcLine(currentFull))
            }
          }
          const key = `${stat.total}|${stat.lastTs}|${list?.total}|${params.toString()}|${active}|${active === null ? items.map(rowSig).join('\n') : ''}`
          if (key !== state.lastRenderKey) {
            state.lastRenderKey = key
            if (active === 'session') {
              renderSessions(viewData)
            } else if (active === 'timeline') {
              renderTimeline(viewData)
            } else if (active === 'waterfall') {
              renderWaterfall(viewData?.items ?? [])
            } else if (active === 'repeats') {
              renderRepeats(viewData)
            } else if (active === 'baseline') {
              renderBaselineList(viewData?.items ?? [])
            } else if (active === 'agg') {
              apiFetch(`/stats/endpoints?${params.toString()}`).then(renderAgg).catch(() => {})
            } else if (active === 'tree') {
              pendingTreeRecords = viewData?.items ?? []
              renderTree()
            } else {
              renderRows(items)
            }
          }
        } catch (error) {
          if (!listGate.accept(seq)) return
          if (filterSent !== null && error?.code === 'FILTER_INVALID') {
            stats.textContent = `过滤器「${filterSent.filter.name}」用不了：${errText(error)}（点「过滤器」修改，或点 × 取消）`
            return
          }
          stats.textContent = `加载失败: ${error instanceof Error ? error.message : String(error)}`
        }
      }

      const scheduleNext = () => {
        if (!state.open) return
        if (state.timer !== null) clearTimeout(state.timer)
        state.timer = setTimeout(() => {
          state.timer = null
          if (!state.open) return
          if (state.frozen) { scheduleNext(); return } // 冻结：跳过刷新但保持轮询循环
          refresh().finally(scheduleNext)
        }, state.capture.running || state.proxy.running || state.proxy.interceptListening ? POLL_LIVE_MS : POLL_MS)
      }

      const setOpen = (open) => {
        state.open = open
        if (open) {
          if (state.timer !== null) {
            clearTimeout(state.timer)
            state.timer = null
          }
          // exclusive with sibling panels
          delete document.documentElement.dataset.dshTaskboardActive
          delete document.documentElement.dataset.dshSshActive
          delete document.documentElement.dataset.dshPostmanActive
          document.documentElement.dataset.dshApivizActive = 'true'
          if (state.detailHeight !== null) requestAnimationFrame(() => setDetailHeight(state.detailHeight, false))
          refresh().finally(scheduleNext)
          // 偏好：打开面板即自动开始捕获（未运行时）
          if (autoCapCb.checked && !state.capture.running) {
            const logPath = logPathIn.value.trim()
            apiFetch('/capture/start', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(logPath !== '' ? { logPath } : {}),
            })
              .then((cap) => renderCapture(cap))
              .catch(() => {})
          }
        } else {
          document.documentElement.removeAttribute('data-dsh-apiviz-active')
          if (state.timer !== null) {
            clearTimeout(state.timer)
            state.timer = null
          }
          closeFilterDialog()
          closeDetail()
        }
      }
      const toggle = () => setOpen(document.documentElement.dataset.dshApivizActive !== 'true')

      closeBtn.addEventListener('click', () => setOpen(false))
      refreshBtn.addEventListener('click', refresh)
      freezeCb.addEventListener('change', () => {
        state.frozen = freezeCb.checked
        if (!state.frozen) { // 取消冻结：清掉待触发计时器，立即刷新并重启轮询
          if (state.timer !== null) { clearTimeout(state.timer); state.timer = null }
          refresh().finally(scheduleNext)
        }
      })
      captureBtn.addEventListener('click', () => {
        const path = state.capture.running ? '/capture/stop' : '/capture/start'
        captureBtn.disabled = true
        const logPath = logPathIn.value.trim()
        apiFetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(logPath !== '' ? { logPath } : {}),
        })
          .then((cap) => renderCapture(cap))
          .catch((error) => {
            console.error('[dsh-api-visualizer] capture toggle failed:', error)
            captureChip.textContent = `捕获操作失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            captureBtn.disabled = false
            refresh()
          })
      })
      autoScrollCb.addEventListener('change', () => {
        state.autoScroll = autoScrollCb.checked
        if (state.autoScroll) tableWrap.scrollTop = tableWrap.scrollHeight
        savePrefs()
      })
      flaggedBtn.addEventListener('click', () => {
        state.flagged = !state.flagged
        if (state.flagged) flaggedBtn.classList.add('apv-btn-on')
        else flaggedBtn.classList.remove('apv-btn-on')
        refresh()
      })
      moreBtn.addEventListener('click', () => {
        filterBar.hidden = !filterBar.hidden
        moreBtn.textContent = filterBar.hidden ? '更多 ▾' : '更多 ▴'
      })
      const applyAdvInputs = () => {
        state.host = hostIn.value.trim()
        state.ct = ctIn.value.trim()
        state.minDur = minDurIn.value.trim()
        state.minBytes = minBytesIn.value.trim()
        state.maxBytes = maxBytesIn.value.trim()
        state.fromTs = fromIn.value === '' ? '' : String(Date.parse(fromIn.value))
        state.toTs = toIn.value === '' ? '' : String(Date.parse(toIn.value))
        state.bodyQ = bodyQIn.value.trim()
        refresh()
      }
      for (const input of [hostIn, ctIn, minDurIn, minBytesIn, maxBytesIn, fromIn, toIn, bodyQIn]) {
        input.addEventListener('change', applyAdvInputs)
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') applyAdvInputs()
        })
      }
      errorsCb.addEventListener('change', () => {
        state.errorsOnly = errorsCb.checked
        refresh()
      })
      noiseCb.addEventListener('change', () => {
        state.noNoise = noiseCb.checked
        refresh()
      })
      regexCb.addEventListener('change', () => {
        state.regex = regexCb.checked
        refresh()
      })
      treeBtn.addEventListener('click', () => setView(state.treeView ? 'table' : 'tree'))
      aggBtn.addEventListener('click', () => setView(state.aggView ? 'table' : 'agg'))
      delFilteredBtn.addEventListener('click', async () => {
        // 删的必须正好是列表里看到的那一批：上方的筛选 + 当前启用的过滤器。启用着过滤器时先确认宿主真的按它算
        // （旧宿主不认过滤条件，会按更宽的条件删掉更多记录），并把会删的条数写进确认框。
        // R5-02：条数按点按钮这一刻数（toTs = 这一刻，用户自己设了更早的截止时间就用用户的），DELETE 带同一组参数和
        // 同一个 toTs 上界：确认框开着时新抓到的记录不会被一起删掉；删完把实际删除条数留在提示条里（不会被刷新盖掉）。
        const userTo = state.toTs !== '' && Number.isFinite(Number(state.toTs)) ? Number(state.toTs) : Infinity
        const bound = String(Math.min(Date.now(), userTo))
        const params = setQuickParams(new URLSearchParams({ filtered: '1' }))
        const sent = setFilterParam(params)
        params.set('toTs', bound)
        const probe = setQuickParams(new URLSearchParams({ limit: '1' }))
        setFilterParam(probe)
        probe.set('toTs', bound)
        let check
        try {
          check = await apiFetch(`/records?${probe.toString()}`)
        } catch (error) {
          stats.textContent = `删除筛选集：先核对${sent !== null ? `过滤器「${sent.filter.name}」` : '要删的条数'}失败（${errText(error)}），没有删除任何记录`
          return
        }
        if (sent !== null && !Array.isArray(check?.filterApplied) && enabledCondCount(sent.filter) > 0) {
          window.alert(`宿主没有应用过滤器「${sent.filter.name}」（旧版本？需要重启 DSH），按上方筛选删除会删掉比列表里更多的记录，已取消。`)
          return
        }
        const total = Number(check?.total)
        const counted = Number.isFinite(total) ? total : null
        const countText = counted !== null ? ` ${counted} 条` : '全部'
        const message = sent !== null
          ? `删除当前筛选（含过滤器「${sent.filter.name}」）命中的${countText}记录？此操作不可恢复。`
          : `删除当前筛选条件命中的${countText}记录？此操作不可恢复。`
        if (!window.confirm(message)) return
        apiFetch(`/records?${params.toString()}`, { method: 'DELETE' })
          .then((r) => {
            const deleted = Number(r?.deleted) || 0
            if (counted !== null && deleted !== counted) showNotice('warn', `已删除 ${deleted} 条（确认时数到的是 ${counted} 条：确认期间库里的记录有变化）`)
            else showNotice('ok', `已删除 ${deleted} 条`)
            refresh()
          })
          .catch((error) => {
            console.error('[dsh-api-visualizer] delete filtered failed:', error)
            showNotice('warn', `删除筛选集失败：${errText(error)}`)
          })
      })
      // 保存/载入筛选
      const currentFilter = () => ({
        q: state.q, method: state.method, status: state.status, source: state.source, flagged: state.flagged, sessionId: state.sessionId,
        host: state.host, ct: state.ct, minDur: state.minDur, minBytes: state.minBytes, maxBytes: state.maxBytes, fromTs: state.fromTs, toTs: state.toTs, errorsOnly: state.errorsOnly, noNoise: state.noNoise, regex: state.regex, bodyQ: state.bodyQ,
      })
      const applyFilter = (f) => {
        q.value = f.q ?? ''
        state.q = f.q ?? ''
        methodSel.value = f.method ?? ''
        state.method = f.method ?? ''
        statusSel.value = f.status ?? ''
        state.status = f.status ?? ''
        sourceSel.value = f.source ?? ''
        state.source = f.source ?? ''
        state.flagged = f.flagged === true
        flaggedBtn.classList.toggle('apv-btn-on', state.flagged)
        hostIn.value = f.host ?? ''
        state.host = f.host ?? ''
        ctIn.value = f.ct ?? ''
        state.ct = f.ct ?? ''
        minDurIn.value = f.minDur ?? ''
        state.minDur = f.minDur ?? ''
        minBytesIn.value = f.minBytes ?? ''
        state.minBytes = f.minBytes ?? ''
        maxBytesIn.value = f.maxBytes ?? ''
        state.maxBytes = f.maxBytes ?? ''
        state.fromTs = f.fromTs ?? ''
        state.toTs = f.toTs ?? ''
        state.sessionId = f.sessionId ?? ''
        fromIn.value = state.fromTs !== '' && Number.isFinite(Number(state.fromTs)) ? new Date(Number(state.fromTs) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
        toIn.value = state.toTs !== '' && Number.isFinite(Number(state.toTs)) ? new Date(Number(state.toTs) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''
        errorsCb.checked = f.errorsOnly === true
        state.errorsOnly = f.errorsOnly === true
        noiseCb.checked = f.noNoise === true
        state.noNoise = f.noNoise === true
        regexCb.checked = f.regex === true
        state.regex = f.regex === true
        bodyQIn.value = f.bodyQ ?? ''
        state.bodyQ = f.bodyQ ?? ''
        refresh()
      }
      const renderSavedSel = () => {
        savedSel.textContent = ''
        const all = el('option', '', state.savedFilters.length === 0 ? '(无已保存筛选)' : '载入筛选…')
        all.value = ''
        savedSel.appendChild(all)
        for (const f of state.savedFilters) {
          const opt = el('option', '', f.name)
          opt.value = f.name
          savedSel.appendChild(opt)
        }
      }
      savedSel.addEventListener('change', () => {
        const f = state.savedFilters.find((s) => s.name === savedSel.value)
        if (f !== undefined) applyFilter(f.filter)
      })
      saveFilterBtn.addEventListener('click', () => {
        const name = window.prompt('给这个筛选起个名字：', '筛选 ' + (state.savedFilters.length + 1))
        if (name === null || name.trim() === '') return
        const idx = state.savedFilters.findIndex((s) => s.name === name.trim())
        if (idx >= 0) state.savedFilters[idx] = { name: name.trim(), filter: currentFilter() }
        else state.savedFilters.push({ name: name.trim(), filter: currentFilter() })
        savePrefs()
        renderSavedSel()
      })
      delSavedBtn.addEventListener('click', () => {
        if (savedSel.value === '') return
        state.savedFilters = state.savedFilters.filter((s) => s.name !== savedSel.value)
        savePrefs()
        renderSavedSel()
      })
      clearFilterBtn.addEventListener('click', () => {
        q.value = ''
        methodSel.value = ''
        statusSel.value = ''
        sourceSel.value = ''
        hostIn.value = ''
        ctIn.value = ''
        minDurIn.value = ''
        minBytesIn.value = ''
        maxBytesIn.value = ''
        fromIn.value = ''
        toIn.value = ''
        bodyQIn.value = ''
        errorsCb.checked = false
        noiseCb.checked = false
        regexCb.checked = false
        state.q = ''
        state.method = ''
        state.status = ''
        state.source = ''
        state.flagged = false
        state.host = ''
        state.ct = ''
        state.minDur = ''
        state.minBytes = ''
        state.maxBytes = ''
        state.fromTs = ''
        state.toTs = ''
        state.sessionId = ''
        state.errorsOnly = false
        state.noNoise = false
        state.regex = false
        state.bodyQ = ''
        flaggedBtn.classList.remove('apv-btn-on')
        refresh()
      })
      autoCapCb.addEventListener('change', savePrefs)
      logPathIn.addEventListener('change', savePrefs)
      clearLogsBtn.addEventListener('click', () => {
        if (!window.confirm('清除日志：删除客户端跟踪日志（客户端运行时自动跳过）与抓包目录的日志文件？')) return
        clearLogsBtn.disabled = true
        healthHint.style.color = ''
        healthHint.textContent = '正在清理日志…'
        apiFetch('/logs/clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => {
            if (r.traceLogDeleted) healthHint.textContent = '已清除：跟踪日志与抓包目录日志'
            else if (r.traceLogSkipped) {
              healthHint.textContent = '抓包目录日志已清；跟踪日志被客户端占用已跳过（重启客户端后可清）'
              healthHint.style.color = '#fbbf24'
            } else healthHint.textContent = r.ok ? '清理完成' : `清理失败: ${r.err ?? r.output ?? '未知'}`
          })
          .catch((error) => {
            healthHint.textContent = `清理失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            clearLogsBtn.disabled = false
          })
      })
      rotateBtn.addEventListener('click', () => {
        if (!window.confirm('轮转日志：把当前跟踪/调用方日志改名归档为 .bak 并清理过期归档（捕获中会自动先停再启）？')) return
        rotateBtn.disabled = true
        healthHint.style.color = ''
        healthHint.textContent = '正在轮转日志…'
        apiFetch('/capture/rotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keepDays: 7 }) })
          .then((r) => {
            healthHint.textContent = `轮转完成: trace=${r.trace} caller=${r.caller} 清理旧归档 ${r.pruned} 个${r.restarted ? '（已恢复捕获）' : ''}`
            refresh()
          })
          .catch((error) => {
            healthHint.textContent = `轮转失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            rotateBtn.disabled = false
          })
      })
      // ---- 四个工具面板（规则 / 断点 / 透明拦截 / 弱网）互斥：同一时间只开一个
      const toolPanels = [
        { wrap: rulesWrap, btn: rulesBtn, onOpen: () => loadRules() },
        { wrap: bpWrap, btn: bpBtn, onOpen: () => loadBreakpoints() },
        { wrap: icWrap, btn: interceptBtn, onOpen: () => loadIntercept() },
        { wrap: nsWrap, btn: netsimBtn, onOpen: () => { nsDiscardEdits(); loadNetsim() } },
      ]
      const toggleToolPanel = (wrap) => {
        const opening = wrap.hidden
        for (const p of toolPanels) {
          p.wrap.hidden = !(opening && p.wrap === wrap)
          p.btn.classList.toggle('apv-btn-on', !p.wrap.hidden)
        }
        if (opening) toolPanels.find((p) => p.wrap === wrap).onOpen()
      }
      rulesBtn.addEventListener('click', () => toggleToolPanel(rulesWrap))
      bpBtn.addEventListener('click', () => toggleToolPanel(bpWrap))
      interceptBtn.addEventListener('click', () => toggleToolPanel(icWrap))
      netsimBtn.addEventListener('click', () => toggleToolPanel(nsWrap))

      // ---- 断点面板逻辑（请求 / 响应两个阶段）
      let bpConfig = { enabled: false, urlFilter: '', methodFilter: '', phase: 'request' }
      const PHASE_LABEL = { request: '请求', response: '响应', both: '请求+响应' }
      // 挂起卡片按 id 复用：轮询只增删变化了的卡片，别的请求挂起 / 放行时，正在改的内容和放行失败的提示都留在原卡片上
      const bpCards = new Map() // id -> { card }
      const bpNoteEl = el('div', 'apv-note', '')
      const bpGate = latestGate()
      /** 头部编辑框（JSON 对象）→ 对象；数字按原文当字符串（头的值本来就是字符串），不经 JSON.parse 四舍五入。 */
      const parseHeaderBox = (text) => {
        const r = parseJsonKeepNumbers(text)
        if (!r.ok) return { ok: false, reason: 'invalid' }
        if (r.value === null || typeof r.value !== 'object' || Array.isArray(r.value)) return { ok: false, reason: 'not-object' }
        return { ok: true, value: r.value }
      }
      const headerBoxAlert = (label, reason) => window.alert(reason === 'not-object' ? `${label}要是 JSON 对象，例如 {"名称": "值"}` : `${label}不是有效 JSON`)
      const buildBpCard = (item) => {
        const card = el('div', 'apv-bp-card')
        const isRes = item.phase === 'response'
        card.appendChild(el('div', 'apv-sec-title', `${isRes ? '【响应】' : '【请求】'}${item.method} ${item.url}`))
        if (typeof item.note === 'string' && item.note !== '') card.appendChild(el('div', 'apv-note', item.note))
        const btns = el('div', 'apv-bp-btns')
        const goBtn = el('button', 'apv-btn', '放行')
        const passBtn = el('button', 'apv-btn', '原样放行')
        const dropBtn = el('button', 'apv-btn apv-btn-danger', '丢弃')
        const errEl = el('div', 'apv-bp-err apv-warn', '')
        const release = (action, edits) => {
          errEl.textContent = ''
          for (const b of [goBtn, passBtn, dropBtn]) b.disabled = true
          const seq = bpGate.next()
          apiFetch('/proxy/breakpoints/release', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: item.id, action, edits }),
          })
            .then((data) => { if (bpGate.accept(seq)) renderBreakpoints(data) })
            .catch((error) => {
              // 400 = 改动不合法（状态码、头名 / 头的值…）：原因写在这张卡片上，卡片和已改的内容都留着，改对了再放行
              errEl.textContent = error?.status === 404
                ? `这个请求已经不在挂起列表里（120 秒没处理会自动放行，或已被别处处理）：${errText(error)}`
                : `放行失败：${errText(error)}`
            })
            .finally(() => { for (const b of [goBtn, passBtn, dropBtn]) b.disabled = false })
        }
        if (isRes) {
          card.appendChild(el('div', 'apv-note', '状态码'))
          const sIn = el('input', 'apv-fin apv-fin-dur')
          sIn.type = 'number'
          sIn.value = String(item.status ?? 200)
          card.appendChild(sIn)
          card.appendChild(el('div', 'apv-note', '响应头（JSON）'))
          const hIn = el('textarea', 'apv-fin apv-rule-body')
          hIn.value = JSON.stringify(item.resHeaders ?? {}, null, 2)
          card.appendChild(hIn)
          card.appendChild(el('div', 'apv-note', item.editable === false ? '响应体（非文本，不能改）' : '响应体（改完点放行；压缩已解开，发出时自动按原编码重算长度；JSON 只重排了缩进，数字与字符串保持原文）'))
          const bIn = el('textarea', 'apv-fin apv-rule-body')
          bIn.style.width = '100%'
          bIn.style.height = '160px'
          // 保留原文的缩进：不经 JSON.parse/stringify，大整数 ID、1.50 这类数字不会被改掉（C7）
          bIn.value = prettyJsonText(item.resBody ?? '')
          bIn.disabled = item.editable === false
          card.appendChild(bIn)
          // 初值按 textarea 读回来的为准（它会把 \r\n 规范成 \n），只把用户真改了的字段发回去
          const status0 = sIn.value
          const headers0 = hIn.value
          const body0 = bIn.value
          goBtn.addEventListener('click', () => {
            const edits = {}
            if (hIn.value !== headers0) {
              const h = parseHeaderBox(hIn.value)
              if (!h.ok) { headerBoxAlert('响应头', h.reason); return }
              edits.resHeaders = h.value
            }
            if (sIn.value !== status0 && sIn.value.trim() !== '') edits.status = Number(sIn.value)
            if (item.editable !== false && bIn.value !== body0) edits.resBody = bIn.value
            release('continue', Object.keys(edits).length > 0 ? edits : null)
          })
        } else {
          card.appendChild(el('div', 'apv-note', '方法'))
          const mIn = el('input', 'apv-fin')
          mIn.value = item.method
          card.appendChild(mIn)
          card.appendChild(el('div', 'apv-note', '请求头（JSON）'))
          const hIn = el('textarea', 'apv-fin apv-rule-body')
          hIn.value = JSON.stringify(item.reqHeaders ?? {}, null, 2)
          card.appendChild(hIn)
          // 捕获库里的请求体可能是十六进制 / base64 存法或已截断：这种不能当文本改，原样放行
          const reqRaw = typeof item.reqBody === 'string' ? item.reqBody : ''
          const reqKind = detectBodyKind(reqRaw, '').kind
          const reqEditable = reqKind !== 'hex' && reqKind !== 'base64' && !reqRaw.endsWith('…(截断)')
          card.appendChild(el('div', 'apv-note', reqEditable ? '请求体' : '请求体（非文本或已截断，不能改）'))
          const bIn = el('textarea', 'apv-fin apv-rule-body')
          bIn.value = reqRaw
          bIn.disabled = !reqEditable
          card.appendChild(bIn)
          const method0 = mIn.value
          const headers0 = hIn.value
          const body0 = bIn.value
          goBtn.addEventListener('click', () => {
            const edits = {}
            if (hIn.value !== headers0) {
              const h = parseHeaderBox(hIn.value)
              if (!h.ok) { headerBoxAlert('请求头', h.reason); return }
              edits.reqHeaders = h.value
            }
            const method = mIn.value.trim()
            if (method !== '' && method !== method0.trim()) edits.method = method
            // 没改过的请求体不回传：回传的是文本，会把原始字节（GBK、二进制、截断前的全文）换掉
            if (reqEditable && bIn.value !== body0) edits.reqBody = bIn.value
            release('continue', Object.keys(edits).length > 0 ? edits : null)
          })
        }
        passBtn.addEventListener('click', () => release('continue', null))
        dropBtn.addEventListener('click', () => release('drop', null))
        btns.appendChild(goBtn)
        btns.appendChild(passBtn)
        btns.appendChild(dropBtn)
        card.appendChild(btns)
        card.appendChild(errEl)
        return { card }
      }
      const renderBreakpoints = (data) => {
        bpConfig = data?.config ?? bpConfig
        bpEnableCb.checked = bpConfig.enabled === true
        bpBtn.textContent = bpConfig.enabled ? `断点 ● ${PHASE_LABEL[bpConfig.phase] ?? '请求'}` : '断点'
        if (document.activeElement !== bpUrlIn) bpUrlIn.value = bpConfig.urlFilter ?? ''
        if (document.activeElement !== bpMethodSel) bpMethodSel.value = bpConfig.methodFilter ?? ''
        if (document.activeElement !== bpPhaseSel) bpPhaseSel.value = bpConfig.phase ?? 'request'
        const paused = bpConfig.enabled ? (data?.paused ?? []) : []
        const live = new Set(paused.map((p) => p.id))
        for (const [id, c] of bpCards) {
          if (live.has(id)) continue
          c.card.remove()
          bpCards.delete(id)
        }
        if (paused.length === 0) {
          bpNoteEl.textContent = bpConfig.enabled ? '（无挂起请求）启用后命中的请求会在此等待处理' : '断点未启用'
          if (bpNoteEl.parentNode !== bpPausedEl) bpPausedEl.appendChild(bpNoteEl)
          return
        }
        bpNoteEl.remove()
        let prevCard = null
        for (const item of paused) {
          let c = bpCards.get(item.id)
          if (c === undefined) {
            c = buildBpCard(item)
            bpCards.set(item.id, c)
          }
          const want = prevCard === null ? bpPausedEl.firstChild : prevCard.nextSibling
          if (want !== c.card) bpPausedEl.insertBefore(c.card, want)
          prevCard = c.card
        }
      }
      const loadBreakpoints = () => {
        const seq = bpGate.next()
        return apiFetch('/proxy/breakpoints')
          .then((data) => { if (bpGate.accept(seq)) renderBreakpoints(data) })
          .catch((error) => { console.error('[dsh-api-visualizer] load breakpoints failed:', error) })
      }
      const saveBreakpoints = () => {
        const seq = bpGate.next()
        return apiFetch('/proxy/breakpoints', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: bpEnableCb.checked, urlFilter: bpUrlIn.value.trim(), methodFilter: bpMethodSel.value, phase: bpPhaseSel.value }),
        })
          .then((data) => { if (bpGate.accept(seq)) renderBreakpoints(data) })
          .catch((error) => { console.error('[dsh-api-visualizer] save breakpoints failed:', error) })
      }
      bpEnableCb.addEventListener('change', saveBreakpoints)
      bpPhaseSel.addEventListener('change', saveBreakpoints)
      bpSaveBtn.addEventListener('click', saveBreakpoints)

      // ---- 透明拦截面板逻辑
      let icBusy = false
      let icLastStatus = null
      let icInFlight = 0
      const icGate = latestGate()
      const icHostsFromBox = () => icHostsIn.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
      /**
       * 操作结果写进单独那一块：状态轮询（renderIntercept）不碰它；操作开始时换成进度，结束时换成结果或失败原因（C11）。
       * warnings = 这次操作自己的告警（部分域名解析失败、安全网异常…）：之后的状态轮询不会再报，只能在这里留住。
       */
      const setIcAction = (kind, text, warnings = []) => {
        icActionEl.textContent = ''
        icActionEl.appendChild(el('div', kind === 'ok' ? 'apv-ok' : kind === 'warn' ? 'apv-warn' : 'apv-note', text))
        for (const w of warnings) icActionEl.appendChild(el('div', 'apv-warn', '⚠ ' + w))
      }
      const textList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x !== '') : [])
      const renderIntercept = (s, error) => {
        icStatusEl.textContent = ''
        if (s === null || typeof s !== 'object') {
          icStatusEl.appendChild(el('div', 'apv-warn', `拿不到透明拦截状态${error !== undefined ? '：' + errText(error) : ''}（宿主是旧版本？需要重启 DSH 加载新插件）`))
          return
        }
        icLastStatus = s
        const head = el('div', s.active ? 'apv-ok' : (s.listening ? 'apv-warn' : 'apv-note'))
        head.textContent = s.listening !== true
          ? `○ 未开启（监听地址 ${s.ip ?? '-'}）`
          : s.draining
            ? `◐ 排空中：hosts 已还原，${s.drainUntil ? Math.max(0, Math.round((s.drainUntil - Date.now()) / 1000)) + ' 秒后' : '稍后'}关监听（期间已有连接照常透传、不套规则）`
            : `● 生效中 · ${s.ip} · 端口 ${(s.ports ?? []).map((p) => `${p.port}${p.mode === 'tcp' ? '(TCP透传)' : p.secure ? '(TLS)' : ''}`).join(' ')} · 已拦 ${s.counters?.requests ?? 0} 次 · 去重实时记录 ${s.counters?.dedupedRealtime ?? 0} 条`
        icStatusEl.appendChild(head)
        const ca = el('div', s.caTrusted === false ? 'apv-warn' : 'apv-note')
        ca.textContent = s.caTrusted === true ? '根证书：已被 Windows 信任' : s.caTrusted === false ? '根证书：未被信任 —— 严格校验证书的请求（如量化接口）会握手失败，点「安装根证书」后重启客户端' : '根证书：信任状态未知'
        icStatusEl.appendChild(ca)
        if (Array.isArray(s.hosts) && s.hosts.length > 0) {
          const t = el('table')
          const hr = el('tr')
          ;['域名', '端口', '真实地址', '来源', '次数', '告警'].forEach((h) => hr.appendChild(el('th', '', h)))
          t.appendChild(hr)
          for (const h of s.hosts) {
            const tr = el('tr')
            tr.appendChild(el('td', '', h.host))
            tr.appendChild(el('td', '', (h.ports ?? []).join(' ')))
            tr.appendChild(el('td', '', (h.upstream ?? []).join(', ')))
            tr.appendChild(el('td', '', h.via ?? ''))
            tr.appendChild(el('td', '', String(h.requests ?? 0)))
            tr.appendChild(el('td', h.error ? 'apv-warn' : '', h.error ?? ''))
            t.appendChild(tr)
          }
          icStatusEl.appendChild(t)
        }
        const hf = s.hostsFile ?? {}
        const showTask = s.listening === true || hf.blockPresent === true
        icStatusEl.appendChild(el('div', 'apv-note', `hosts：${hf.blockPresent ? `本插件段落在（${hf.entries} 条）` : '没有本插件段落'} · ${hf.path ?? ''}` +
          (showTask && s.safetyTaskPresent === true ? ' · 安全网计划任务：在' : showTask && s.safetyTaskPresent === false ? ' · 安全网计划任务：不在' : '')))
        if (s.event && s.event.message) icStatusEl.appendChild(el('div', s.event.level === 'error' ? 'apv-warn' : 'apv-note', '事件：' + s.event.message))
        // 根证书未信任已经单独一行显示过，告警列表里同义的那条不再重复
        for (const w of s.warnings ?? []) {
          if (s.caTrusted === false && w.startsWith('根证书没有被')) continue
          icStatusEl.appendChild(el('div', 'apv-warn', '⚠ ' + w))
        }
        if (document.activeElement !== icHostsIn && icHostsIn.value.trim() === '' && Array.isArray(s.entries) && s.entries.length > 0) {
          icHostsIn.value = s.entries.join('\n')
        }
        icStartBtn.textContent = s.listening && !s.draining ? '更新名单' : '启用拦截'
        icStopBtn.disabled = !(s.listening || hf.blockPresent)
      }
      const renderInterceptChip = (sum) => {
        if (sum && sum.listening) {
          interceptChip.textContent = sum.draining ? '拦截 ◐ 排空中' : `拦截 ● ${sum.hosts} 域名 · ${sum.requests ?? 0} 次${sum.tlsErrors > 0 ? ` · TLS 拒绝 ${sum.tlsErrors}` : ''}`
          interceptChip.className = sum.draining ? 'apv-stats apv-warn' : 'apv-stats apv-live-on'
          interceptBtn.textContent = sum.draining ? '透明拦截 ◐' : '透明拦截 ●'
        } else {
          interceptChip.textContent = ''
          interceptChip.className = 'apv-stats'
          interceptBtn.textContent = '透明拦截'
        }
      }
      /**
       * 状态一律取 deep（根证书信任 / 安全网计划任务）：宿主把这部分缓存 30 秒，启用 / 停用 / 装证书时宿主自己作废缓存；
       * 原来轮询在 deep / 非 deep 之间交替，「根证书」一行会在实际状态和「未知」之间来回跳。
       * 操作结束后带 fresh=1 强制重查（C37）。轮询（poll）在上一次还没回来时跳过，不叠请求。
       */
      const loadIntercept = ({ fresh = false, poll = false } = {}) => {
        if (poll && icInFlight > 0) return Promise.resolve()
        const seq = icGate.next()
        icInFlight++
        return apiFetch(`/proxy/intercept/status?deep=1${fresh ? '&fresh=1' : ''}`)
          .then((s) => { if (icGate.accept(seq)) renderIntercept(s) })
          .catch((error) => { if (icGate.accept(seq)) renderIntercept(null, error) })
          .finally(() => { icInFlight-- })
      }
      icSuggestBtn.addEventListener('click', () => {
        icSuggestEl.textContent = '读取中…'
        apiFetch('/proxy/intercept/suggest').then((data) => {
          icSuggestEl.textContent = ''
          const items = (data?.items ?? []).filter((it) => it !== null && typeof it === 'object' && typeof it.host === 'string')
          if (items.length === 0) { icSuggestEl.appendChild(el('span', 'apv-note', '捕获库里还没有域名记录：先「开始实时捕获」让客户端跑一会儿，或直接手填。')); return }
          const entriesOf = (it) => (Array.isArray(it.entries) && it.entries.length > 0 ? it.entries.map(String) : [it.host])
          const current = new Set(icHostsFromBox())
          const anyClient = items.some((it) => it.fromClient === true)
          if (!anyClient) {
            // 没有客户端自己的流量：一个都不预勾（这些域名来自浏览器等其它进程，透明拦截会改整台机器的 hosts，C41）
            const why = el('div', 'apv-warn', '捕获库里还没有客户端自己的流量（实时捕获来源），下面的域名都来自其它进程（浏览器等经本地 / 系统代理的流量），所以一个都没默认勾选。' +
              '透明拦截会改整台机器的 hosts：只勾确认是客户端要访问的域名；更稳妥的是先「开始实时捕获」，让客户端跑一会儿再来填充。')
            why.style.flexBasis = '100%'
            icSuggestEl.appendChild(why)
          }
          const sync = () => {
            const picked = []
            for (const cb of icSuggestEl.querySelectorAll('input[type=checkbox]')) if (cb.checked) picked.push(...JSON.parse(cb.dataset.entries))
            const keep = icHostsFromBox().filter((h) => !items.some((it) => entriesOf(it).includes(h)))
            icHostsIn.value = [...new Set([...keep, ...picked])].join('\n')
          }
          for (const it of items) {
            const fromClient = it.fromClient === true
            const entries = entriesOf(it)
            const lab = el('label', fromClient ? 'apv-ic-client' : '')
            const cb = el('input', '')
            cb.type = 'checkbox'
            cb.dataset.entries = JSON.stringify(entries)
            // 只预勾客户端自己的流量（实时捕获里出现过的）；框里本来就有的保持勾选
            cb.checked = entries.some((e) => current.has(e)) || (current.size === 0 && fromClient)
            cb.addEventListener('change', sync)
            lab.appendChild(cb)
            lab.appendChild(document.createTextNode(` ${it.host} (${it.count ?? 0})${fromClient ? '' : '（非客户端流量）'}`))
            const src = it.sources !== null && typeof it.sources === 'object' ? it.sources : null
            lab.title = [
              fromClient ? '客户端实时捕获里出现过' : '只在其它来源出现过（不是客户端进程自己的流量）',
              src !== null ? `实时捕获 ${src.realtime ?? 0} · 代理 ${src.proxy ?? 0} · 其它 ${src.other ?? 0}` : '',
              (Array.isArray(it.ports) ? it.ports : []).join(', '),
            ].filter(Boolean).join(' · ')
            icSuggestEl.appendChild(lab)
          }
          sync()
        }).catch((error) => {
          icSuggestEl.textContent = `读取候选失败：${errText(error)}`
        })
      })
      icStartBtn.addEventListener('click', () => {
        const hosts = icHostsFromBox()
        if (hosts.length === 0) { setIcAction('warn', '先填要拦截的域名（或点「从捕获记录填充」）'); return }
        if (icBusy) return
        const updating = icLastStatus !== null && icLastStatus.listening === true && icLastStatus.draining !== true
        icBusy = true
        icStartBtn.disabled = true
        setIcAction('note', `${updating ? '正在更新名单' : '正在解析真实地址、起监听、改 hosts'}…（宿主未提权时会弹 UAC，请在系统对话框里确认）`)
        apiFetch('/proxy/intercept/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hosts }) })
          .then((s) => setIcAction('ok', updating
            ? '名单已更新：新加的域名重启客户端即可立即生效；移出名单的域名在排空期过后不再拦截。'
            : '已启用。重启客户端即可立即生效（否则约 2 分钟内连接自然切换过来）。', textList(s?.warnings)))
          .catch((error) => setIcAction('warn', `${updating ? '更新名单失败' : '启用失败'}：${errText(error)}`, textList(error?.body?.warnings)))
          .finally(() => {
            icBusy = false
            icStartBtn.disabled = false
            loadIntercept({ fresh: true })
            refresh()
          })
      })
      icStopBtn.addEventListener('click', () => {
        if (icBusy) return
        icBusy = true
        icStopBtn.disabled = true
        setIcAction('note', '正在还原 hosts…（宿主未提权时会弹 UAC，请在系统对话框里确认）')
        apiFetch('/proxy/intercept/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((s) => setIcAction('ok', 'hosts 已还原；排空期结束后自动关闭监听。', textList(s?.removal?.warnings)))
          .catch((error) => setIcAction('warn', `停用失败：${errText(error)}`, textList(error?.body?.removal?.warnings)))
          .finally(() => {
            icBusy = false
            icStopBtn.disabled = false
            loadIntercept({ fresh: true })
            refresh()
          })
      })
      icCaBtn.addEventListener('click', () => {
        icCaBtn.disabled = true
        setIcAction('note', '正在导入根证书…（会弹系统确认框，请选「是」）')
        apiFetch('/proxy/install-ca', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => setIcAction(r.ok === true ? 'ok' : 'warn', r.ok === true ? '根证书已导入（当前用户）。重启客户端后严格校验证书的请求也能通过。' : `导入结果：${r.output ?? r.hint ?? '未知'}`))
          .catch((error) => setIcAction('warn', `导入失败：${errText(error)}`))
          .finally(() => {
            icCaBtn.disabled = false
            loadIntercept({ fresh: true })
          })
      })
      icRefreshBtn.addEventListener('click', () => loadIntercept({ fresh: true }))

      // ---- 全局延时 / 弱网面板逻辑
      let nsPresetsRendered = false
      let nsSaving = 0
      const nsGate = latestGate()
      // 用户改过、还没「应用」的输入框，以及正在输入的框：轮询刷新时都不覆盖；应用 / 套预设成功后才清掉标记（C43）
      const nsFormInputs = [nsReqIn, nsResIn, nsJitIn, nsDownIn, nsUpIn, nsHostsIn, nsUrlIn, nsScopeSel]
      let nsDirtySeq = 0
      for (const input of nsFormInputs) {
        input.addEventListener(input === nsScopeSel ? 'change' : 'input', () => { input.dataset.apvDirty = String(++nsDirtySeq) })
      }
      const nsDirtySnapshot = () => new Map(nsFormInputs.map((input) => [input, input.dataset.apvDirty]))
      const nsClearDirty = (snap) => {
        for (const [input, mark] of snap) {
          if (mark !== undefined && input.dataset.apvDirty === mark) delete input.dataset.apvDirty
        }
      }
      const nsKeep = (input) => document.activeElement === input || input.dataset.apvDirty !== undefined
      /** 重新打开面板 = 看宿主现在的设置：上次没「应用」就关掉的改动不再保留。 */
      const nsDiscardEdits = () => {
        for (const input of nsFormInputs) delete input.dataset.apvDirty
      }
      const netsimSummary = (n) => [
        n.requestDelayMs > 0 ? `请求延迟 ${n.requestDelayMs}ms${n.jitterMs > 0 ? `±${n.jitterMs}` : ''}` : '',
        n.responseDelayMs > 0 ? `回包延迟 ${n.responseDelayMs}ms` : '',
        n.downKbps > 0 ? `下行 ${n.downKbps}KB/s` : '',
        n.upKbps > 0 ? `上行 ${n.upKbps}KB/s` : '',
      ].filter(Boolean).join('，')
      const renderNetsim = (n) => {
        if (n === null || typeof n !== 'object') return
        if (!nsPresetsRendered && n.presets) {
          nsPresetSel.textContent = ''
          const o0 = el('option', '', '预设…')
          o0.value = ''
          nsPresetSel.appendChild(o0)
          for (const [k, v] of Object.entries(n.presets)) {
            const o = el('option', '', v.label)
            o.value = k
            nsPresetSel.appendChild(o)
          }
          nsPresetsRendered = true
        }
        // 开关点了就立即保存，不算「正在编辑」：只在它自己的保存还没回来时不覆盖
        if (nsSaving === 0) nsEnableCb.checked = n.enabled === true
        const setNum = (input, v) => { if (!nsKeep(input)) input.value = Number(v) > 0 ? String(v) : '' }
        setNum(nsReqIn, n.requestDelayMs)
        setNum(nsResIn, n.responseDelayMs)
        setNum(nsJitIn, n.jitterMs)
        setNum(nsDownIn, n.downKbps)
        setNum(nsUpIn, n.upKbps)
        if (!nsKeep(nsHostsIn)) nsHostsIn.value = n.hosts ?? ''
        if (!nsKeep(nsUrlIn)) nsUrlIn.value = n.urlFilter ?? ''
        if (!nsKeep(nsScopeSel)) nsScopeSel.value = n.scope ?? 'all'
        const parts = netsimSummary(n)
        nsStatusEl.textContent = n.enabled ? `● 已启用：${parts || '（未设数值）'}` : `○ 未启用${parts ? '（已保存：' + parts + '）' : ''}`
        nsStatusEl.className = n.enabled ? 'apv-ok' : 'apv-note'
        setNetsimBtn(n.enabled === true)
      }
      const loadNetsim = () => {
        const seq = nsGate.next()
        return apiFetch('/proxy/netsim')
          .then((n) => { if (nsGate.accept(seq)) renderNetsim(n) })
          .catch((error) => {
            if (!nsGate.accept(seq)) return
            nsStatusEl.textContent = `读取失败：${errText(error)}（宿主是旧版本？需要重启 DSH）`
            nsStatusEl.className = 'apv-warn'
          })
      }
      /** 把面板上的值写回宿主；成功后清掉「改过未应用」标记（只清提交那一刻的，之后又改的保留）。 */
      const postNetsim = (payload, failText) => {
        const snap = nsDirtySnapshot()
        const seq = nsGate.next()
        nsSaving++
        return apiFetch('/proxy/netsim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          .then((n) => {
            nsClearDirty(snap)
            if (nsGate.accept(seq)) renderNetsim(n)
          })
          .catch((error) => {
            nsStatusEl.textContent = `${failText}：${errText(error)}`
            nsStatusEl.className = 'apv-warn'
          })
          .finally(() => { nsSaving-- })
      }
      const saveNetsim = () => postNetsim({
        enabled: nsEnableCb.checked,
        requestDelayMs: Number(nsReqIn.value) || 0,
        responseDelayMs: Number(nsResIn.value) || 0,
        jitterMs: Number(nsJitIn.value) || 0,
        downKbps: Number(nsDownIn.value) || 0,
        upKbps: Number(nsUpIn.value) || 0,
        hosts: nsHostsIn.value.trim(),
        urlFilter: nsUrlIn.value.trim(),
        scope: nsScopeSel.value,
      }, '保存失败')
      nsApplyBtn.addEventListener('click', () => saveNetsim())
      nsEnableCb.addEventListener('change', () => saveNetsim())
      nsPresetSel.addEventListener('change', () => {
        const p = nsPresetSel.value
        if (p === '') return
        // 预设只覆盖数值；开关跟随预设（off 关，其它开），过滤条件保持用户填的
        postNetsim({ preset: p, hosts: nsHostsIn.value.trim(), urlFilter: nsUrlIn.value.trim(), scope: nsScopeSel.value }, '套用预设失败')
          .finally(() => { nsPresetSel.value = '' })
      })

      // ---- 详情里的「Mock ▾」：一键 mock / 延时 / 超时（作用于当前记录的 方法 + 接口路径）
      const pathKeyOf = (u) => String(u ?? '').split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase()
      const setMockHint = (kind, text) => {
        mockHint.textContent = text
        mockHint.className = `apv-mock-hint ${kind === 'ok' ? 'apv-ok' : kind === 'warn' ? 'apv-warn' : 'apv-note'}`
        mockHint.title = text
      }
      mockSel.addEventListener('change', () => {
        const choice = mockSel.value
        mockSel.value = ''
        if (choice === '' || currentFull === null) return
        const rec = currentFull
        if (choice === 'original') {
          // 原响应 → 带进规则表单编辑；点「生效」时写成这个接口的一键规则（替换旧的、排最前，C38）
          const raw = typeof rec.resBody === 'string' ? rec.resBody : ''
          const rawKind = detectBodyKind(raw, '').kind
          if (raw.endsWith('…(截断)')) {
            setMockHint('warn', '原响应超过 2MB 被截断了，不能当 mock 正文；可以在「代理规则」里手填正文')
            return
          }
          if (rawKind === 'hex' || rawKind === 'base64') {
            setMockHint('warn', '原响应不是文本（存的是十六进制 / base64），不能带进表单编辑')
            return
          }
          if (rulesWrap.hidden) toggleToolPanel(rulesWrap)
          resetRuleForm()
          // 保留原文的缩进：数字、字符串一个字都不改（大整数 ID 不会被四舍五入，C7）
          const prefill = prettyJsonText(raw)
          ruleFormMode = 'quick-original'
          quickPrefill = prefill
          quickRecordId = typeof rec.id === 'string' ? rec.id : null
          ruleNameIn.value = `Mock ${pathKeyOf(rec.url).split('/').slice(-2).join('/')}`
          setRuleMethod(rec.method ?? '')
          ruleUrlIn.value = String(rec.url ?? '').split('#')[0].split('?')[0]
          ruleTypeSel.value = 'path'
          ruleActionSel.value = 'mock'
          ruleStatusIn.value = String(Number.isInteger(rec.status) && rec.status >= 100 && rec.status <= 599 ? rec.status : 200)
          ruleBodyIn.value = prefill
          syncRuleForm()
          setRulesNote('已把原响应带进表单（JSON 只重排了缩进，数字和字符串保持原文）：改完正文点「生效」——按「方法 + 接口路径」写成这个接口的一键规则、放到最前面，替换它原来的一键规则（忽略查询参数）。', null)
          ruleBodyIn.focus()
          return
        }
        if (choice === 'remove') {
          // 宿主一次删掉这个接口的一键规则：方法相同的，加上不限方法的（智能体不带 method 加的那种，C27）
          const seq = rulesGate.next()
          apiFetch('/proxy/rules/op', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'removeQuick', url: rec.url, method: rec.method ?? '' }),
          })
            .then((r) => {
              if (rulesGate.accept(seq)) applyRulesData(r)
              const n = typeof r?.changed === 'number' ? r.changed : null
              const removed = n !== null ? n > 0 : r?.changed === true
              setMockHint('note', !removed ? '这个接口没有一键规则' : n !== null ? `已取消这个接口的 ${n} 条一键规则` : '已取消这个接口的一键规则')
            })
            .catch((error) => setMockHint('warn', `取消失败：${errText(error)}`))
          return
        }
        const [preset, ms] = choice.split(':')
        const seq = rulesGate.next()
        apiFetch('/proxy/rules/quick', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: rec.url, method: rec.method, preset, recordId: rec.id, ...(ms ? { latencyMs: Number(ms) } : {}) }),
        })
          .then((r) => {
            if (rulesGate.accept(seq)) applyRulesData(r)
            // 生不生效、为什么：用宿主按这条规则的 URL 算出来的 reach（这个域名在不在拦截名单、是否在排空…，C9）
            const reach = reachOf(r)
            setMockHint(reach.takesEffect ? 'ok' : 'warn', `${r.replaced ? '已替换' : '已添加'}：${r.rule?.name ?? ''}` +
              (reach.note !== '' ? ` · ${reach.note}` : reach.takesEffect ? '' : ' · ⚠ 暂不生效'))
          })
          .catch((error) => setMockHint('warn', `失败：${errText(error)}`))
      })
      saveBaselineBtn.addEventListener('click', () => {
        const name = window.prompt('给基线起个名字（保存当前筛选命中的接口契约）：', '基线 ' + new Date().toISOString().slice(0, 10))
        if (name === null || name.trim() === '') return
        saveBaselineBtn.disabled = true
        apiFetch('/baseline/save', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // 和列表同一套筛选：上方的筛选 + 当前启用的过滤器（R5-03：以前只带上方的筛选，过滤器排除掉的接口也进了基线）
          body: JSON.stringify({ name: name.trim(), filter: { ...currentFilter(), ...(state.activeFilter !== null ? { conditions: filterPayload(state.activeFilter, fd.opsById) } : {}) } }),
        })
          .then((r) => {
            healthHint.textContent = `基线已保存: ${r.name} · ${r.records} 条 · ${r.endpoints} 端点`
            state.baselineName = r.name
            return apiFetch('/baseline/list')
          })
          .then((list) => renderBaselineSel(list?.items ?? []))
          .catch((error) => {
            healthHint.textContent = `保存基线失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            saveBaselineBtn.disabled = false
          })
      })
      diffBaselineBtn.addEventListener('click', () => {
        if (baselineSel.value === '') {
          healthHint.textContent = '请先选择要对比的基线'
          return
        }
        diffBaselineBtn.disabled = true
        apiFetch('/baseline/diff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: baselineSel.value }) })
          .then((report) => {
            state.baselineReport = report
            state.baselineName = report.name
            setView('baseline')
          })
          .catch((error) => {
            healthHint.textContent = `对比失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            diffBaselineBtn.disabled = false
          })
      })
      delBaselineBtn.addEventListener('click', () => {
        if (baselineSel.value === '') return
        if (!window.confirm(`删除基线「${baselineSel.value}」？`)) return
        apiFetch(`/baseline/${encodeURIComponent(baselineSel.value)}`, { method: 'DELETE' })
          .then(() => {
            if (state.baselineReport !== null && state.baselineReport.name === baselineSel.value) state.baselineReport = null
            refresh()
          })
          .catch((error) => {
            healthHint.textContent = `删除基线失败: ${error instanceof Error ? error.message : String(error)}`
          })
      })
      baselineSel.addEventListener('change', () => {
        state.baselineName = baselineSel.value
      })
      locateSrcBtn.addEventListener('click', () => {
        if (currentFull === null || currentFull.caller === undefined || currentFull.caller === null) return
        const c = currentFull.caller
        locateSrcBtn.disabled = true
        locateSrcBtn.textContent = '查找中…'
        apiFetch('/source/locate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vm: c.viewModel, api: c.apiMethod, stack: c.stack }),
        })
          .then((result) => renderSourceHits(result, c))
          .catch((error) => {
            console.error('[dsh-api-visualizer] source locate failed:', error)
            detailBody.insertBefore(makePreSection('定位源码', `查找失败: ${error instanceof Error ? error.message : String(error)}`), detailBody.firstChild)
          })
          .finally(() => {
            locateSrcBtn.disabled = false
            locateSrcBtn.textContent = '定位源码'
          })
      })
      proxyBtn.addEventListener('click', () => {
        const path = state.proxy.running ? '/proxy/stop' : '/proxy/start'
        const port = Math.max(1, Math.min(65535, Number(portInput.value) || 8899))
        proxyBtn.disabled = true
        apiFetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ port }),
        })
          .then((cap) => renderProxy(cap))
          .catch((error) => {
            console.error('[dsh-api-visualizer] proxy toggle failed:', error)
            proxyChip.textContent = `代理操作失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            proxyBtn.disabled = false
            refresh()
          })
      })
      caBtn.addEventListener('click', () => {
        caBtn.disabled = true
        proxyChip.textContent = '正在导入根证书…'
        apiFetch('/proxy/install-ca', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => {
            proxyChip.textContent = r.ok === true ? '根证书已导入本机信任（当前用户）' : `导入结果: ${r.output ?? '未知'}`
          })
          .catch((error) => {
            console.error('[dsh-api-visualizer] install-ca failed:', error)
            proxyChip.textContent = `导入失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            caBtn.disabled = false
            refresh()
            if (!icWrap.hidden) loadIntercept({ fresh: true }) // 透明拦截面板里的「根证书」一行马上按新状态重查（C37）
          })
      })
      sysProxyBtn.addEventListener('click', () => {
        const enable = !(state.proxy.status?.systemProxyActive === true)
        sysProxyBtn.disabled = true
        proxyChip.textContent = enable ? '正在把系统代理指向本代理…' : '正在恢复系统代理…'
        apiFetch('/proxy/system-proxy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enable }),
        })
          .then(() => refresh())
          .catch((error) => {
            console.error('[dsh-api-visualizer] system-proxy failed:', error)
            proxyChip.textContent = `系统代理操作失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            sysProxyBtn.disabled = false
          })
      })
      // 导出用：游标翻页把匹配记录全部取回（服务端单页 limit 上限 2000，store
      // 上限 20000）。原来导出固定 limit=2000 会静默丢掉更早的记录（丢数据）。
      /** 按筛选翻页取全部记录；filterApplied = 第一页里宿主报的「实际生效的过滤条件」（旧宿主不认过滤条件 ⇒ null）。 */
      const fetchAllRecords = async (baseParams) => {
        const all = []
        let filterApplied = null
        let cursor = ''
        for (let guard = 0; guard < 40; guard++) { // 40×2000 远超 store 上限，靠 hasMore 收敛
          const p = new URLSearchParams(baseParams)
          p.set('limit', '2000')
          if (cursor !== '') p.set('cursor', cursor)
          const data = await apiFetch(`/records?${p.toString()}`)
          if (guard === 0) filterApplied = Array.isArray(data?.filterApplied) ? data.filterApplied : null
          const items = data.items ?? []
          all.push(...items)
          if (data.hasMore !== true || typeof data.nextCursor !== 'string' || data.nextCursor === '' || items.length === 0) break
          cursor = data.nextCursor
        }
        return { items: all, filterApplied }
      }
      // -------- AI 分析包（Markdown）：宿主按当前列表的筛选（含过滤器）查出记录，生成摘要 + 明细，存一份并返回
      const EXPORT_TITLE = exportBtn.title
      const AI_EXPORT_TITLE = '生成给 AI 看的 Markdown 分析包：概况、接口汇总、最慢 / 出错的请求、按时间排的请求明细（正文按选的长度截断）；宿主同时存一份到捕获目录的 exports 下。勾「脱敏」会把 token / cookie 之类写成 ***'
      const syncExportControls = () => {
        const ai = exportSel.value === 'AI'
        aiBodySel.hidden = !ai
        aiLimitIn.hidden = !ai
        if (!exportBtn.disabled) exportBtn.textContent = '导出'
        exportBtn.title = ai ? AI_EXPORT_TITLE : EXPORT_TITLE
        exportRedactWrap.title = ai ? '勾选后，敏感请求头（Authorization、Cookie…）和查询参数（token、password…）在分析包里写成 ***' : ''
      }
      exportSel.addEventListener('change', syncExportControls)
      aiBodySel.addEventListener('change', savePrefs)
      aiLimitIn.addEventListener('change', savePrefs)
      const aiExportErrText = (error) => {
        if (error?.status === 404 && error?.code === undefined) return 'AI 分析包生成失败：宿主是旧版本，没有这个接口（需要重启 DSH 加载新插件）'
        if (error?.code === 'FILTER_INVALID') return `AI 分析包生成失败：过滤器有问题：${errText(error)}`
        return `AI 分析包生成失败：${errText(error)}`
      }
      const runAiExport = () => {
        const params = setQuickParams(new URLSearchParams())
        const sent = setFilterParam(params, { forPost: true })
        let limit = Math.floor(Number(aiLimitIn.value))
        if (!Number.isFinite(limit) || limit < 1) limit = 500
        limit = Math.min(limit, 5000)
        aiLimitIn.value = String(limit)
        const bodyLimit = Number(aiBodySel.value)
        const payload = {
          params: Object.fromEntries(params),
          limit,
          bodyLimit: Number.isFinite(bodyLimit) && bodyLimit >= 0 ? bodyLimit : 4096,
          redact: exportRedactCb.checked,
        }
        exportBtn.disabled = true
        exportBtn.textContent = '生成中…'
        apiFetch('/records/export-ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          .then((r) => {
            const markdown = typeof r?.markdown === 'string' ? r.markdown : null
            const path = typeof r?.path === 'string' ? r.path : ''
            const count = Number(r?.count) || 0
            const total = Number(r?.totalMatched)
            const fileName = `api-capture-ai-${fileStamp()}.md`
            if (markdown !== null) downloadBlob(fileName, markdown, 'text/markdown;charset=utf-8')
            const parts = [`AI 分析包已生成：${count} 条记录`]
            if (Number.isFinite(total) && total > count) parts.push(`只导出了最新 ${count} 条，共匹配 ${total} 条`)
            if (sent !== null) parts.push(`过滤器「${sent.filter.name}」`)
            if (Number(r?.truncatedBodies) > 0) parts.push(`${Number(r.truncatedBodies)} 段正文按 ${fmtBytes(payload.bodyLimit)} 截断`)
            if (Number.isFinite(Number(r?.bytes))) parts.push(fmtBytes(Number(r.bytes)))
            parts.push(markdown !== null ? `已下载 ${fileName}` : '内容超过 4 MB，没有随响应返回：请直接打开下面保存的文件')
            const actions = []
            if (path !== '') actions.push({ label: '复制路径', title: '复制保存路径（把这个文件交给 AI 读）', onClick: (b) => copyText(path, b, '复制路径') })
            if (markdown !== null) actions.push({ label: '复制全文', title: '复制整份 Markdown，直接粘贴给 AI', onClick: (b) => copyText(markdown, b, '复制全文') })
            showNotice('ok', parts.join(' · ') + (path !== '' ? `\n保存在：${path}` : ''), actions)
          })
          .catch((error) => showNotice('warn', aiExportErrText(error)))
          .finally(() => {
            exportBtn.disabled = false
            exportBtn.textContent = '导出'
          })
      }
      exportBtn.addEventListener('click', () => {
        const format = exportSel.value
        if (format === 'AI') {
          runAiExport()
          return
        }
        const redact = exportRedactCb.checked
        exportBtn.disabled = true
        exportBtn.textContent = '导出中…'
        // 和列表同一套筛选：上方的筛选 + 当前启用的过滤器
        const params = setQuickParams(new URLSearchParams({ includeBody: '1' }))
        const sent = setFilterParam(params)
        fetchAllRecords(params)
          .then(({ items: all, filterApplied }) => {
            // R5-04：宿主没按过滤器筛（旧版本不认过滤条件）⇒ 拿到的是更宽的一批，不能当成列表里看到的那些导出去
            if (sent !== null && enabledCondCount(sent.filter) > 0 && filterApplied === null) {
              showNotice('warn', `宿主没有应用过滤器「${sent.filter.name}」（旧版本？需要重启 DSH），按上方筛选导出会带上列表里被过滤掉的记录，已取消导出。`)
              return
            }
            const items = all.map((r) => (redact ? redactRecord(r) : r))
            exportBtn.title = `上次导出 ${items.length} 条`
            const stamp = fileStamp()
            if (format === 'HAR') {
              downloadBlob(`api-capture-${stamp}.har`, JSON.stringify(buildHar(items), null, 2), 'application/json')
            } else if (format === 'JSON') {
              downloadBlob(`api-capture-${stamp}.json`, JSON.stringify(items, null, 2), 'application/json')
            } else if (format === 'OpenAPI') {
              downloadBlob(`api-capture-${stamp}.openapi.json`, JSON.stringify(buildOpenApi(items), null, 2), 'application/json')
            } else {
              const esc = (v) => {
                const s = v === null || v === undefined ? '' : String(v)
                return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
              }
              const callerText = (r) => {
                const c = r.caller
                if (c === null || c === undefined) return ''
                const chain = formatCallChain(c.stack)
                if (chain !== '') return chain
                const who = c.viewModel || c.view || ''
                return who + (c.viewModel && c.apiMethod && c.apiMethod !== who ? ' <- ' + c.apiMethod : '')
              }
              const head = ['ts', 'method', 'url', 'status', 'durationMs', 'source', 'caller', 'note', 'tag'].join(',')
              const rows = items.map((r) => [r.ts ?? '', r.method ?? '', esc(r.url ?? ''), r.status ?? '', r.durationMs ?? '', r.source ?? '', esc(callerText(r)), esc(r.note ?? ''), esc(r.tag ?? '')].join(','))
              downloadBlob(`api-capture-${stamp}.csv`, '\ufeff' + [head, ...rows].join('\n'), 'text/csv;charset=utf-8')
            }
          })
          .catch((error) => {
            console.error('[dsh-api-visualizer] export failed:', error)
            stats.textContent = `导出失败: ${error instanceof Error ? error.message : String(error)}`
          })
          .finally(() => {
            exportBtn.disabled = false
            exportBtn.textContent = '导出'
          })
      })
      // -------- 导入 HAR / JSON（回灌进捕获库，复用 /ingest）
      const harHeadersToObj = (list) => {
        const out = {}
        for (const h of Array.isArray(list) ? list : []) {
          if (h !== null && typeof h === 'object' && typeof h.name === 'string' && !h.name.startsWith(':')) out[h.name] = String(h.value ?? '')
        }
        return out
      }
      const harToRecords = (entries) => {
        const out = []
        for (const e of entries) {
          if (e === null || typeof e !== 'object') continue
          const req = e.request ?? {}
          const res = e.response ?? {}
          if (typeof req.method !== 'string' || typeof req.url !== 'string') continue
          const rec = { source: 'import', method: req.method, url: req.url, ts: e.startedDateTime ? (Date.parse(e.startedDateTime) || Date.now()) : Date.now() }
          if (Number.isFinite(e.time)) rec.durationMs = Math.round(e.time)
          if (Number.isInteger(res.status) && res.status > 0) rec.status = res.status
          const rh = harHeadersToObj(req.headers)
          if (Object.keys(rh).length > 0) rec.reqHeaders = rh
          const sh = harHeadersToObj(res.headers)
          if (Object.keys(sh).length > 0) rec.resHeaders = sh
          if (req.postData !== null && typeof req.postData === 'object' && typeof req.postData.text === 'string' && req.postData.text !== '') rec.reqBody = req.postData.text
          const content = res.content ?? {}
          if (typeof content.text === 'string' && content.text !== '') {
            rec.resBody = content.encoding === 'base64'
              ? `base64:${String(content.mimeType || 'application/octet-stream').split(';')[0]};${content.text}`
              : content.text
          }
          if (typeof content.mimeType === 'string' && content.mimeType !== '') rec.contentType = content.mimeType
          rec.note = '导入 · HAR'
          out.push(rec)
        }
        return out
      }
      // 解析导入内容：HAR(.log.entries) 或 我们导出的 JSON（记录数组 / {items:[]}）
      const parseImport = (parsed) => {
        if (parsed !== null && typeof parsed === 'object' && parsed.log && Array.isArray(parsed.log.entries)) return harToRecords(parsed.log.entries)
        const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : [])
        return arr.filter((r) => r !== null && typeof r === 'object' && typeof r.method === 'string' && typeof r.url === 'string')
      }
      const ingestInBatches = async (records) => {
        let total = 0
        for (let i = 0; i < records.length; i += 500) {
          const batch = records.slice(i, i + 500)
          const data = await apiFetch('/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ records: batch }) })
          total += Number(data?.ingested) || batch.length
        }
        return total
      }
      importBtn.addEventListener('click', () => importFile.click())
      importFile.addEventListener('change', () => {
        const file = importFile.files && importFile.files[0]
        if (!file) return
        importBtn.disabled = true
        importBtn.textContent = '导入中…'
        const done = (msg) => { importBtn.disabled = false; importBtn.textContent = '导入'; importFile.value = ''; if (msg) window.alert(msg) }
        const reader = new FileReader()
        reader.onerror = () => done('读取文件失败')
        reader.onload = () => {
          let records
          try {
            records = parseImport(JSON.parse(String(reader.result ?? '')))
          } catch {
            done('解析失败：不是有效的 HAR / JSON 文件')
            return
          }
          if (records.length === 0) { done('文件里没有可导入的记录'); return }
          ingestInBatches(records)
            .then((n) => { importBtn.title = `上次导入 ${n} 条`; refresh() })
            .catch((error) => { console.error('[dsh-api-visualizer] import failed:', error); window.alert('导入失败：' + (error instanceof Error ? error.message : String(error))) })
            .finally(() => done())
        }
        reader.readAsText(file)
      })
      clearBtn.addEventListener('click', () => {
        if (window.confirm('清空全部接口捕获记录？')) {
          apiFetch('/records', { method: 'DELETE' }).then(() => refresh()).catch((error) => {
            console.error('[dsh-api-visualizer] clear failed:', error)
          })
        }
      })
      q.addEventListener('input', () => {
        state.q = q.value.trim()
        refresh()
      })
      methodSel.addEventListener('change', () => {
        state.method = methodSel.value
        refresh()
      })
      statusSel.addEventListener('change', () => {
        state.status = statusSel.value
        refresh()
      })
      sourceSel.addEventListener('change', () => {
        state.source = sourceSel.value
        refresh()
      })
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !state.open) return
        // 过滤器对话框开着：Esc 只关对话框（没保存的修改留着，列表里带 ●）
        if (fdIsOpen()) {
          event.preventDefault()
          closeFilterDialog()
          return
        }
        setOpen(false)
      })
      // 上下方向键在表格行间移动选中并打开详情（仅表格视图、焦点不在输入控件时）
      const moveSelection = (delta) => {
        if (!state.open || activeView() !== null) return
        const list = renderedRecords
        if (!Array.isArray(list) || list.length === 0) return
        let idx = list.findIndex((r) => r.id === selectedId)
        idx = idx === -1 ? (delta > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, idx + delta))
        const rec = list[idx]
        if (rec === undefined || rec === null) return
        selectedId = rec.id
        const trs = tbody.querySelectorAll('tr')
        trs.forEach((n) => n.classList.remove('apv-selected'))
        const tr = trs[idx]
        if (tr !== undefined && tr !== null) { tr.classList.add('apv-selected'); tr.scrollIntoView({ block: 'nearest' }) }
        apiFetch(`/records/${encodeURIComponent(rec.id)}`).then((full) => { renderDetail(full); detail.hidden = false }).catch((error) => { console.error('[dsh-api-visualizer] detail failed:', error) })
      }
      document.addEventListener('keydown', (event) => {
        if (!state.open || fdIsOpen()) return
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const tag = (event.target && event.target.tagName) || ''
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (activeView() !== null) return
        event.preventDefault()
        moveSelection(event.key === 'ArrowDown' ? 1 : -1)
      })

      // ---- prefs init (P2-14 部分持久化)
      autoScrollCb.checked = state.autoScroll
      autoCapCb.checked = initialPrefs.autoCapture === true
      logPathIn.value = typeof initialPrefs.logPath === 'string' ? initialPrefs.logPath : ''
      renderSavedSel()
      if ([...aiBodySel.options].some((o) => o.value === String(initialPrefs.aiBodyLimit))) aiBodySel.value = String(initialPrefs.aiBodyLimit)
      const savedAiLimit = Math.floor(Number(initialPrefs.aiLimit))
      if (Number.isFinite(savedAiLimit) && savedAiLimit >= 1 && savedAiLimit <= 5000) aiLimitIn.value = String(savedAiLimit)
      syncExportControls()
      renderFilterButton()

      return { view, toggle, setOpen }
    }

    // ------------------------------------------ cross-plugin: postman 返回按钮

    /**
     * 在「接口调试」面板工具栏注入「← 接口捕获」按钮（纯 DOM 注入，不改 postman 文件）。
     * 点击打开接口捕获面板；接口捕获 setOpen 会清掉 postman 的 active 标记，postman 面板随之隐藏。
     */
    function injectPostmanBackBtn(openCapture) {
      if (typeof document === 'undefined') return () => {}
      const tryInject = () => {
        const pmView = document.querySelector('[data-dsh-postman-view]')
        if (pmView === null) return
        const toolbar = pmView.querySelector('.pm-toolbar')
        if (toolbar === null) return
        if (toolbar.querySelector('[data-apv-back-entry]') !== null) return
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.dataset.apvBackEntry = ''
        btn.title = '返回「接口捕获」面板'
        btn.textContent = '← 接口捕获'
        btn.addEventListener('click', () => {
          // 必须直接 setOpen(true)：postman 打开时会清掉 active 标记但改不到我的
          // 内部 state，此时再点侧边栏入口会先“关”一次，表现为要点两下。
          openCapture(true)
        })
        const close = toolbar.querySelector('.pm-close')
        if (close !== null) toolbar.insertBefore(btn, close)
        else toolbar.appendChild(btn)
      }
      const obs = new MutationObserver(tryInject)
      obs.observe(document.body, { childList: true, subtree: true })
      tryInject()
      return () => obs.disconnect()
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
        const { view, toggle, setOpen } = buildPanel()
        const disposers = []
        try {
          disposers.push(mountSidebarEntry(toggle))
          disposers.push(injectPostmanBackBtn(setOpen))
          const column = centerColumn()
          column.appendChild(view)
          disposers.push(() => view.remove())
        } catch (error) {
          console.error('[dsh-api-visualizer] mount failed:', error)
        }
        ctx.effect(() => () => { for (const dispose of disposers.splice(0)) dispose() }, 'dsh-api-visualizer: teardown')
      } catch (error) {
        // never take the GUI down
        console.error('[dsh-api-visualizer] apply failed:', error)
      }
    }

    exports.apply = apply
    exports.inject = []
    // 只导出这一个纯函数：它的语义（分桶/计数/"解析不出域名的记录不许被丢掉"）需要被
    // 校验直接钉住，而 client.js 的其余部分要 document/localStorage 才能跑（校验进程里进不来）。
    exports.__buildUrlTree = buildUrlTree
    return module.exports
  },
})
