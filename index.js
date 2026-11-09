/**
 * dsh-flowmeter —— 模型输出「流速」仪表（Host 半）。
 *
 * 在输入框下方的统计行里实时显示三样东西：实时输出速度（tok/s）、最近十秒左右的
 * 速度柱状图、以及首字延迟（TTFT）。本文件是数据源，渲染在 `client.js`。
 *
 * 数据从哪来
 * ----------
 * - `agent/assistant-stream`：真正的实时分片（`type: 'chunk'`），带高精度时间戳，
 *   每个 `text-delta` / `reasoning-delta` / `tool-call-delta` 都是一次 token 增量。
 *   这是唯一能算出「此刻多少 tok/s」的来源；落盘的 `assistant/message` 要等整步
 *   结束才有数，用它会一直停在 0。
 * - `session/event`：`step/start`（TTFT 的起点）、`assistant/message`（提供方上报的
 *   精确 outputTokens，用于收尾读数）、`turn/end`（相位归位）。
 *
 * 为什么用 HTTP 轮询
 * ------------------
 * Client 半是个普通 slot 组件，拿不到 Host 的进程内事件；本插件用 `ctx.webServer`
 * 注册两个只读的 exact 路由，页面同源轮询它们：
 * - `/dsh-flowmeter/state.json`：单个会话的读数（输入框下方那枚）。
 * - `/dsh-flowmeter/summary.json`：所有会话的合计/平均读数（侧栏底部那枚）。
 * 数据量小（< 2 KB/次），忙碌时 500ms 一次、空闲时 2.5s 一次。只读观测：不注册
 * 投影、不写会话日志、不改模型请求，卸载即净。
 */

/** Cordis 插件名，同时是 loader 条目 id。 */
export const name = 'dsh-flowmeter'

/** 需要能挂 HTTP 路由的 webServer。 */
export const inject = ['webServer']

/** 读数端点：页面同源轮询。 */
const ROUTE = '/dsh-flowmeter/state.json'
/** 全库读数端点：侧栏底部那枚「所有会话合计/平均」。 */
const SUMMARY_ROUTE = '/dsh-flowmeter/summary.json'

/** 实时速度的滑动窗口长度（毫秒）。太长则反应迟钝，太短则读数跳。 */
const WINDOW_MS = 1200
/** 窗口分母下限：窗口还没铺满时用它，避免一两个分片把读数顶到天上。 */
const MIN_SPAN_MS = 250
/** 柱状图每个桶的宽度（毫秒）。 */
const BUCKET_MS = 400
/** 柱状图保留的桶数：32 × 400ms ≈ 12.8 秒。 */
const BUCKET_COUNT = 32
/** 单会话保留的原始时间样本上限（同毫秒分片会合并）。 */
const MAX_SAMPLES = 2000
/** 超过该时长没有分片就当作空闲。 */
const IDLE_MS = 2500
/** 完全没有活动的会话从登记表里回收（毫秒）。 */
const TRACKER_TTL_MS = 60 * 60 * 1000
/** 登记表最多每分钟清扫一次，避免每个分片都遍历所有会话。 */
const SWEEP_MS = 60 * 1000
/**
 * 「解码时长」算速度的下限（毫秒）。
 *
 * 有些 provider 是收尾式串流：所有分片在响应结束时同一瞬间到达，
 * `首字 → assistant/message` 只有几毫秒，拿它当分母会得到爆表的速度。
 * 这种步退回「整步墙钟」计速，标记 `basis: 'wall'`，读数可测但不假装是解码速度。
 */
const MIN_DECODE_MS = 200

/** ASCII 字符每 token 字符数（英文粗略 4 字符 ≈ 1 token）。 */
const ASCII_PER_TOKEN = 4
/** 非 ASCII 字符（CJK 等）每字符 token 数。 */
const WIDE_PER_CHAR = 0.6

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/** sessionId → 有界追踪器。 */
const trackers = new Map()
let lastSweep = 0

/**
 * 估算一段流式文本的 token 数。
 * @param {string} text - 增量文本。
 * @returns {number} 估算 token 数（非负）。
 */
function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x80) ascii += 1
    else wide += 1
  }
  return ascii / ASCII_PER_TOKEN + wide * WIDE_PER_CHAR
}

