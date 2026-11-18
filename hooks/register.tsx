import type { Register } from 'claude-code'

// What the desktop app's usage card reports: plan limits and, on Enterprise, the monthly extra-usage budget
type Plan = {
  status?: string
  plan?: string
  windows?: { name?: string; kind?: string; label?: string; percentUsed?: number; resetsAt?: string }[]
  extraUsage?: { enabled?: boolean; percentUsed?: number; spent?: string; monthlyLimit?: string; currency?: string }
}

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const THRESHOLDS = [50, 75, 90]

// Spend samples for this billing cycle, kept in $.store so the forecast can use the recent rate and not only the month's average
type History = { cycleStart: number; samples: [number, number][] }
// The highest threshold already toasted this cycle, shared by every session so each crossing toasts once
type Toasted = { cycleStart: number; threshold: number }
type Forecast = { rate: number; basis: string; runsOutAt: number | null; isEarly: boolean }
type Tone = 'calm' | 'warn' | 'alert'

// What the band above the prompt draws: set by refresh, drawn by the ui.render hook
type Band = {
  // This session's cost, "$1.15"
  session: string
  // The month's extra usage, when the plan has it
  // name is the current month's, "November", drawn as the bar's label
  month?: { name: string; percent: number; text: string }
  // "5h 12% · 7d 40%", when the plan reports rate-limit windows
  windows: string
  // "$13/day", or "$42/day · runs out Oct 18" when the budget will run out before the month ends
  forecast: string
  tone: Tone
}
let band: Band | null = null

const money = (v: string | number | undefined, cur = 'USD', digits = 2) =>
  v === undefined ? '?' : (cur === 'USD' ? '$' : cur + ' ') + Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const winName = (w: { name?: string; kind?: string; label?: string }) => w.label ?? w.name ?? ({ five_hour: '5h', seven_day: '7d', spend_limit: 'spend' } as Record<string, string>)[w.kind ?? ''] ?? w.kind ?? 'limit'

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const startOfMonth = (ms: number) => { const d = new Date(ms); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime() }

// Record this reading. The cycle starts on the 1st until the spend drops, which means the budget reset: then it starts then.
// At most one sample an hour is kept (the newest reading in the hour replaces the one before), so the history spans
// the whole cycle however often the figures refresh, and the 7-day baseline is always there.
async function track($: any, spent: number): Promise<History> {
  const now = await $.clock.now()
  let h = ((await $.store.get('history')) as History | undefined) ?? { cycleStart: startOfMonth(now), samples: [] }
  const last = h.samples[h.samples.length - 1]
  if (last && spent < last[1] - 0.5) h = { cycleStart: now, samples: [] }
  const before = h.samples[h.samples.length - 2]
  if (before && now - before[0] < HOUR) h.samples[h.samples.length - 1] = [now, spent]
  else h.samples.push([now, spent])
  h.samples = h.samples.slice(-1000)
  await $.store.set('history', h)
  return h
}

// When will the month's budget run out at the current pace? The rate is the last 7 days when the history has a day's baseline, else the month so far.
function forecast(spent: number, limit: number, now: number, h: History): Forecast | null {
  const elapsed = (now - h.cycleStart) / DAY
  if (elapsed < 0.25 || limit <= 0) return null
  const monthRate = spent / elapsed
  const base = h.samples.find(s => now - s[0] <= 7 * DAY && now - s[0] >= DAY)
  const recentRate = base ? Math.max(0, (spent - base[1]) / ((now - base[0]) / DAY)) : null
  const rate = recentRate ?? monthRate
  const end = new Date(h.cycleStart); end.setMonth(end.getMonth() + 1)
  const cycleEnd = end.getTime()
  const runsOutAt = rate > 0 ? now + ((limit - spent) / rate) * DAY : null
  return { rate, basis: recentRate !== null ? 'last 7 days' : 'month so far', runsOutAt, isEarly: runsOutAt !== null && runsOutAt < cycleEnd }
}

// The band's version, drawn at the right edge. Running out early: "$42/day · runs out Oct 18".
// On track: just the daily rate, "$13/day".
function forecastShort(f: Forecast, cur: string) {
  const perDay = f.rate >= 10 ? money(Math.round(f.rate), cur, 0) : money(f.rate, cur)
  if (f.isEarly) return `${perDay}/day · runs out ${fmtDate(f.runsOutAt!)}`
  return `${perDay}/day`
}

// The desktop app's own usage tool, called through the engine's MCP connection. Null when the app does not offer it here.
async function appPlan($: any): Promise<Plan | null> {
  try {
    const r = await $.mcp.call('ccd_session_mgmt', 'get_usage', {})
    if (r.isError) return null
    const text = r.content?.find((c: any) => c.type === 'text')?.text
    return text ? (JSON.parse(text).plan as Plan) : null
  } catch {
    return null
  }
}

// What the session itself knows: the rate-limit windows the last response reported, and this session's cost
async function sessionPlan($: any): Promise<{ plan: Plan; cost?: number }> {
  const u = await $.session.usage()
  return { plan: { windows: u.rateLimits.map((w: any) => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })) }, cost: u.cost?.usd }
}

