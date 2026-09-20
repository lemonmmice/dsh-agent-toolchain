/**
 * dsh-perf 火焰图 —— 把 ETW CPU 采样折叠成火焰图（folded stacks + 自包含可交互 HTML）。
 *
 * 这是「与 PerfView 对照」里 §1 那条 ❌「交互式 GUI（故意）」的补齐：PerfView 的招牌就是可点开、
 * 可缩放、可搜索的火焰图 / CallTree。我们此前只有 `perf_hotstacks` 的**文本**蝶形视图（调用者/被
 * 调用者对），给不了「从根到叶的一整棵 CPU 时间树」。本模块补上这棵树。
 *
 * ── 为什么用 `xperf -a dumper` 而不是 `-a stack -butterfly`（hotstacks 那条）：
 *    · `-a stack -butterfly` 产出的是**扁平**的 caller/callee 对（HTML 表），拼不回完整的根→叶栈；
 *    · `-a dumper` 会把 trace 里的原始事件逐条打出来，其中 `Stack` 事件**每行一帧**，
 *      同一 `(TimeStamp, ThreadID)` 的多行连成一次完整栈 —— 这正是火焰图要的输入
 *      （Bruce Dawson / Brendan Gregg 的 xperf→folded 转换脚本走的也是这条）。
 *    · 代价（doc §4.3 实测）：dumper 的 CSV 是 etl 的 ~7×（79.5MB etl → 585MB CSV / 15s）。
 *      所以本模块**全程流式**（Rust 后台任务，不把 CSV 读进内存）、**按进程名过滤**，
 *      折叠结果的规模只跟"目标进程的采样数"走，与 CSV 大小无关。
 *
 * ── 折叠口径（每一条都是会被误读的点，写清楚）：
 *  1. **CPU 栈 ≠ 所有 Stack 事件**。采集带了 `-stackwalk PROFILE+CSWITCH`，所以 `Stack` 事件里
 *     既有 CPU 采样（SampledProfile）的栈，也有上下文切换（CSwitch，= 线程被**阻塞/等待**时）的栈。
 *     火焰图要的是 CPU 时间 ⇒ 只折叠那些 `(ts,tid)` 命中了 `SampledProfile` 的 Stack 簇。
 *     （CSwitch 的"等待栈"是另一种有用视图 —— wall-clock/thread-time —— 但**不是** CPU 火焰图，别混。）
 *  2. **帧序**：`Stack` 事件 `No.=1` 是**叶子**（采样落点，= SampledProfile 的 Image!Function），
 *     No. 越大越靠根。folded 要 root→leaf ⇒ 收集后**反转**。（本机 2026-09-17 实测确认。）
 *  3. **未解析帧必须塌缩到模块级**，否则火焰图会退化：离线（不连符号服务器）时每帧是
 *     `module!0x地址`，地址各不相同 ⇒ 每条栈都唯一 ⇒ 根本聚不起来、火焰图变成一根根竹签。
 *     所以 `module!0x...` 一律塌成 `module`（连成一片可读的"模块火焰图"：SciChart / WPF / clr /
 *     客户端各占多少 CPU 一眼可见）。symbols=true 时能解析的原生/框架帧保留 `module!Function`。
 *  4. **客户端自己的方法名解不出来**是已知的（doc §3：客户端程序集是 JIT 的，dbghelp 认地址认不出方法）
 *     —— 那些帧会以 `ClientApp.exe`（模块级）出现，等 §4 的 JIT 地址→方法映射接线后才会有方法名。
 *     本工具**不假装**能解客户端方法：它诚实地按模块聚。
 *
 * 纯逻辑（fold / 建树 / 生成 HTML）都放这里、不碰 xperf，可离线对着 fixture 跑；
 * 起 xperf 出 dumper CSV 的编排在 trace.mjs 的 `flame()` 里（复用 c.xperf / runExe / symbolEnv）。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { openTrace, forEachEvent, foldStacks } from './native-fold.mjs'

/** 逐行流式读一个（可能上 GB 的）文本文件；回调返回 false 可提前停止。 */
export async function forEachLine(path, onLine) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (onLine(line) === false) break
    }
  } finally {
    rl.close()
  }
}

/**
 * 帧规整：`module.dll!0xADDR` / `module.dll!Func` / `"Unknown"!0xADDR` → 火焰图里的一个帧名。
 *  - mode='module'：一律取模块名（塌掉地址/函数）；
 *  - mode='symbols'：能解析的保留 `module!Func`，未解析（函数是 0x 地址或空）塌回模块名。
 */
