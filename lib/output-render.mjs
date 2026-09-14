/**
 * **渲染层的契约校验**：拿工具自己声明的 `output.schema`，合成一个"合法返回值"，
 * 看它的 `output.render` 吃不吃得下去。
 *
 * 为什么需要它（2026-09-14 真机，F-056 同族）：
 *   修好 `api_capture_query` 的 `output.schema`（F-055）、重启宿主之后，换成了**新的**错：
 *       Error: tool "api_capture_query" returned invalid output:
 *         output.render failed: renderQuery is not defined
 *   0fad407 把内联 render 换成 `render: (args, value) => renderQuery(args, value)`，
 *   **而 `renderQuery` 从没被写出来**（注释还写着"渲染逻辑在可测的 lib/query-view.mjs 里"）。
 *   ⇒ 整支工具在真机上不可用，而所有闸都是绿的：
 *     · parity 比工具名/参数；1a–1d 比输入参数集；plugin-load-smoke 只证明能加载；
 *     · **1e 虽然真的执行了 `execute`、还验了返回值合不合 schema，但从没调过 `output.render`**。
 *   而 render 是宿主**把结果交给 agent 时**才调的 —— 它不在 `execute` 的调用链上，
 *   于是"渲染层是死的"能一路绿灯到今天。
 *
 * 口径（与 1e 的分工）：
 *   · 能安全执行的**只读**工具：走"真 execute → 真返回值 → 真 render"（最强，见 `toolface-params` 1e）；
 *   · **所有**带 render 的工具（含副作用工具）：走"按自己的 schema 合成一个合法值 → 真 render"
 *     —— 不执行副作用，仍然能证明"渲染层写得出来、不抛、形状对"。
 *
 * 本文件的 `synthFromSchema` 只认本仓用到的那个 **schema 子集**：
 *   type / oneOf / properties / items / enum / const
 *   （注意：`required` 在本方言里是**逐属性注解**，不是 JSON-Schema 那个字符串数组
 *    ⇒ 声明过的属性**全部**合成，不用管 required）。
 */

/**
 * 按 schema 合成一个**合法**示例值。
 *
 * ⚠ 故意**不**"看情况给个像样的假数据"：只有跟着 schema 走，这条判据才在验
 *   "契约与实现是否一致"；自己脑补字段会把契约问题掩盖成通过。
 *   `array` 给**一个元素**（而不是空数组）：空数组会跳过"每条记录怎么渲染"的那段代码。
 */
export function synthFromSchema(schema, depth = 0) {
  if (depth > 6 || !schema || typeof schema !== 'object') return null
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0]
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return synthFromSchema(schema.oneOf[0], depth + 1)
  switch (schema.type) {
    case 'object': {
      const out = {}
      for (const [k, v] of Object.entries(schema.properties || {})) out[k] = synthFromSchema(v, depth + 1)
      return out
    }
    case 'array': return [synthFromSchema(schema.items, depth + 1)]
    case 'string': return 'x'
    case 'integer':
    case 'number': return 1
    case 'boolean': return false
    case 'null': return null
    default: return null
  }
}

/**
 * 检查 render 的返回值形状。**通过返回 null，不通过返回一句人话。**
 * 形状：`[{ type: 'text', text: <string> }, …]`（宿主渲染契约）。
 */
export function checkRenderShape(result) {
  if (!Array.isArray(result)) return '返回的不是数组（' + (result === null ? 'null' : typeof result) + '）'
  if (result.length === 0) return '返回了空数组（agent 会什么都看不到）'
  for (let i = 0; i < result.length; i++) {
    const c = result[i]
    if (!c || typeof c !== 'object') return '第 ' + i + ' 项不是对象'
    if (typeof c.text !== 'string') return '第 ' + i + ' 项缺少 text 字符串（type=' + String(c.type) + '）'
    // 空字符串同样是"agent 什么都看不到"，不许当通过
    if (c.text.trim() === '') return '第 ' + i + ' 项的 text 是空串（agent 会什么都看不到）'
  }
  return null
}