/** 保留一位小数。 */
function round1(value) {
  return Math.round(value * 10) / 10
}

/** 某个时刻所属的柱状图桶起点。 */
function bucketStart(time) {
  return Math.floor(time / BUCKET_MS) * BUCKET_MS
}

/** 新建一个追踪器。 */
function createTracker(id, now) {
  return {
    id,
    /** 'waiting'（等首字）| 'streaming'（正在出字）| 'idle'（不在解码）。 */
    phase: 'idle',
    turn: null,
    step: null,
    /** 本步起点（毫秒）：TTFT 的分母。0 表示未知。 */
    stepStartMs: 0,
    /** 本步首个 token 的时间；0 表示还没到。 */
    firstTokenAt: 0,
    /** 本步首字延迟（毫秒），未知为 null。 */
    ttftMs: null,
    /** 本步估算 token 数（流式期间就要有数）。 */
    stepTokens: 0,
    /** 滑动窗口样本：[{ t, n }]，按时间升序。 */
    samples: [],
    /** 柱状图桶：[{ t, n }]，按时间升序，最多 BUCKET_COUNT 个。 */
    buckets: [],
    /** 上一步的收尾读数：{ tps, tokens, ttftMs, decodeMs, basis, at }。 */
    last: null,
    updatedAt: now,
  }
}

/** 取（或新建）某个会话的追踪器。 */
function trackerFor(id, now) {
  let tr = trackers.get(id)
  if (tr === undefined) {
    tr = createTracker(id, now)
    trackers.set(id, tr)
  }
  return tr
}

/** 把样本裁剪到窗口两倍长度以内，保证内存有界。 */
function pruneSamples(tr, now) {
  const keepFrom = now - WINDOW_MS * 2
  let cut = 0
  while (cut < tr.samples.length && tr.samples[cut].t < keepFrom) cut += 1
  if (cut > 0) tr.samples.splice(0, cut)
  if (tr.samples.length > MAX_SAMPLES) tr.samples.splice(0, tr.samples.length - MAX_SAMPLES)
}

/** 记一次 token 增量：入窗口、入桶、更新首字与本步计数。 */
function pushTokens(tr, tokens, now) {
  if (!Number.isFinite(tokens) || tokens <= 0) return
  const last = tr.samples[tr.samples.length - 1]
  if (last !== undefined && last.t === now) last.n += tokens
  else {
    tr.samples.push({ t: now, n: tokens })
    pruneSamples(tr, now)
  }

  const key = bucketStart(now)
  const tail = tr.buckets[tr.buckets.length - 1]
  if (tail !== undefined && tail.t === key) tail.n += tokens
  else {
    tr.buckets.push({ t: key, n: tokens })
    if (tr.buckets.length > BUCKET_COUNT) tr.buckets.splice(0, tr.buckets.length - BUCKET_COUNT)
  }

  if (tr.firstTokenAt === 0) {
    tr.firstTokenAt = now
    if (tr.stepStartMs > 0 && now >= tr.stepStartMs) tr.ttftMs = now - tr.stepStartMs
  }
  tr.stepTokens += tokens
  tr.phase = 'streaming'
  tr.updatedAt = now
}

/** 窗口内实时速度：用样本真实跨度当分母，窗口没铺满时也算得准。 */
function windowTps(tr, now) {
  const from = now - WINDOW_MS
  let sum = 0
  let oldest = null
  let newest = 0
  for (const sample of tr.samples) {
    if (sample.t < from) continue
    sum += sample.n
    if (oldest === null) oldest = sample.t
    newest = sample.t
  }
  if (sum <= 0 || oldest === null) return 0
  const span = Math.max(Math.max(newest, now) - oldest, MIN_SPAN_MS)
  return sum / (span / 1000)
}

/**
 * 本步均速：累计 token ÷ 首字到现在的时长，即「解码速度」，不含首字等待。
 *
 * 口径与 dsh-tps-ttft 的 `decodeTokens / (decodeMs / 1000)` 一致：分母从首字起算，
 * 分子用本步累计 token。生成期间用估算值先算，`assistant/message` 落到精确用量后
 * 换成精确值；一步结束后改由 `last.tps`（精确 outputTokens ÷ 精确 decodeMs）接管。
 *
 * 只要有过一步，这里就一定有数：等首字和空闲时沿用最近一步的均速，让读数一直挂在那里，
 * 而不是生成结束就消失。
 *
 * @param {object} tr - 追踪器。
 * @param {'waiting'|'streaming'|'idle'} phase - 当前相位。
 * @param {number} now - 当前时间戳。
 * @returns {number|null} tok/s；一步都没跑过时为 null。
 */