export function normalizeFrame(raw, mode) {
  const frame = String(raw).trim()
  const bang = frame.indexOf('!')
  let mod = bang >= 0 ? frame.slice(0, bang) : frame
  const fn = bang >= 0 ? frame.slice(bang + 1) : ''
  // `"Unknown"` = 连模块名都没有（JIT stub / 无镜像）。去掉引号，标成可读的占位。
  if (mod === '"Unknown"' || mod === 'Unknown' || mod === '') mod = '[unknown]'
  if (mode !== 'symbols') return mod
  if (fn === '' || /^0x[0-9a-fA-F]+$/.test(fn)) return mod // 未解析 ⇒ 模块级
  return mod + '!' + fn
}

/**
 * 流式折叠 dumper CSV → folded stacks。
 * @param {string} csvPath  `xperf -a dumper` 的 CSV
 * @param {object} opts
 * @param {RegExp} opts.processRe   只折叠该进程名（对 `Process Name ( PID)` 整串匹配）
 * @param {'module'|'symbols'} opts.frameMode  帧规整口径（默认 module）
 * @param {boolean} opts.foldRecursion  折叠**连续同名**帧（默认 true：既折递归，也把"同模块的一串未解析帧"收成一格）
 * @param {Map<string, Array>} opts.jitMap  可选：pid → 排序方法数组（jitmap.mjs）。传了就把 `"Unknown"!0xADDR`
 *        JIT 帧按**该帧所属线程的 pid** 查回托管方法名（客户端自己的代码从 `[unknown]` 变成真实方法名）。
 * @returns {Promise<{ folded, samplesAll, samplesTarget, stacksFolded, uniqueStacks, topLeaves, topModules, jit }>}
 */
export async function foldDumperCsv(csvPath, opts = {}) {
  const processRe = opts.processRe || /./
  const frameMode = opts.frameMode === 'symbols' ? 'symbols' : 'module'
  const foldRecursion = opts.foldRecursion !== false
  const jitMap = opts.jitMap || null

  const reader = openTrace(csvPath)
  try {
    // ── Pass 1：目标进程的 CPU 采样 (ts,tid) 键集合 + tid→pid（JIT 映射按 pid 分桶，查表要用采样帧线程的 pid）。
    const sampleKeys = new Set()
    const tidToPid = new Map()
    let samplesAll = 0
    let samplesTarget = 0
    await forEachEvent(reader, 'SampledProfile', (line) => {
      const p = line.split(',')
      const ts = parseInt(p[1], 10)
      const tid = parseInt(p[3], 10)
      if (!Number.isFinite(ts) || !Number.isFinite(tid)) return // 表头行（TimeStamp/ThreadID 非数字）跳过
      samplesAll++
      const proc = (p[2] || '').trim()
      if (processRe.test(proc)) {
        samplesTarget++
        sampleKeys.add(ts + '\t' + tid)
        // `Process Name ( PID)` → 取 pid（JIT 映射的 key）。同一 tid 归属稳定，记一次即可。
        if (jitMap && !tidToPid.has(tid)) {
          const pm = /\(\s*(\d+)\s*\)/.exec(proc)
          if (pm) tidToPid.set(tid, pm[1])
        }
      }
    })

    const { folded, stacksFolded, jitAttempted, jitResolved } = await foldStacks(
      reader, new Map([...sampleKeys].map(key => [key, 1])), tidToPid, jitMap, frameMode, foldRecursion)

    // ── 顺带算文本摘要要用的：最热叶子 + 各模块包含命中（inclusive）。
    const leafHits = new Map()
    const moduleIncl = new Map()
    for (const [stack, n] of folded) {
      const frames = stack.split(';')
      const leaf = frames[frames.length - 1]
      leafHits.set(leaf, (leafHits.get(leaf) || 0) + n)
      const mods = new Set(frames.map((f) => f.split('!')[0]))
      for (const m of mods) moduleIncl.set(m, (moduleIncl.get(m) || 0) + n)
    }
    const topN = (map, k) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
      .map(([name, hits]) => ({ name, hits }))

    return {
      folded,
      samplesAll,
      samplesTarget,
      stacksFolded,
      uniqueStacks: folded.size,
      topLeaves: topN(leafHits, 15),
      topModules: topN(moduleIncl, 15),
      jit: jitMap ? { attempted: jitAttempted, resolved: jitResolved, pids: [...new Set(tidToPid.values())] } : null,
    }
  } finally { reader.close() }
}