/**
 * 对一个工具跑一次"合成值 → render"。
 *
 * @returns {{status:'ok'|'no-render'|'throws'|'bad-shape', detail:string, text:string|null}}
 */
export function checkRender(tool) {
  const out = tool && tool.output
  if (!out || typeof out.render !== 'function') return { status: 'no-render', detail: '', text: null }
  const value = synthFromSchema(out.schema)
  let result
  try {
    result = out.render({}, value)
  } catch (e) {
    return { status: 'throws', detail: (e && e.message ? e.message : String(e)), text: null }
  }
  const bad = checkRenderShape(result)
  if (bad) return { status: 'bad-shape', detail: bad, text: null }
  return { status: 'ok', detail: '', text: result.map((c) => c.text).join('\n') }
}

/**
 * ★ 载荷探针（**真值**口径）：渲染层**不许把记录整个丢掉**。
 *
 * 为什么"形状对"还不够（2026-09-14 撞出来的）：
 *   我想读一条自己刚写进失败样本库的记录，DSH 面的 `failure_query` 只回了一行
 *     「失败样本库：返回 2 条（库内合计 39，已排除撤回 5 条）」
 *   —— **记录正文一个字都没有**（`execute` 明明返回了 `rows`）。这与 F-052
 *   （`memory_search` 只印"找到 N 条"）**是同一个病**，而 `checkRenderShape` **看不见它**：
 *   render 没抛、形状也对，只是把数据丢了。
 *   ⚠ 而且**按 schema 合成的探针也看不见**：`failure_query` 的 schema 是
 *     `{ type:'object', additionalProperties:true }` —— **一个属性都没声明**，
 *     合成值只能是 `{}` ⇒ 无东西可探。所以这一条必须走**真实的 execute 返回值**。
 *
 * 口径：
 *   · 只在"返回值里确实有**非空的对象数组**"时判定（否则 applicable:false = 不适用）；
 *   · 取每个数组里**最长的那个字符串字段**（≥12 字符 —— 太短的会碰巧命中别的文本）；
 *   · 一个数组的所有候选都没出现在渲染文本里 ⇒ 判定"这条记录被丢了"。
 *   · **测不了就说测不了**（applicable:false），而不是假装通过。
 *
 * @returns {{applicable:boolean, ok:boolean, detail:string}}
 */
export function probePayloadRendered(value, text) {
  const hay = typeof text === 'string' ? text : ''
  const arrays = []
  const walk = (v, path = 'v', depth = 0) => {
    if (depth > 3 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      if (v.length > 0 && v[0] && typeof v[0] === 'object') arrays.push({ path, first: v[0] })
      return
    }
    for (const [k, val] of Object.entries(v)) walk(val, path + '.' + k, depth + 1)
  }
  walk(value)
  if (arrays.length === 0) return { applicable: false, ok: true, detail: '返回值里没有非空的对象数组 ⇒ 本判据不适用' }

  const missing = []
  let probed = 0
  for (const { path, first } of arrays) {
    const candidates = []
    const collect = (o, d = 0) => {
      if (d > 3 || o === null || typeof o !== 'object') return
      for (const val of Object.values(o)) {
        if (typeof val === 'string' && val.length >= 12) candidates.push(val)
        else collect(val, d + 1)
      }
    }
    collect(first)
    if (candidates.length === 0) continue       // 这条数组里没有够长的字符串 ⇒ 跳过（不判）
    probed++
    candidates.sort((a, b) => b.length - a.length)
    if (!candidates.some((c) => hay.includes(c))) missing.push(path + '（示例：' + candidates[0].slice(0, 40) + '…）')
  }
  if (probed === 0) return { applicable: false, ok: true, detail: '数组元素里没有 ≥12 字符的字符串字段 ⇒ 本判据不适用' }
  if (missing.length === probed) {
    return { applicable: true, ok: false, detail: '记录数组的内容**一个字都没渲染出来**：' + missing.join('；') }
  }
  return { applicable: true, ok: true, detail: '' }
}