function avgTpsOf(tr, phase, now) {
  if (phase === 'streaming' && tr.firstTokenAt > 0 && tr.stepTokens > 0) {
    const span = Math.max(now - tr.firstTokenAt, MIN_SPAN_MS)
    return round1(tr.stepTokens / (span / 1000))
  }
  return tr.last !== null ? tr.last.tps : null
}

/**
 * 柱状图数组：从旧到新，缺桶补 0，单位 tok/s。
 *
 * 最新那个桶按「已经过掉的时长」折算，而不是整桶时长：否则右边的柱子永远只有
 * 真实的四成，看起来像速度突然掉下去。
 */
function barsOf(tr, now) {
  const newest = bucketStart(now)
  const out = new Array(BUCKET_COUNT).fill(0)
  for (const bucket of tr.buckets) {
    const index = BUCKET_COUNT - 1 - Math.round((newest - bucket.t) / BUCKET_MS)
    if (index < 0 || index >= BUCKET_COUNT) continue
    const span = Math.min(BUCKET_MS, Math.max(BUCKET_MS / 2, now - bucket.t))
    out[index] = round1(bucket.n / (span / 1000))
  }
  return out
}

/** 开始一个新步：重置首字与本步计数，保留柱状图历史。 */
function beginStep(tr, turn, step, startMs) {
  tr.turn = turn
  tr.step = step
  tr.stepStartMs = startMs
  tr.firstTokenAt = 0
  tr.ttftMs = null
  tr.stepTokens = 0
  tr.samples = []
  tr.phase = 'waiting'
}

/** 收一个串流帧。 */
function onFrame(tr, frame, now) {
  if (frame === null || typeof frame !== 'object') return
  if (frame.type === 'start') {
    const same = tr.turn === frame.turn && tr.step === frame.step
    if (!same) beginStep(tr, frame.turn, frame.step, tr.stepStartMs > 0 ? tr.stepStartMs : now)
    else {
      tr.phase = 'waiting'
      if (tr.stepStartMs === 0) tr.stepStartMs = now
    }
    tr.updatedAt = now
    return
  }
  if (frame.type !== 'chunk') return
  const chunk = frame.chunk
  if (chunk === null || typeof chunk !== 'object') return
  const time = typeof frame.time === 'number' && frame.time > 0 ? frame.time : now
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      pushTokens(tr, estimateTokens(chunk.text), time)
      return
    case 'tool-call-delta':
      pushTokens(
        tr,
        estimateTokens(chunk.argumentsDelta) + (chunk.name === undefined ? 0 : 1),
        time,
      )
      return
    default:
      return
  }
}

/** 收一条落盘会话事件。 */
function onSessionEvent(tr, event, now) {
  if (event === null || typeof event !== 'object') return
  const data = event.data ?? {}
  const stamp = typeof event.time === 'number' && event.time > 0 ? event.time : now
  switch (event.type) {
    case 'step/start': {
      const turn = typeof data.turn === 'number' ? data.turn : tr.turn
      const step = typeof data.step === 'number' ? data.step : tr.step
      // 串流 start 帧可能已经先到；此时它给的本步起点更接近请求发出的时刻。
      const started = tr.phase === 'waiting' && tr.step === step && tr.stepStartMs > 0
        ? Math.min(tr.stepStartMs, stamp)
        : stamp
      beginStep(tr, turn, step, started)
      tr.updatedAt = now
      return
    }
    case 'assistant/message': {
      const usage = data.usage
      const outputTokens = usage !== null && typeof usage === 'object' ? usage.outputTokens : undefined
      if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0) {
        // 提供方已上报精确用量：用精确值替换本步的估算值，均速随之收敛。
        tr.stepTokens = outputTokens
        const first = tr.firstTokenAt
        const decodeMs = first > 0 ? Math.max(0, stamp - first) : 0
        if (decodeMs > MIN_DECODE_MS) {
          tr.last = {
            tps: round1(outputTokens / (decodeMs / 1000)),
            tokens: outputTokens,
            ttftMs: tr.ttftMs,
            decodeMs,
            basis: 'decode',
            at: stamp,
          }
        } else if (tr.stepStartMs > 0 && stamp - tr.stepStartMs > MIN_DECODE_MS) {
          const wallMs = stamp - tr.stepStartMs
          tr.last = {
            tps: round1(outputTokens / (wallMs / 1000)),
            tokens: outputTokens,
            ttftMs: tr.ttftMs,
            decodeMs: wallMs,
            basis: 'wall',
            at: stamp,
          }
        }
      }
      tr.updatedAt = now
      return
    }
    case 'tool/call': {
      // 模型这一拍不再出字：读数自然地随窗口衰减，而不是继续显示上一段的速度。
      tr.phase = 'idle'
      tr.updatedAt = now
      return
    }
    case 'turn/end': {
      tr.phase = 'idle'
      tr.updatedAt = now
      return
    }
    default:
      return
  }
}

