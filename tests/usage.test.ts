import { expect, mock, test } from 'claude-code/testing'

const DAY = 24 * 3600 * 1000

const APP = { content: [{ type: 'text', text: JSON.stringify({ plan: { plan: 'Enterprise', windows: [], extraUsage: { enabled: true, percentUsed: 25, spent: '190.59', monthlyLimit: '750.00', currency: 'USD' } } }) }], isError: false }

function stubs(on: any, app: any, limits: any[] = []) {
  mock.clock(on)
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/w' }))
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  on('ui.status', (_: any, e: any) => { status.push(e.text); return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('mcp.call', () => (app ? { value: app } : { deny: 'not connected' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { percent: 35 }, rateLimits: limits, cost: { usd: 1.234 } } }))
  return { status, toasts }
}

test('no status line is set, and a stale one from an earlier version is cleared', async ($, on) => {
  const { status } = stubs(on, APP)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  // The only status call clears a line an earlier version pinned; nothing is ever set
  expect(status.length).toBeGreaterThan(0)
  expect(status.every(s => s === undefined)).toBe(true)
})

test('without the app tool the band falls back to figures from the session itself', async ($, on) => {
  stubs(on, null, [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 40.5 }])
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount({ plugin: 'usage-meter', component: 'AbovePrompt', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 90, scroll: { offset: 0, bodyRows: 4 }, view: {} } } as any)
  // The session's cost at the left, and the subscription's two limits as bars in the middle
  expect(await ui.find({ key: 'left', text: '$1.23' })).toBeDefined()
  expect(await ui.find({ key: 'five', text: /^5h.*12%$/ })).toBeDefined()
  expect(await ui.find({ key: 'week', text: /^week.*41%$/ })).toBeDefined()
  // The context figure is gone: Claude reports it already
  expect(await ui.find({ type: 'Text', text: /context/ })).toBeUndefined()
})

const SUB = (windows: any[], extraUsage?: any) => ({ content: [{ type: 'text', text: JSON.stringify({ plan: { plan: 'Max', windows, extraUsage } }) }], isError: false })

test('a subscription shows its 5-hour and weekly use as bars, and no budget or forecast', async ($, on) => {
  const { toasts } = stubs(on, SUB(
    [{ kind: 'five_hour', percentUsed: 82 }, { kind: 'seven_day', percentUsed: 40 }, { kind: 'seven_day_opus', label: 'Weekly (Opus)', percentUsed: 95 }],
    // Extra usage on a subscription only begins when the limits run out: the limits are what show
    { enabled: true, percentUsed: 60, spent: '30', monthlyLimit: '50', currency: 'USD' },
  ))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'five', text: /^5h.*82%$/ })).toBeDefined()
  expect(await ui.find({ key: 'week', text: /^week.*40%$/ })).toBeDefined()
  // Per-model weekly limits are left out
  expect(await ui.find({ type: 'Text', text: '95%' })).toBeUndefined()
  // The 5-hour bar is yellow past 75%; the weekly one keeps the theme's fill
  const fills: any[] = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.height === 0.4 && typeof b.props?.width === 'string')
  expect(fills.map(f => [f.props.width, f.props.backgroundColor])).toEqual([['82%', 'yellow'], ['40%', 'suggestion']])
  expect(await ui.find({ type: 'Text', text: /left of|\/day|November|October/ })).toBeUndefined()
  expect(toasts).toEqual([])
})

test('a subscription in a terminal draws both limits in block characters', async ($, on) => {
  stubs(on, SUB([{ kind: 'five_hour', percentUsed: 92 }, { kind: 'seven_day', percentUsed: 10 }]))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const five: any = await ui.find({ type: 'Text', text: /^█{9}░$/ })
  expect(five.props.color).toBe('red')
  expect(await ui.find({ type: 'Text', text: /^█░{9}$/ })).toBeDefined()
})