/** AllocationTick 行取 TypeName（第 15 列，被引号包住且**泛型名含逗号**，所以不能按逗号切——用引号对提取）。 */
export function allocTypeName(line) {
  // 行尾形如 `…, 0xTypeID, "Type.Name", HeapIndex, 0xAddr`。取**最后一个**带引号字段即 TypeName
  // （第一个带引号字段是 `Process Name ( PID)` 里的 "Unknown"）。
  const m = line.match(/"([^"]*)"\s*,\s*\d+\s*,\s*0x[0-9A-Fa-f]+\s*$/)
  return m ? m[1] : null
}

/**
 * 流式折叠 AllocationTick 的分配栈 → **按字节加权**的 folded（PerfView 的 "GC Heap Alloc Stacks"）。
 * 与 foldDumperCsv 同构，但：种子是 `GCAllocationTick` 事件（不是 SampledProfile），
 * 每条栈的权重是该 tick 的 `AllocationAmount64` 字节（不是 1），并额外按 TypeName 汇总"分配大头类型"。
 *
 * 口径（会被误读的点）：AllocationTick **每分配约 100KB 采一次**（不是每次分配）——所以这是**采样**，
 * 权重用字节近似"这条调用路径分配了多少内存"，不是精确到每个对象。分配 ≠ 存活（多数很快被 GC 回收）；
 * 它回答的是"**谁在制造 GC 压力/churn**"，不是"谁泄漏"（泄漏看 perf_gcroot）。
 *
 * @returns {{ folded, ticksAll, ticksTarget, totalBytes, byType, jit }}
 */
export async function foldAllocCsv(csvPath, opts = {}) {
  const processRe = opts.processRe || /./
  // ★ 分配采样是 xperf **用户会话**：AllocationTick 行的进程名多为 `"Unknown" (PID)`（用户会话没有进程名 rundown）——
  //   所以**优先按 PID 集**过滤（pidSet），进程名正则只作回退（进程恰好有内核 rundown 补名时才有用）。
  const pidSet = opts.pidSet instanceof Set ? opts.pidSet : null
  const frameMode = opts.frameMode === 'symbols' ? 'symbols' : 'module'
  const foldRecursion = opts.foldRecursion !== false
  const jitMap = opts.jitMap || null
  const ALLOC = 'Microsoft-Windows-DotNETRuntime/GarbageCollection/GCAllocationTick'
  const pidOf = (proc) => { const m = /\(\s*(\d+)\s*\)/.exec(proc); return m ? m[1] : null }
  const matchProc = (proc) => {
    const pid = pidOf(proc)
    if (pidSet) return pid !== null && pidSet.has(pid) // 有 pidSet 就**只**认 pid（名字不可靠）
    return processRe.test(proc)
  }

  const reader = openTrace(csvPath)
  try {
    // ── Pass 1：目标进程的 AllocationTick → (ts,tid)→bytes；tid→pid；按 TypeName 汇总字节/次数。
    const tickBytes = new Map()      // "ts\ttid" -> bytes（该 tick 的分配量）
    const tidToPid = new Map()
    const byType = new Map()         // TypeName -> [bytes, count]
    let ticksAll = 0, ticksTarget = 0, totalBytes = 0
    await forEachEvent(reader, ALLOC, (line) => {
      const p = line.split(',')
      if (p[0].trim() !== ALLOC) return
      const ts = parseInt(p[1], 10)
      const tid = parseInt(p[3], 10)
      if (!Number.isFinite(ts) || !Number.isFinite(tid)) return // 表头
      ticksAll++
      const proc = (p[2] || '').trim()
      if (!matchProc(proc)) return
      ticksTarget++
      // AllocationAmount64 = 第 12 列（0x…）；早于含逗号的 TypeName，按列取安全。
      let bytes = 0
      const a64 = (p[12] || '').trim()
      if (/^0x[0-9A-Fa-f]+$/.test(a64)) bytes = Number(BigInt(a64))
      else { const a = (p[9] || '').trim(); if (/^0x[0-9A-Fa-f]+$/.test(a)) bytes = Number(BigInt(a)) }
      if (!(bytes > 0)) bytes = 1
      totalBytes += bytes
      tickBytes.set(ts + '\t' + tid, bytes)
      if (jitMap && !tidToPid.has(tid)) { const pm = /\(\s*(\d+)\s*\)/.exec(proc); if (pm) tidToPid.set(tid, pm[1]) }
      const tn = allocTypeName(line) || '<unknown-type>'
      const e = byType.get(tn); if (e) { e[0] += bytes; e[1]++ } else byType.set(tn, [bytes, 1])
    })

    const { folded, jitAttempted, jitResolved } = await foldStacks(
      reader, tickBytes, tidToPid, jitMap, frameMode, foldRecursion)

    const topTypes = [...byType.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, 20)
      .map(([type, v]) => ({ type, bytes: v[0], ticks: v[1] }))
    return {
      folded, ticksAll, ticksTarget, totalBytes, topTypes,
      jit: jitMap ? { attempted: jitAttempted, resolved: jitResolved } : null,
    }
  } finally { reader.close() }
}

