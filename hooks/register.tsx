import type { Register } from 'claude-code'

// What the desktop app's usage card reports: plan limits and, on Enterprise, the monthly extra-usage budget
type Plan = {
  status?: string
  plan?: string
  windows?: { name?: string; kind?: string; label?: string; percentUsed?: number; resetsAt?: string }[]
  extraUsage?: { enabled?: boolean; percentUsed?: number; spent?: string; monthlyLimit?: string; currency?: string }
}

const DAY = 24 * 3600 * 1000
const THRESHOLDS = [50, 75, 90]

// Spend samples for this billing cycle, kept in $.store so the forecast can use the recent rate and not only the month's average
type History = { cycleStart: number; samples: [number, number][] }
type Forecast = { rate: number; basis: string; monthRate: number; recentRate: number | null; runsOutAt: number | null; cycleEnd: number; endSpend: number; isEarly: boolean }
let lastPercent: number | null = null
// What the band above the prompt draws: set by refresh, drawn by the ui.render hook
let bandText = ''
// The forecast line under it, and how loudly to draw it
let bandForecast = ''
let bandTone: 'calm' | 'warn' | 'alert' = 'calm'

const meter = (pct: number, width = 10) => '█'.repeat(Math.round((width * Math.min(pct, 100)) / 100)) + '░'.repeat(width - Math.round((width * Math.min(pct, 100)) / 100))

const money = (v: string | undefined, cur = 'USD') => (v === undefined ? '?' : (cur === 'USD' ? '$' : cur + ' ') + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const winName = (w: { name?: string; kind?: string; label?: string }) => w.label ?? w.name ?? ({ five_hour: '5h', seven_day: '7d', spend_limit: 'spend' } as Record<string, string>)[w.kind ?? ''] ?? w.kind ?? 'limit'

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const startOfMonth = (ms: number) => { const d = new Date(ms); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime() }

// Record this reading. The cycle starts on the 1st until the spend drops, which means the budget reset: then it starts then.
async function track($: any, spent: number): Promise<History> {
  const now = await $.clock.now()
  let h = ((await $.store.get('history')) as History | undefined) ?? { cycleStart: startOfMonth(now), samples: [] }
  const last = h.samples[h.samples.length - 1]
  if (last && spent < last[1] - 0.5) h = { cycleStart: now, samples: [] }
  if (!last || spent !== last[1] || now - last[0] >= 30 * 60 * 1000) h.samples.push([now, spent])
  h.samples = h.samples.slice(-400)
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
  return { rate, basis: recentRate !== null ? 'last 7 days' : 'month so far', monthRate, recentRate, runsOutAt, cycleEnd, endSpend: spent + rate * ((cycleEnd - now) / DAY), isEarly: runsOutAt !== null && runsOutAt < cycleEnd }
}

// The band's version, drawn at the right edge: "$42/day · Oct 18" (the date the budget runs out). On track there is no date to give: "$20/day".
function forecastShort(f: Forecast, limit: number, spent: number, cur: string) {
  if (spent >= limit) return 'limit reached'
  const perDay = f.rate >= 10 ? money(String(Math.round(f.rate)), cur).replace('.00', '') : money(String(f.rate), cur)
  return f.isEarly ? `${perDay}/day · ${fmtDate(f.runsOutAt!)}` : `${perDay}/day`
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
async function sessionPlan($: any): Promise<{ plan: Plan; cost?: number; context?: number }> {
  const u = await $.session.usage()
  return { plan: { windows: u.rateLimits.map((w: any) => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt })) }, cost: u.cost?.usd, context: u.context?.percent ?? undefined }
}

async function gather($: any) {
  const app = await appPlan($)
  const s = await sessionPlan($)
  return { plan: app ?? s.plan, cost: s.cost, context: s.context, hasApp: !!app }
}

// "session $1.23 · context 35% · month $190.59 / $750.00 (25%)": this session first, then the month against its limit
function oneLine(plan: Plan, cost?: number, context?: number) {
  const parts: string[] = []
  if (cost !== undefined) parts.push(`session $${cost.toFixed(2)}`)
  if (context !== undefined) parts.push(`context ${Math.round(context)}%`)
  const x = plan.extraUsage
  if (x?.enabled) parts.push(`month ${money(x.spent, x.currency)} / ${money(x.monthlyLimit, x.currency)} (${x.percentUsed}%)`)
  for (const w of plan.windows ?? []) if (w.percentUsed !== undefined) parts.push(`${winName(w)} ${w.percentUsed}%`)
  return parts.join(' · ')
}

async function refresh($: any) {
  const { plan, cost, context } = await gather($)
  const line = oneLine(plan, cost, context)
  // The band shows the same figures with a meter for the month
  const x = plan.extraUsage
  bandText = x?.enabled && x.percentUsed !== undefined ? line.replace(/month /, `month ${meter(x.percentUsed)} `) : line
  // The forecast needs the month's spend and limit; it is quiet when it cannot be made
  bandForecast = ''
  bandTone = 'calm'
  if (x?.enabled && x.spent !== undefined && x.monthlyLimit !== undefined) {
    try {
      const spent = Number(x.spent)
      const limit = Number(x.monthlyLimit)
      const now = await $.clock.now()
      const f = forecast(spent, limit, now, await track($, spent))
      if (f && spent < limit) {
        bandForecast = forecastShort(f, limit, spent, x.currency ?? 'USD')
        const daysLeft = f.runsOutAt === null ? Infinity : (f.runsOutAt - now) / DAY
        bandTone = f.isEarly ? (daysLeft <= 7 ? 'alert' : 'warn') : 'calm'
      }
    } catch {
      // No history this time (the store failed): the figures and the threshold toast still work
    }
  }
  $.ui.invalidate('ui.render')
  // Tell the person once when the month's budget crosses a threshold
  const pct = plan.extraUsage?.enabled ? plan.extraUsage.percentUsed : undefined
  if (pct !== undefined) {
    if (lastPercent !== null) {
      const crossed = THRESHOLDS.filter(t => lastPercent! < t && pct >= t).pop()
      if (crossed) $.ui.toast(`Extra usage is at ${pct}% of this month's ${money(plan.extraUsage!.monthlyLimit, plan.extraUsage!.currency)}`, { timeoutMs: 8000 })
    }
    lastPercent = pct
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // An earlier version pinned a status line, which stays until replaced: clear it. The band is the one place the figures show.
    $.ui.status(undefined)
    await refresh($).catch(() => {})
    $.ui.toast(bandText ? `usage-meter: ${bandText}` : 'usage-meter loaded (no figures yet)', { timeoutMs: 6000 })
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
    if (!bandText || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        {theirs}
        <Box flexDirection="row" justifyContent="space-between" width="100%" columnGap={2}>
          <Text dimColor wrap="truncate-end">{bandText}</Text>
          {bandForecast && <Text color={bandTone === 'alert' ? 'red' : bandTone === 'warn' ? 'yellow' : undefined} dimColor={bandTone === 'calm'}>{bandForecast}</Text>}
        </Box>
      </Box>
    )
  })
}