test('crossing 50% of the month toasts once, and steady figures stay quiet', async ($, on) => {
  const clock = mock.clock(on)
  let pct = 45
  const warnings: string[] = []
  on('command.register', () => ({ value: undefined })); on('session.start', () => ({ cwd: '/w' })); on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  on('ui.status', () => ({ value: undefined }))
  const kv = new Map<string, unknown>(); on('store.get', (_: any, e: any) => ({ value: kv.get(e.key) })); on('store.set', (_: any, e: any) => { kv.set(e.key, e.value); return { value: undefined } })
  // The threshold toast says "Extra usage"; the one-off "loaded" toast does not count
  on('ui.toast', (_: any, e: any) => { if (/^Extra usage/.test(e.text)) warnings.push(e.text); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ plan: { extraUsage: { enabled: true, percentUsed: pct, spent: '1', monthlyLimit: '2', currency: 'USD' } } }) }] } }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  await clock.advance(5 * 60 * 1000 + 10)
  expect(warnings).toEqual([])
  pct = 52
  await clock.advance(5 * 60 * 1000 + 10)
  expect(warnings.length).toBe(1)
  expect(warnings[0]).toMatch(/52%/)
  await clock.advance(5 * 60 * 1000 + 10)
  expect(warnings.length).toBe(1)
})

const BAND = { plugin: 'usage-meter', component: 'AbovePrompt', surface: 'desktop', viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 90, scroll: { offset: 0, bodyRows: 4 }, view: {} } } as any

test('the band shows session and month with a slim bar on desktop', async ($, on) => {
  stubs(on, APP)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount(BAND)
  // The session's cost alone at the left, with no "session" label
  expect(await ui.find({ type: 'Text', text: '$1.23' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /session/ })).toBeUndefined()
  // The bar's label is a month's name, not the word "month"
  expect(await ui.find({ type: 'Text', text: /^(January|February|March|April|May|June|July|August|September|October|November|December)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'month' })).toBeUndefined()
  // A slim bar of two Boxes, filled to the month's percent
  const fill: any = (await ui.findAll({ type: 'Box' })).find((b: any) => b.props?.width === '25%')
  expect(fill).toBeDefined()
  expect(fill.props.backgroundColor).toBe('suggestion')
  expect(await ui.find({ type: 'Text', text: '$559.41 left of $750.00' })).toBeDefined()
  // No text-drawn meter any more
  expect(await ui.find({ type: 'Text', text: /[█░]/ })).toBeUndefined()
})

test('starting a session below every threshold shows no toast', async ($, on) => {
  const { toasts } = stubs(on, APP)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  expect(toasts).toEqual([])
})

const NOW = new Date(2026, 9, 5, 12, 0).getTime() // Oct 5 2026, noon: the cycle began Oct 1
const HIST = (samples: [number, number][], cycleStart = new Date(2026, 9, 1).getTime()) => ({ cycleStart, samples })

function forecastWorld(on: any, history: unknown, spent: string | (() => string) = '190.59', opts: { percent?: number; toasts?: string[] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>(history ? [['history', history]] : [])
  on('command.register', () => ({ value: undefined })); on('session.start', () => ({ cwd: '/w' })); on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] })); on('ui.status', () => ({ value: undefined })); on('ui.toast', (_: any, e: any) => { opts.toasts?.push(e.text); return { value: undefined } })
  on('store.get', (_: any, e: any) => ({ value: saved.get(e.key) })); on('store.set', (_: any, e: any) => { saved.set(e.key, e.value); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ plan: { extraUsage: { enabled: true, percentUsed: opts.percent ?? 25, spent: typeof spent === 'function' ? spent() : spent, monthlyLimit: '750.00', currency: 'USD' } } }) }] } }))
  return Object.assign(saved, { clock })
}