/** folded Map → Brendan-Gregg 折叠文本（`a;b;c 12`）。也可直接拖进 https://speedscope.app 打开。 */
export function foldedToText(folded) {
  return [...folded.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([stack, n]) => stack + ' ' + n)
    .join('\n') + '\n'
}

/** folded Map → 火焰图树 `{n,v,c}`（n=帧名 v=包含采样数 c=子节点数组）。 */
export function buildTree(folded, rootName = 'all') {
  const root = { n: rootName, v: 0, c: [] }
  const childIndex = new Map() // node -> Map(childName -> childNode)
  for (const [stack, n] of folded) {
    root.v += n
    let node = root
    for (const frame of stack.split(';')) {
      let idx = childIndex.get(node)
      if (!idx) { idx = new Map(); childIndex.set(node, idx) }
      let child = idx.get(frame)
      if (!child) { child = { n: frame, v: 0, c: [] }; idx.set(frame, child); node.c.push(child) }
      child.v += n
      node = child
    }
  }
  return root
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/**
 * folded → **自包含**的可交互火焰图 HTML（内联 SVG + 原生 JS，无外链、无 CDN）。
 * 交互：点击方块=缩放到该子树；悬停=提示（帧名 / 采样数 / 占比）；搜索框=高亮匹配帧并报占比；重置。
 * 颜色按**模块**取色（同一模块同色）—— 一眼看出 SciChart / WPF / clr / 客户端各自的热度分布。
 * 树以 JSON 内联，布局/缩放全在浏览器里算（这样缩放不必重生成文件）。
 */
export function renderFlameHtml(tree, meta = {}) {
  const json = JSON.stringify(tree)
  const title = escapeHtml(meta.title || 'CPU Flame Graph')
  const subtitle = escapeHtml(meta.subtitle || '')
  return `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{margin:0;font:12px/1.4 Consolas,Menlo,monospace;background:#fff;color:#111}
  header{padding:8px 12px;border-bottom:1px solid #ddd;background:#fafafa}
  header h1{margin:0 0 4px;font-size:14px}
  header .sub{color:#666;font-size:11px}
  #controls{padding:6px 12px}
  #controls input{font:12px monospace;padding:3px 6px;width:280px}
  #controls button{font:12px monospace;padding:3px 8px;cursor:pointer}
  #matched{color:#a0f;margin-left:8px}
  #chart{width:100%}
  rect{stroke:#fff;stroke-width:.5;cursor:pointer}
  rect:hover{stroke:#000;stroke-width:1}
  text{pointer-events:none;fill:#000;font:11px monospace}
  #tip{position:fixed;display:none;background:#000;color:#fff;padding:5px 8px;border-radius:3px;font-size:11px;max-width:640px;word-break:break-all;pointer-events:none;z-index:9}
  .frame.search-hit rect{stroke:#a0f;stroke-width:1.5}
</style></head>
<body>
<header><h1>${title}</h1><div class="sub">${subtitle} · 点方块缩放 · 悬停看详情 · 搜索高亮 · 颜色=模块</div></header>
<div id="controls">
  <button id="reset">重置缩放</button>
  <input id="search" placeholder="搜索帧名（子串/正则），高亮匹配">
  <span id="matched"></span>
</div>
<svg id="chart" xmlns="http://www.w3.org/2000/svg"></svg>
<div id="tip"></div>
<script>
const DATA = ${json};
const ROW = 18, MINW = 0.35;
const svg = document.getElementById('chart'), tip = document.getElementById('tip');
let W = Math.max(720, document.documentElement.clientWidth - 4);
let focus = DATA, total = DATA.v || 1, searchRe = null;
const moduleOf = (n) => { const i=n.indexOf('!'); return i<0?n:n.slice(0,i); };
// 模块名 → 稳定色相（暖色系，PerfView/flamegraph 风）
const color = (n) => { const m=moduleOf(n); let h=0; for(let i=0;i<m.length;i++) h=(h*31+m.charCodeAt(i))>>>0;
  const hue=h%360, sat=45+h%25, lum=60+(h>>3)%12; return 'hsl('+hue+','+sat+'%,'+lum+'%)'; };
const depthOf = (node) => { let d=0,f=(x,dep)=>{ d=Math.max(d,dep); x.c.forEach(ch=>f(ch,dep+1)); }; f(node,0); return d; };
const ancestors = (node) => { // 从 root 到 focus 的链（缩放时铺在底部）
  const path=[]; (function find(n){ if(n===node){return true;} for(const ch of n.c){ path.push(ch); if(find(ch))return true; path.pop(); } return false; })(DATA);
  return [DATA, ...path.slice(0,-1)]; };
const render = () => {
  svg.innerHTML='';
  const anc = focus===DATA ? [] : ancestors(focus);
  const maxd = depthOf(focus);
  const rows = maxd + 1 + anc.length;
  const H = rows*ROW;
  svg.setAttribute('width', W); svg.setAttribute('height', H); svg.setAttribute('viewBox','0 0 '+W+' '+H);
  // 祖先条（全宽，垫在最底下，点它可回退到该层）
  anc.forEach((n,i)=>{ drawRect(n, 0, W, H-ROW*(i+1), true); });
  const baseY = H - ROW*(anc.length+1);
  layout(focus, 0, W, 0, baseY);
  updateMatched();
};
const layout = (node, x, w, depth, baseY) => {
  drawRect(node, x, w, baseY - depth*ROW, false);
  let cx = x;
  const scale = w / (node.v||1);
  for(const ch of node.c){ const cw = ch.v*scale; if(cw>=0.2) layout(ch, cx, cw, depth+1, baseY); cx += cw; }
};
const drawRect = (node, x, w, y, isAnc) => {
  if(w < MINW) return;
  const g=document.createElementNS('http://www.w3.org/2000/svg','g'); g.setAttribute('class','frame');
  const r=document.createElementNS('http://www.w3.org/2000/svg','rect');
  r.setAttribute('x',x.toFixed(2)); r.setAttribute('y',y); r.setAttribute('width',Math.max(w-0.5,0.2).toFixed(2)); r.setAttribute('height',ROW-1);
  r.setAttribute('fill', isAnc ? '#eee' : color(node.n));
  g.appendChild(r);
  if(w>40){ const t=document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x',(x+2).toFixed(2)); t.setAttribute('y',y+ROW-6);
    const label=node.n; const max=Math.floor((w-4)/6.2);
    t.textContent = label.length>max ? label.slice(0,max-1)+'…' : label; g.appendChild(t); }
  if(searchRe && searchRe.test(node.n)) g.classList.add('search-hit');
  g.onclick=()=>{ focus=node; render(); };
  g.onmousemove=(e)=>{ tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px';
    tip.textContent = node.n+'  ·  '+node.v+' 采样  ·  '+(100*node.v/total).toFixed(2)+'% 全体'+(focus!==DATA?'  ·  '+(100*node.v/(focus.v||1)).toFixed(2)+'% 当前视图':''); };
  g.onmouseleave=()=>{ tip.style.display='none'; };
  svg.appendChild(g);
};
const updateMatched = () => {
  const el=document.getElementById('matched'); if(!searchRe){ el.textContent=''; return; }
  let hit=0; (function walk(n){ if(searchRe.test(n.n)){ hit+=n.v; return; } n.c.forEach(walk); })(DATA);
  el.textContent='匹配 '+(100*hit/total).toFixed(2)+'% 采样'; };
document.getElementById('reset').onclick=()=>{ focus=DATA; render(); };
document.getElementById('search').oninput=(e)=>{ const v=e.target.value.trim();
  try{ searchRe = v? new RegExp(v,'i') : null; }catch{ searchRe = v? {test:(s)=>s.toLowerCase().includes(v.toLowerCase())} : null; } render(); };
window.onresize=()=>{ W=Math.max(720,document.documentElement.clientWidth-4); render(); };
render();
</script>
</body></html>
`
}