// Toast once per cycle for each threshold the month's usage crosses, whichever session sees it first
async function maybeToast($: any, x: NonNullable<Plan['extraUsage']>, cycleStart: number) {
  const pct = x.percentUsed!
  const crossed = THRESHOLDS.filter(t => pct >= t).pop()
  if (crossed === undefined) return
  const t = (await $.store.get('toasted')) as Toasted | undefined
  const already = t && t.cycleStart === cycleStart ? t.threshold : 0
  if (crossed <= already) return
  await $.store.set('toasted', { cycleStart, threshold: crossed } satisfies Toasted)
  $.ui.toast(`Extra usage is at ${pct}% of this month's ${money(x.monthlyLimit, x.currency)}`, { timeoutMs: 8000 })
}

// Resolves whether the app's usage tool answered
async function refresh($: any): Promise<boolean> {
  const app = await appPlan($)
  const s = await sessionPlan($)
  const plan = app ?? s.plan
  const x = plan.extraUsage
  const next: Band = {
    session: s.cost !== undefined ? `$${s.cost.toFixed(2)}` : '',
    windows: (plan.windows ?? []).filter(w => w.percentUsed !== undefined).map(w => `${winName(w)} ${w.percentUsed}%`).join(' · '),
    forecast: '',
    tone: 'calm',
  }
  if (x?.enabled && x.percentUsed !== undefined) next.month = { name: new Date(await $.clock.now()).toLocaleDateString('en-US', { month: 'long' }), percent: x.percentUsed, text: `${money(x.spent, x.currency)} / ${money(x.monthlyLimit, x.currency)} (${x.percentUsed}%)` }
  // The forecast and the toasts need the month's spend and limit; they are quiet when they cannot be made
  if (x?.enabled && x.spent !== undefined && x.monthlyLimit !== undefined) {
    try {
      const spent = Number(x.spent)
      const limit = Number(x.monthlyLimit)
      const now = await $.clock.now()
      const h = await track($, spent)
      const f = forecast(spent, limit, now, h)
      if (spent >= limit) {
        next.forecast = 'limit reached'
        next.tone = 'alert'
      } else if (f) {
        next.forecast = forecastShort(f, x.currency ?? 'USD')
        const daysLeft = f.runsOutAt === null ? Infinity : (f.runsOutAt - now) / DAY
        next.tone = f.isEarly ? (daysLeft <= 7 ? 'alert' : 'warn') : 'calm'
      }
      if (x.percentUsed !== undefined) await maybeToast($, x, h.cycleStart)
    } catch {
      // No history this time (the store failed): the figures still show
    }
  }
  band = next.session || next.month || next.windows ? next : null
  $.ui.invalidate('ui.render')
  return app !== null
}

// The text meter, for the terminal
const meter = (pct: number, width = 10) => {
  const filled = Math.round((width * Math.max(0, Math.min(pct, 100))) / 100)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const toneColor = (tone: Tone) => (tone === 'alert' ? 'red' : tone === 'warn' ? 'yellow' : undefined)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // An earlier version pinned a status line, which stays until replaced: clear it. The band is the one place the figures show.
    $.ui.status(undefined)
    const hasApp = await refresh($).catch(() => false)
    // At startup the app's usage tool may not have connected yet: try again every 10 seconds for a minute, so the month shows without waiting for a turn
    if (!hasApp) {
      let tries = 0
      const retry = $.clock.every(10 * 1000, async () => {
        tries++
        const ok = await refresh($).catch(() => false)
        if (ok || tries >= 6) retry.cancel()
      })
    }
    // The month moves slowly: every five minutes is plenty
    $.clock.every(5 * 60 * 1000, () => refresh($).catch(() => {}))
    return next(e)
  })

  // After each turn the figures may have moved
  on('session.measure', async ($, e, next) => {
    await refresh($).catch(() => {})
    return next(e)
  })

  // Under the prompt, in the band: it is shared, so keep what other mods drew
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!band || e.props.hasSurvey) return next(e)
    const b = band
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    const color = toneColor(b.tone)
    const left = [b.session, b.windows].filter(Boolean).join(' · ')
    // Three columns: the session on the left, the month's bar and figures in the middle of the band, the daily rate on the right.
    // The two sides grow from zero width alike, so the middle column sits at the band's center whatever their text.
    return (
      <Box flexDirection="column">
        {theirs}
        <Box flexDirection="row" width="100%" columnGap={2} alignItems="center">
          <Box key="left" flexDirection="row" flexGrow={1} width={0}>
            {left && <Text dimColor wrap="truncate-end">{left}</Text>}
          </Box>
          {b.month && (
            <Box key="middle" flexDirection="row" columnGap={1} flexShrink={0} alignItems="center">
              <Text dimColor>{b.month.name}</Text>
              {e.surface === 'terminal' ? (
                // A terminal draws block characters cleanly
                <Text dimColor={b.tone === 'calm'} color={color}>{meter(b.month.percent)}</Text>
              ) : (
                // Elsewhere the characters draw as hatched boxes in the app's font: a slim bar of two Boxes, in the theme's track and fill
                <Box key="meter" width={10} height={0.4} flexShrink={0} backgroundColor="userMessageBackground">
                  <Box width={`${Math.max(0, Math.min(b.month.percent, 100))}%`} height={0.4} backgroundColor={color ?? 'suggestion'} />
                </Box>
              )}
              <Text dimColor>{b.month.text}</Text>
            </Box>
          )}
          <Box key="right" flexDirection="row" flexGrow={1} width={0} justifyContent="flex-end">
            {b.forecast && <Text color={color} dimColor={b.tone === 'calm'} wrap="truncate-end">{b.forecast}</Text>}
          </Box>
        </Box>
      </Box>
    )
  })
}
