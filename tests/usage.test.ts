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
  expect(await ui.find({ type: 'Text', text: 'session $1.23 · context 35% · 5h 12% · 7d 40.5%' })).toBeDefined()
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

test('the band under the prompt shows session and month with a meter', async ($, on) => {
  stubs(on, APP)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /session \$1.23 · context 35% · month [█░]{10} \$190.59 \/ \$750.00 \(25%\)/ })).toBeDefined()
})

test('a loaded toast confirms the mod is running', async ($, on) => {
  const { toasts } = stubs(on, APP)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  expect(toasts[0]).toMatch(/^usage-meter: session/)
})

const NOW = new Date(2026, 9, 5, 12, 0).getTime() // Oct 5 2026, noon: the cycle began Oct 1
const HIST = (samples: [number, number][], cycleStart = new Date(2026, 9, 1).getTime()) => ({ cycleStart, samples })

function forecastWorld(on: any, history: unknown, spent = '190.59') {
  mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>(history ? [['history', history]] : [])
  on('command.register', () => ({ value: undefined })); on('session.start', () => ({ cwd: '/w' })); on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] })); on('ui.status', () => ({ value: undefined })); on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_: any, e: any) => ({ value: saved.get(e.key) })); on('store.set', (_: any, e: any) => { saved.set(e.key, e.value); return { value: undefined } })
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [] } }))
  on('mcp.call', () => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ plan: { extraUsage: { enabled: true, percentUsed: 25, spent, monthlyLimit: '750.00', currency: 'USD' } } }) }] } }))
  return saved
}

test('the band adds a short pace and date, in yellow when the budget runs out early', async ($, on) => {
  forecastWorld(on, null)
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/w' })
  const ui = await $.ui.mount(BAND)
  const tail: any = await ui.find({ type: 'Text', text: /^\$42\/day · Oct 1[89]$/ })
  expect(tail).toBeDefined()
  expect(tail.props.color).toBe('yellow')
  // It sits at the right edge of the same row as the figures
  const row: any = await ui.find({ type: 'Box', props: { justifyContent: 'space-between' } } as any)
  expect(row).toBeDefined()
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
