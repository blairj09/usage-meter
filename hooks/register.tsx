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
// One bar in the middle of the band: the month's budget, or a plan's 5-hour or weekly limit
type Meter = { key: string; label: string; percent: number; text: string; color?: string }

// What the band above the prompt draws: set by refresh, drawn by the ui.render hook
type Band = {
  // This session's cost, "$1.15"
  session: string
  // On a subscription the cost is not billed: it reads "$1.15 at API rates", fainter than the bars
  faint?: boolean
  // On a budget plan, one bar: the month's name and what is left, "November ▬▬ $410.25 left of $750.00".
  // On a subscription, two: "5h ▬▬ 12%" in the middle and "week ▬▬ 40%" at the right edge.
  meters: Meter[]
  // Budget plans only: "$13/day", or "$42/day · runs out Oct 18" when the budget will run out before the month ends
  forecast: string
  tone: Tone
}
let band: Band | null = null

const money = (v: string | number | undefined, cur = 'USD', digits = 2) =>
  v === undefined ? '?' : (cur === 'USD' ? '$' : cur + ' ') + Number(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const winName = (w: { name?: string; kind?: string; label?: string }) => w.label ?? w.name ?? ({ five_hour: '5h', seven_day: '7d', spend_limit: 'spend' } as Record<string, string>)[w.kind ?? ''] ?? w.kind ?? 'limit'

type Window = NonNullable<Plan['windows']>[number]
// The plan's 5-hour and all-models weekly windows, by kind, else by label. Per-model weekly windows are left out.
const fiveHour = (ws: Window[]) => ws.find(w => w.kind === 'five_hour') ?? ws.find(w => /\b5\s*-?\s*h/i.test(winName(w)))
const weekly = (ws: Window[]) => ws.find(w => w.kind === 'seven_day') ?? ws.find(w => /week|\b7\s*-?\s*d/i.test(winName(w)) && !/opus|sonnet|haiku|fable|model/i.test(winName(w)))
// A limit's bar turns yellow at 75% and red at 90%
const limitColor = (pct: number) => (pct >= 90 ? 'red' : pct >= 75 ? 'yellow' : undefined)

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
  const x = app?.extraUsage
  // The app's windows, else the ones the session's last response reported (in a terminal the app's tool is not there)
  const windows = (app?.windows?.length ? app.windows : s.plan.windows ?? []).filter(w => w.percentUsed !== undefined)
  const next: Band = {
    session: s.cost !== undefined ? `$${s.cost.toFixed(2)}` : '',
    meters: [],
    forecast: '',
    tone: 'calm',
  }
  // A subscription has 5-hour and weekly limits: show how much of each is used
  const limits = [['five', '5h', fiveHour(windows)], ['week', 'week', weekly(windows)]] as const
  for (const [key, label, w] of limits) {
    if (w) next.meters.push({ key, label, percent: w.percentUsed!, text: `${Math.round(w.percentUsed!)}%`, color: limitColor(w.percentUsed!) })
  }
  // A subscription is not billed by the token: the cost is what the session would have cost at API prices, so say so
  if (next.meters.length && next.session) {
    next.session += ' at API rates'
    next.faint = true
  }
  // A budget plan has no such limits, only the month's budget: show what is left of it
  const budget = !next.meters.length && x?.enabled && x.percentUsed !== undefined ? x : undefined
  if (budget) {
    const left = budget.spent !== undefined && budget.monthlyLimit !== undefined ? Math.max(0, Number(budget.monthlyLimit) - Number(budget.spent)) : undefined
    next.meters.push({
      key: 'month',
      label: new Date(await $.clock.now()).toLocaleDateString('en-US', { month: 'long' }),
      percent: budget.percentUsed!,
      text: left !== undefined ? `${money(left, budget.currency)} left of ${money(budget.monthlyLimit, budget.currency)}` : `${budget.percentUsed}%`,
    })
  }
  // The forecast and the toasts need the month's spend and limit; they are quiet when they cannot be made
  if (budget && budget.spent !== undefined && budget.monthlyLimit !== undefined) {
    try {
      const spent = Number(budget.spent)
      const limit = Number(budget.monthlyLimit)
      const now = await $.clock.now()
      const h = await track($, spent)
      const f = forecast(spent, limit, now, h)
      if (spent >= limit) {
        next.forecast = 'limit reached'
        next.tone = 'alert'
      } else if (f) {
        next.forecast = forecastShort(f, budget.currency ?? 'USD')
        const daysLeft = f.runsOutAt === null ? Infinity : (f.runsOutAt - now) / DAY
        next.tone = f.isEarly ? (daysLeft <= 7 ? 'alert' : 'warn') : 'calm'
      }
      await maybeToast($, budget, h.cycleStart)
    } catch {
      // No history this time (the store failed): the figures still show
    }
  }
  // The budget's bar takes the forecast's colour
  const month = next.meters.find(m => m.key === 'month')
  if (month) month.color = toneColor(next.tone)
  band = next.session || next.meters.length ? next : null
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
    const bar = (m: Meter) => (
      <Box key={m.key} flexDirection="row" columnGap={1} flexShrink={0} alignItems="center">
        <Text dimColor>{m.label}</Text>
        {e.surface === 'terminal' ? (
          // A terminal draws block characters cleanly
          <Text dimColor={!m.color} color={m.color}>{meter(m.percent)}</Text>
        ) : (
          // Elsewhere the characters draw as hatched boxes in the app's font: a slim bar of two Boxes, in the theme's track and fill
          <Box key="meter" width={10} height={0.4} flexShrink={0} backgroundColor="userMessageBackground">
            <Box width={`${Math.max(0, Math.min(m.percent, 100))}%`} height={0.4} backgroundColor={m.color ?? 'suggestion'} />
          </Box>
        )}
        <Text dimColor>{m.text}</Text>
      </Box>
    )
    // A subscription's weekly bar sits at the right edge, where a budget plan has its daily rate
    const week = b.meters.find(m => m.key === 'week')
    const middle = b.meters.filter(m => m !== week)
    // Three columns: the session on the left, the month's or the 5-hour bar in the middle of the band, the daily rate or the weekly bar on the right.
    // The two sides grow from zero width alike, so the middle column sits at the band's center whatever their text.
    return (
      <Box flexDirection="column">
        {theirs}
        <Box flexDirection="row" width="100%" columnGap={2} alignItems="center">
          <Box key="left" flexDirection="row" flexGrow={1} width={0}>
            {b.session && <Text dimColor color={b.faint ? 'inactive' : undefined} wrap="truncate-end">{b.session}</Text>}
          </Box>
          {middle.length > 0 && (
            <Box key="middle" flexDirection="row" columnGap={3} flexShrink={0} alignItems="center">
              {middle.map(bar)}
            </Box>
          )}
          <Box key="right" flexDirection="row" flexGrow={1} width={0} justifyContent="flex-end">
            {week ? bar(week) : b.forecast && <Text color={color} dimColor={b.tone === 'calm'} wrap="truncate-end">{b.forecast}</Text>}
          </Box>
        </Box>
      </Box>
    )
  })
}