/** 清扫长期没有活动的会话。 */
function sweep(now) {
  if (now - lastSweep < SWEEP_MS) return
  lastSweep = now
  for (const [id, tr] of trackers) {
    if (now - tr.updatedAt > TRACKER_TTL_MS) trackers.delete(id)
  }
}

/** 没有指定会话时，取最近有活动的那个。 */
function freshest() {
  let best = null
  for (const tr of trackers.values()) {
    if (best === null || tr.updatedAt > best.updatedAt) best = tr
  }
  return best === null ? undefined : best
}

/**
 * 按 id 找追踪器。
 *
 * 正常情况是精确命中；两种 id 表示（带不带 `session-` 前缀）混用时按 UUID 后缀兜底，
 * 免得读数因为一个前缀悄悄不显示。
 */
function findTracker(sessionId) {
  const exact = trackers.get(sessionId)
  if (exact !== undefined) return exact
  for (const [id, tr] of trackers) {
    if (id.endsWith(sessionId) || sessionId.endsWith(id)) return tr
  }
  return undefined
}

/** 组装一个会话的读数。 */
function stateOf(sessionId, now) {
  const tr = sessionId !== null && sessionId !== '' ? findTracker(sessionId) : freshest()
  const empty = {
    ok: true,
    now,
    session: null,
    phase: 'idle',
    tps: 0,
    avgTps: null,
    bars: new Array(BUCKET_COUNT).fill(0),
    ttftMs: null,
    waitingMs: null,
    step: null,
    last: null,
  }
  if (tr === undefined) return empty

  const stale = now - tr.updatedAt > IDLE_MS
  const phase = stale ? 'idle' : tr.phase
  const busy = phase === 'waiting' || phase === 'streaming'
  return {
    ok: true,
    now,
    session: tr.id,
    phase,
    tps: busy ? round1(windowTps(tr, now)) : 0,
    avgTps: avgTpsOf(tr, phase, now),
    bars: barsOf(tr, now),
    ttftMs: busy ? tr.ttftMs : null,
    waitingMs: phase === 'waiting' && tr.stepStartMs > 0 ? Math.max(0, now - tr.stepStartMs) : null,
    step: busy
      ? { turn: tr.turn, step: tr.step, tokens: Math.round(tr.stepTokens) }
      : null,
    last: tr.last,
  }
}

/**
 * 全库读数：把当前所有会话的流速合成一个「合计」与一个「平均」。
 *
 * - **累加**：所有正在等首字/出字的会话的实时速度之和，等于这台机器此刻的总吞吐。
 * - **平均**：合计 ÷ 正在出字的会话数，等于「平均每个会话跑多快」。等首字、还没吐字的
 *   会话不进分母 —— 否则刚开始的一步会把平均值无故拉低。
 *
 * 图表也分两套：每个桶先按会话把 token 相加得到合计 tps；平均则再除以**该桶里真有
 * token 的会话数**，这样某个会话停下来时，平均值不会因为分母变小而突然跳高。
 *
 * 只在最近几个桶里扫一遍追踪器：更早的桶已经落在图表窗口外，算了也没人看。
 *
 * @param {number} now - 当前时间戳。
 * @returns {object} 侧栏控件需要的合计读数。
 */