test('the band adds a short pace and date, in yellow when the budget runs out early', async ($, on) => {
  forecastWorld(on, null)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount(BAND)
  const tail: any = await ui.find({ type: 'Text', text: /^\$42\/day · runs out Oct 1[89]$/ })
  expect(tail).toBeDefined()
  expect(tail.props.color).toBe('yellow')
  // The bar sits in the middle column, between two sides that grow alike, and the rate in the right one
  expect(await ui.find({ key: "middle", text: /\$559\.41 left of \$750\.00/ })).toBeDefined()
  // On Oct 5 the bar's label is October
  expect(await ui.find({ key: 'middle', text: /^October/ })).toBeDefined()
  expect(await ui.find({ key: 'right', text: /runs out/ })).toBeDefined()
  const sides: any[] = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.flexGrow === 1 && b.props?.width === 0)
  expect(sides.length).toBe(2)
})

test('a slow pace shows only the daily rate, uncoloured', async ($, on) => {
  forecastWorld(on, HIST([[NOW - 2 * DAY, 150]]))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount(BAND)
  const tail: any = await ui.find({ type: 'Text', text: /^\$20\/day$/ })
  expect(tail).toBeDefined()
  expect(tail.props.color).toBeUndefined()
})

test('when the spend drops the cycle is treated as reset and history starts over', async ($, on) => {
  const saved = forecastWorld(on, HIST([[NOW - 3 * DAY, 700], [NOW - 1 * DAY, 740]]), '12.00')
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  const h: any = saved.get('history')
  expect(h.cycleStart).toBe(NOW)
  expect(h.samples.length).toBe(1)
})

test('frequent refreshes keep about one sample an hour, so the 7-day baseline survives heavy use', async ($, on) => {
  let spent = 190
  const saved = forecastWorld(on, null, () => String(spent))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  // Three days of refreshes every five minutes, the spend moving each time
  for (let i = 0; i < 3 * 24 * 12; i++) { spent += 0.05; await saved.clock.advance(5 * 60 * 1000) }
  const h: any = saved.get('history')
  expect(h.samples.length).toBeGreaterThan(60)
  expect(h.samples.length).toBeLessThan(90)
  // A sample from more than a day ago is still there for the recent rate
  expect(h.samples.some((s: [number, number]) => NOW + 3 * DAY - s[0] >= DAY)).toBe(true)
})

test('a threshold another session already toasted this cycle stays quiet', async ($, on) => {
  const toasts: string[] = []
  const saved = forecastWorld(on, null, '450', { percent: 60, toasts })
  saved.set('toasted', { cycleStart: new Date(2026, 9, 1).getTime(), threshold: 50 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  expect(toasts).toEqual([])
})

test('a threshold crossed while no session was open toasts once when one starts', async ($, on) => {
  const toasts: string[] = []
  const saved = forecastWorld(on, null, '585', { percent: 78, toasts })
  saved.set('toasted', { cycleStart: new Date(2026, 9, 1).getTime(), threshold: 50 })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/78%/)
  expect((saved.get('toasted') as any).threshold).toBe(75)
})

test('a terminal draws the meter in block characters', async ($, on) => {
  stubs(on, APP)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^█{3}░{7}$/ })).toBeDefined()
})

test('when the app tool is not connected at startup the month shows within a minute', async ($, on) => {
  const clock = mock.clock(on)
  let connected = false
  on('command.register', () => ({ value: undefined })); on('session.start', () => ({ cwd: '/w' })); on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] })); on('ui.status', () => ({ value: undefined })); on('ui.toast', () => ({ value: undefined }))
  const kv = new Map<string, unknown>(); on('store.get', (_: any, e: any) => ({ value: kv.get(e.key) })); on('store.set', (_: any, e: any) => { kv.set(e.key, e.value); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: 1.234 } } }))
  on('mcp.call', () => (connected ? { value: APP } : { deny: 'not connected' }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '$559.41 left of $750.00' })).toBeUndefined()
  connected = true
  await clock.advance(10 * 1000 + 10)
  expect(await ui.find({ type: 'Text', text: '$559.41 left of $750.00' })).toBeDefined()
})
