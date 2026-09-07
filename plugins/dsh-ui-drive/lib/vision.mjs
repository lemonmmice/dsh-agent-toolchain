/**
 * dsh-ui-drive vision — 界面截图视觉描述（视觉即返）。
 * 复用 ~/.dsh/settings.yaml 的 describe-image 配置（小米 mimo-v2.5 等视觉模型），
 * 把「截图 → 视觉模型描述界面」直接做进插件：
 * ui_launch 完成后一步返回界面状态，agent 不用再 shot + describe_image 两轮调用。
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readSettings() {
  try {
    const f = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'settings.yaml')
    if (!existsSync(f)) return {}
    const text = readFileSync(f, 'utf8')
    const out = {}
    let section = null
    for (const line of text.split(/\r?\n/)) {
      const sec = line.match(/^([A-Za-z0-9_-]+):\s*$/)
      if (sec) { section = sec[1]; continue }
      const kv = line.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.+?)\s*$/)
      if (kv && section) {
        if (!out[section]) out[section] = {}
        out[section][kv[1]] = kv[2]
      }
    }
    return out
  } catch {
    return {}
  }
}

function readCreds() {
  try {
    const f = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.credentials.yaml')
    if (!existsSync(f)) return {}
    const out = {}
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+):\s*(.+?)\s*$/)
      if (m) out[m[1]] = m[2].trim()
    }
    return out
  } catch {
    return {}
  }
}

/** UI 状态识别提示词（短、结构化）。 */
export const UI_STATE_PROMPT =
  '这是一张目标桌面客户端当前界面的截图。请判断并回答：1) 当前处于哪个页面或弹窗（登录页/主界面/股票量化页/ETF量化页/对话框等，一句话）；2) 主要可见元素（按钮/菜单/输入框/列表名称，3~8 个）。用中文简洁回答，不要多余解释。'

export function makeVision(cfg) {
  const c = {
    timeoutMs: 90000,
    maxOutputTokens: 512,
    ...cfg,
  }

  function resolveConfig() {
    const settings = readSettings()
    const sec = settings['describe-image'] || {}
    const creds = readCreds()
    const apiKeyEnv = sec.apiKeyEnv || 'XIAOMI_API_KEY'
    const apiKey = process.env[apiKeyEnv] || creds[apiKeyEnv] || null
    return {
      baseURL: (sec.baseURL || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, ''),
      model: sec.model || 'mimo-v2.5',
      apiKey,
    }
  }

  /** 描述一张本地 PNG。返回 {ok, text, model, error}。 */
  async function describeImage(pngPath, prompt = UI_STATE_PROMPT) {
    if (!pngPath || !existsSync(pngPath)) return { ok: false, error: '截图不存在：' + pngPath }
    const { baseURL, model, apiKey } = resolveConfig()
    if (!apiKey) return { ok: false, error: '视觉模型 API key 未配置（describe-image.apiKeyEnv）' }
    const mime = pngPath.toLowerCase().endsWith('.jpg') || pngPath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
    const dataUri = 'data:' + mime + ';base64,' + readFileSync(pngPath).toString('base64')
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), c.timeoutMs)
      const resp = await fetch(baseURL + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model,
          max_tokens: c.maxOutputTokens,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          }],
        }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!resp.ok) {
        const body = await resp.text().catch(() => '')
        return { ok: false, error: 'vision HTTP ' + resp.status + ': ' + body.slice(0, 200) }
      }
      const data = await resp.json()
      const text = data?.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'vision 返回空内容' }
      return { ok: true, text: text.trim(), model }
    } catch (e) {
      return { ok: false, error: 'vision 请求失败: ' + (e?.name === 'AbortError' ? '超时' : String(e)) }
    }
  }

  return { describeImage, resolveConfig }
}