function aggregateOf(now) {
  const active = []
  for (const tr of trackers.values()) {
    if (now - tr.updatedAt > IDLE_MS) continue
    if (tr.phase !== 'waiting' && tr.phase !== 'streaming') continue
    active.push(windowTps(tr, now))
  }
  let sum = 0
  let streaming = 0
  for (const tps of active) {
    sum += tps
    if (tps > 0) streaming += 1
  }

  const newest = bucketStart(now)
  const historyFrom = newest - (BUCKET_COUNT - 1) * BUCKET_MS
  const sums = new Array(BUCKET_COUNT).fill(0)
  const counts = new Array(BUCKET_COUNT).fill(0)
  for (const tr of trackers.values()) {
    if (tr.updatedAt < historyFrom) continue
    for (const bucket of tr.buckets) {
      const index = BUCKET_COUNT - 1 - Math.round((newest - bucket.t) / BUCKET_MS)
      if (index < 0 || index >= BUCKET_COUNT) continue
      sums[index] += bucket.n
      if (bucket.n > 0) counts[index] += 1
    }
  }

  const barsSum = new Array(BUCKET_COUNT)
  const barsAvg = new Array(BUCKET_COUNT)
  for (let index = 0; index < BUCKET_COUNT; index += 1) {
    const startedAt = newest - (BUCKET_COUNT - 1 - index) * BUCKET_MS
    // 与 barsOf 同一口径：最新那个桶按已经过掉的时长折算，不按整桶。
    const span = Math.min(BUCKET_MS, Math.max(BUCKET_MS / 2, now - startedAt))
    const bucketTps = sums[index] / (span / 1000)
    barsSum[index] = round1(bucketTps)
    barsAvg[index] = round1(bucketTps / Math.max(1, counts[index]))
  }

  return {
    ok: true,
    now,
    /** 正在等首字或出字的会话数。 */
    active: active.length,
    /** 其中窗口里真有 token 的会话数（平均值的分母）。 */
    streaming,
    /** 侧栏据此决定轮询快慢。 */
    busy: active.length > 0,
    sumTps: round1(sum),
    avgTps: streaming > 0 ? round1(sum / streaming) : 0,
    barsSum,
    barsAvg,
  }
}

/**
 * 挂载插件：接串流与落盘事件 → 每会话有界读数 → 只读 HTTP 端点。
 * @param {object} ctx - 宿主 cordis 上下文。
 */
export function apply(ctx) {
  /** 观察者绝不能把失败带进会话提交路径（firehose 是 fire-and-forget）。 */
  const warn = (what, err) => {
    try {
      ctx.logger?.warn?.(`${name}: ${what}: %s`, String((err && err.message) || err))
    } catch (ignored) {}
  }

  ctx.on(
    'agent/assistant-stream',
    (payload) => {
      try {
        const now = Date.now()
        sweep(now)
        const frame = payload?.frame
        if (frame === null || typeof frame !== 'object') return
        const id = payload?.agent?.id ?? payload?.agent?.session?.id
        if (typeof id !== 'string' || id.length === 0) return
        onFrame(trackerFor(id, now), frame, now)
      } catch (err) {
        warn('assistant-stream 处理失败', err)
      }
    },
    { global: true },
  )

  ctx.on('session/event', (session, event) => {
    try {
      const id = session?.id
      if (typeof id !== 'string' || id.length === 0) return
      const now = Date.now()
      sweep(now)
      onSessionEvent(trackerFor(id, now), event, now)
    } catch (err) {
      warn('session/event 处理失败', err)
    }
  })

  // 两个只读端点：输入框脚下那枚看单会话，侧栏底部那枚看全库。
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => {
          const now = Date.now()
          let body
          try {
            const query = new URL(req.url ?? '/', 'http://localhost').searchParams.get('session')
            body = stateOf(query, now)
          } catch (err) {
            body = { ok: false, now, error: 'unreadable request' }
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(body))
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: SUMMARY_ROUTE,
        handler: (req, res) => {
          let body
          try {
            body = aggregateOf(Date.now())
          } catch (err) {
            body = { ok: false, now: Date.now(), error: 'unreadable request' }
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(body))
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose !== 'function') continue
        try {
          dispose()
        } catch (err) {}
      }
    }
  })
}
