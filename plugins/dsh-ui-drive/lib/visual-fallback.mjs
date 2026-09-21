function captureIssue(frame) {
  if (!frame || frame.ok !== true || frame.state !== 'visible' || !frame.path) return 'capture-unavailable'
  if (frame.captureMethod !== 'print' || frame.coordinateSpace !== 'window' || frame.physicalPixels !== true) return 'capture-coordinate-space'
  if (!Number.isSafeInteger(frame.windowHandle) || frame.windowHandle <= 0 || typeof frame.frameHash !== 'string' || !frame.frameHash) return 'capture-identity-unknown'
  if (!Number.isSafeInteger(frame.w) || !Number.isSafeInteger(frame.h) || frame.w <= 0 || frame.h <= 0) return 'capture-size-invalid'
  if (!frame.rect || !['x', 'y', 'w', 'h'].every(key => Number.isSafeInteger(frame.rect[key]))) return 'capture-rect-invalid'
  if (frame.rect.w !== frame.w || frame.rect.h !== frame.h) return 'capture-dpi-mismatch'
  return null
}

function sensitivityIssue(state) {
  if (state?.secret === true || state?.secretFocused === true) return 'secret-focused'
  if (!state || state.ok !== true || state.unknown === true || state.secretFocused !== false) return 'sensitivity-unknown'
  if (state.desktopState && state.desktopState !== 'unlocked') return 'desktop-unavailable'
  return null
}

export async function executeVisualFallback({ action, result, args = {}, drive, vision }) {
  if (args.visualFallback !== true || !['click', 'doubleclick'].includes(action) || !result || result.ok !== false || result.notFound !== true) return result
  if (result.unknown || result.timeout || result.policyCode || result.staleSnapshot || result.expiredSnapshot || result.unknownSnapshot) return result
  const blocked = (reason, attempted = false) => ({ ...result, action, visualFallback: { attempted, blocked: true, reason } })
  if (args.allowSideEffects !== true) return blocked('side-effects-not-authorized')
  if (args.secret === true) return blocked('secret-input')
  if (args.index !== undefined || ['inAid', 'inName', 'match'].some(key => args[key] != null && args[key] !== '')) return blocked('scoped-target-unsupported')
  const target = args.visualTarget || args.name || args.aid
  if (typeof target !== 'string' || !target.trim()) return blocked('target-description-missing')
  const minConfidence = args.visualMinConfidence ?? 0.78
  if (!Number.isFinite(minConfidence) || minConfidence < 0.5 || minConfidence > 1) return blocked('confidence-threshold-invalid')
  const context = { procId: args.procId, winTitle: args.winTitle, winHandle: args.winHandle, visualFallback: false }
  let attempted = false
  let clicked = false
  try {
    const initialState = await drive({ ...context, action: 'state-live' })
    const initialSensitivity = sensitivityIssue(initialState)
    if (initialSensitivity) return blocked(initialSensitivity)
    const frame = await drive({ ...context, action: 'capture' })
    const initialCapture = captureIssue(frame)
    if (initialCapture) return blocked(initialCapture)
    if (args.winHandle != null && Number(args.winHandle) !== frame.windowHandle) return blocked('target-window-mismatch')
    if (args.procId && frame.pid !== args.procId) return blocked('target-process-mismatch')
    const boundContext = { ...context, winHandle: frame.windowHandle }
    const beforeUpload = sensitivityIssue(await drive({ ...boundContext, action: 'state-live' }))
    if (beforeUpload) return blocked(beforeUpload)
    attempted = true
    const located = await vision.locateImage(frame.path, target.trim(), minConfidence)
    if (!located || located.ok !== true) return blocked('vision-location-failed', attempted)
    if (!Number.isSafeInteger(located.x) || !Number.isSafeInteger(located.y) || located.x < 0 || located.y < 0 || located.x >= frame.w || located.y >= frame.h) return blocked('vision-coordinate-out-of-bounds', attempted)
    if (!Number.isFinite(located.confidence) || located.confidence < minConfidence || located.confidence > 1) return blocked('vision-confidence-insufficient', attempted)
    const currentState = sensitivityIssue(await drive({ ...boundContext, action: 'state-live' }))
    if (currentState) return blocked(currentState, attempted)
    const currentFrame = await drive({ ...boundContext, action: 'capture' })
    const currentCapture = captureIssue(currentFrame)
    if (currentCapture) return blocked(currentCapture, attempted)
    if (frame.windowHandle !== currentFrame.windowHandle || frame.frameHash !== currentFrame.frameHash || frame.pid !== currentFrame.pid || ['x', 'y', 'w', 'h'].some(key => frame.rect[key] !== currentFrame.rect[key])) return blocked('frame-changed', attempted)
    clicked = true
    const response = await drive({ ...args, action: 'clickat', x: located.x, y: located.y, double: action === 'doubleclick', winHandle: frame.windowHandle, expectedWindowHandle: frame.windowHandle, expectedRect: { ...frame.rect }, visualFallback: false })
    if (!response || typeof response.ok !== 'boolean') return { ok: false, action, unknown: true, error: '视觉兜底点击结果未知，未重试', fallbackFrom: result.error || 'uia-not-found', visualFallback: { attempted: true, reason: 'click-result-unknown' } }
    return { ...response, action, fallbackFrom: result.error || 'uia-not-found', visualFallback: { attempted: true, source: 'vision-coordinate', target: target.trim(), x: located.x, y: located.y, confidence: located.confidence, frameHash: frame.frameHash, windowHandle: frame.windowHandle } }
  } catch {
    if (clicked) return { ok: false, action, unknown: true, error: '视觉兜底点击结果未知，未重试', fallbackFrom: result.error || 'uia-not-found', visualFallback: { attempted: true, reason: 'click-result-unknown' } }
    return blocked('visual-fallback-unavailable', attempted)
  }
}
