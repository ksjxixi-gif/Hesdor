#!/usr/bin/env node
// Benchmark matrix: pass rate and dollars per solved task per contender, through Harbor.
// See docs/benchmarks.md.
//
//   node scripts/bench/matrix.mjs <spec.json>              dry run: print the harbor commands and a cost estimate
//   node scripts/bench/matrix.mjs <spec.json> --execute    run them one after another, then aggregate
//   node scripts/bench/matrix.mjs <spec.json> --aggregate  aggregate existing job folders only
//   options: --out <dir> (default <jobsDir>/<name>-report)
//
// Reads Harbor's per-trial <jobsDir>/<name>-<contender id>/<trial>/result.json (TrialResult:
// task_name, verifier_result.rewards, reward_valid, exception_info, agent_result tokens and cost_usd).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const HESDOR_AGENT = 'hesdor_agent:Hesdor'
const DEFAULT_ESTIMATE = { inputTokensPerTrial: 1_500_000, outputTokensPerTrial: 50_000, cacheHit: 0.9 }
const BOOTSTRAP = 2000

// ---------- spec ----------

export function loadSpec(file) {
  const spec = JSON.parse(readFileSync(file, 'utf8'))
  const base = dirname(resolve(file))
  for (const key of ['name', 'dataset']) if (typeof spec[key] !== 'string' || !spec[key]) throw new Error(`spec.${key} is required`)
  if (!/^[\w.-]+$/.test(spec.name)) throw new Error('spec.name may only contain letters, digits, ".", "_" and "-"')
  if (!Array.isArray(spec.contenders) || spec.contenders.length === 0) throw new Error('spec.contenders must be a non-empty array')
  const ids = new Set()
  for (const c of spec.contenders) {
    if (!c.id || !/^[\w.-]+$/.test(c.id)) throw new Error(`contender id ${JSON.stringify(c.id)} must match [\\w.-]+`)
    if (ids.has(c.id)) throw new Error(`duplicate contender id ${c.id}`)
    ids.add(c.id)
    if (!c.agent) throw new Error(`contender ${c.id}: agent is required (hesdor, claude-code, codex, mini-swe-agent, ...)`)
    if (c.agent !== 'hesdor' && c.profile) throw new Error(`contender ${c.id}: profile is only for agent "hesdor"`)
    if (c.agent !== 'hesdor' && !c.model && !['oracle', 'nop'].includes(c.agent)) throw new Error(`contender ${c.id}: model is required`)
  }
  spec.k = Number(spec.k ?? 3)
  if (!Number.isInteger(spec.k) || spec.k < 1) throw new Error('spec.k must be a positive integer')
  spec.jobsDir = resolve(base, spec.jobsDir ?? join(root, 'evals/jobs'))
  spec.tasks = selectTasks(spec, base)
  return spec
}

/** Explicit `tasks`, or `sample: { n, seed, pool }` (pool: array, a file with one name per line, or a dataset folder). */
export function selectTasks(spec, base = process.cwd()) {
  if (spec.tasks) return spec.tasks
  if (!spec.sample) return null // whole dataset
  const { n, seed = 1 } = spec.sample
  let pool = spec.sample.pool
  if (typeof pool === 'string') {
    const p = resolve(base, pool)
    pool = statSync(p).isDirectory()
      ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
      : readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  }
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('spec.sample.pool must list the dataset task names')
  if (!(n > 0) || n > pool.length) throw new Error(`spec.sample.n must be 1..${pool.length}`)
  const rnd = rng(seed)
  const a = [...new Set(pool)].sort()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, n).sort()
}

// mulberry32: small seeded PRNG so samples and bootstrap intervals are reproducible.
export function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- commands ----------

export const jobName = (spec, c) => `${spec.name}-${c.id}`

/** The `harbor run` argv for one contender, plus extra env. */
export function harborCommand(spec, c) {
  const args = ['run', '-d', spec.dataset]
  const env = {}
  if (c.agent === 'hesdor') {
    args.push('-a', HESDOR_AGENT)
    env.PYTHONPATH = 'evals/harbor'
  } else args.push('-a', c.agent)
  if (c.model) args.push('-m', c.model)
  const ak = { ...(c.agent === 'hesdor' ? { max_steps: 100 } : {}), ...(c.profile ? { profile: c.profile } : {}), ...c.ak }
  for (const [key, v] of Object.entries(ak)) args.push('--ak', `${key}=${v}`)
  for (const t of spec.tasks ?? []) args.push('-i', t)
  args.push('-k', String(spec.k), '-n', String(spec.concurrency ?? 4))
  if (spec.resources?.cpus) args.push('--override-cpus', String(spec.resources.cpus))
  if (spec.resources?.memoryMb) args.push('--override-memory-mb', String(spec.resources.memoryMb))
  const rel = relative(root, spec.jobsDir)
  // harbor runs from the repo root, so a jobs dir inside it is printed relative (portable commands).
  args.push('-o', rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : spec.jobsDir, '--job-name', jobName(spec, c), ...(spec.extraArgs ?? []), ...(c.extraArgs ?? []))
  return { args, env }
}

const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`)
export const formatCommand = ({ args, env }) =>
  [...Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`), 'harbor', ...args.map(shq)].join(' ')

// ---------- prices ----------

let catalog
function loadCatalog() {
  if (catalog !== undefined) return catalog
  const f = join(root, 'packages/providers/src/catalog.json')
  catalog = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).providers : null
  return catalog
}

/** USD per million tokens for "<provider>/<model>" from the bundled models.dev snapshot (same matching as catalog.ts). */
export function priceFor(ref, providers = loadCatalog()) {
  if (!ref || !providers) return null
  const [provider, ...rest] = ref.split('/')
  const model = rest.join('/')
  const models = providers[provider]
  if (!models || !model) return null
  const bare = (id) => id.slice(id.lastIndexOf('/') + 1).toLowerCase()
  const keys = Object.keys(models)
  const key = model in models ? model : (keys.find((k) => k.toLowerCase() === model.toLowerCase()) ?? keys.find((k) => bare(k) === bare(model)))
  const row = key && models[key]
  // Row: [context, maxOutput, input, output, cacheRead, cacheWrite, flags, date, longContext?]
  if (!row || row[2] == null || row[3] == null) return null
  // shortcut: ignores the long-context tier (row[8]); upgrade if a contender's requests exceed it.
  return { input: row[2], output: row[3], cacheRead: row[4] ?? row[2] }
}

/** Per-trial dollar estimate from token assumptions: upper bound (no cache) and typical (cacheHit share read from cache). */
export function estimateTrial(price, est = DEFAULT_ESTIMATE) {
  if (!price) return null
  const { inputTokensPerTrial: i, outputTokensPerTrial: o, cacheHit: h } = { ...DEFAULT_ESTIMATE, ...est }
  const out = (o * price.output) / 1e6
  return { upper: (i * price.input) / 1e6 + out, typical: (i * (1 - h) * price.input + i * h * price.cacheRead) / 1e6 + out }
}

export function dryRun(spec, log = console.log) {
  const nTasks = spec.tasks?.length ?? spec.datasetSize
  log(`# ${spec.name}: ${spec.dataset}, ${spec.tasks ? `${nTasks} tasks` : 'all tasks'}, k=${spec.k}, ${spec.contenders.length} contenders`)
  log(`# run from the repo root; jobs land in ${spec.jobsDir}\n`)
  const rows = []
  for (const c of spec.contenders) {
    log(formatCommand(harborCommand(spec, c)) + '\n')
    const priceRef = c.priceAs ?? (c.model?.includes('/') ? c.model : null)
    const per = estimateTrial(priceFor(priceRef), spec.estimate)
    const trials = nTasks ? nTasks * spec.k : null
    rows.push([c.id, priceRef ?? '?', per && trials ? per.typical * trials : null, per && trials ? per.upper * trials : null])
  }
  const est = { ...DEFAULT_ESTIMATE, ...spec.estimate }
  log(`# Cost estimate (catalog prices; ${est.inputTokensPerTrial} input + ${est.outputTokensPerTrial} output tokens per trial;`)
  log(`# typical = ${Math.round(est.cacheHit * 100)}% of input read from cache, upper = no cache). An estimate, not a quote.`)
  const $ = (x) => (x == null ? 'n/a' : `$${x.toFixed(2)}`)
  for (const [id, ref, typ, up] of rows) log(`#   ${id.padEnd(24)} ${ref.padEnd(36)} typical ${$(typ).padStart(9)}   upper ${$(up).padStart(9)}`)
  const sum = (i) => (rows.every((r) => r[i] != null) ? rows.reduce((a, r) => a + r[i], 0) : null)
  log(`#   ${'total'.padEnd(61)} typical ${$(sum(2)).padStart(9)}   upper ${$(sum(3)).padStart(9)}`)
  if (!nTasks) log('#   (no task list: set spec.datasetSize to estimate a whole-dataset run)')
  if (rows.some((r) => r[2] == null && nTasks)) log('#   n/a: no catalog price; set "priceAs": "<provider>/<model>" (e.g. for a profile, its most expensive model)')
  return rows
}

// ---------- reading Harbor jobs ----------

/** One normalized trial from a Harbor TrialResult. */
export function readTrial(r, price) {
  const rewards = r.verifier_result?.rewards
  const reward = rewards ? (rewards.reward ?? Object.values(rewards)[0]) : null
  // reward_valid is Harbor's computed field: false for infra/provider errors (ApiError, auth, sandbox, ...).
  const infra = typeof r.reward_valid === 'boolean' ? !r.reward_valid : reward == null
  const a = r.agent_result ?? {}
  const md = a.metadata ?? {}
  let cost = typeof a.cost_usd === 'number' ? a.cost_usd : null
  let costSource = cost == null ? 'unknown' : 'reported'
  if (cost == null && price && a.n_input_tokens != null && a.n_output_tokens != null) {
    const cache = a.n_cache_tokens ?? 0 // n_input_tokens includes cache reads (Harbor AgentContext)
    cost = ((a.n_input_tokens - cache) * price.input + cache * price.cacheRead + a.n_output_tokens * price.output) / 1e6
    costSource = 'estimated'
  }
  return {
    task: r.task_name,
    trial: r.trial_name,
    reward,
    solved: !infra && typeof reward === 'number' && reward >= 1,
    infra,
    exception: r.exception_info?.exception_type ?? null,
    cost,
    costSource,
    inputTokens: a.n_input_tokens ?? null,
    cacheTokens: a.n_cache_tokens ?? null,
    outputTokens: a.n_output_tokens ?? null,
    profile: md.hesdor_profile ?? null,
    escalations: typeof md.hesdor_escalations === 'number' ? md.hesdor_escalations : null,
  }
}

/** All finished trials in a Harbor job folder (each trial is a subfolder with result.json). */
export function readJob(dir, price) {
  if (!existsSync(dir)) return { trials: [], incomplete: 0, missing: true }
  const trials = []
  let incomplete = 0
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const f = join(dir, d.name, 'result.json')
    let r
    try {
      r = JSON.parse(readFileSync(f, 'utf8'))
    } catch {
      incomplete++ // running, cancelled before writing, or unreadable
      continue
    }
    if (typeof r?.task_name !== 'string') continue
    if (!r.finished_at && !r.verifier_result && !r.exception_info) {
      incomplete++
      continue
    }
    trials.push(readTrial(r, price))
  }
  return { trials, incomplete, missing: false }
}

// ---------- statistics ----------

function choose(n, k) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return r
}
/** Chance that at least one of k of the n trials (c solved) succeeds (unbiased estimator, Chen et al. 2021). */
export const passAtK = (n, c, k) => 1 - choose(n - c, k) / choose(n, k)
/** Chance that all k drawn trials succeed. */
export const passHatK = (n, c, k) => choose(c, k) / choose(n, k)

/** Wilson score interval for x successes in n trials. */
export function wilson(x, n, z = 1.959964) {
  if (n === 0) return [0, 1]
  const p = x / n
  const d = 1 + (z * z) / n
  const mid = (p + (z * z) / (2 * n)) / d
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, mid - half), Math.min(1, mid + half)]
}

function percentile(sorted, q) {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo)
}

/** 95% percentile bootstrap over tasks for a statistic of a list of tasks. */
export function bootstrap(tasks, stat, seed = 7, b = BOOTSTRAP) {
  if (tasks.length === 0) return null
  const rnd = rng(seed)
  const xs = []
  for (let i = 0; i < b; i++) xs.push(stat(Array.from(tasks, () => tasks[Math.floor(rnd() * tasks.length)])))
  xs.sort((a, b) => a - b)
  return [percentile(xs, 0.025), percentile(xs, 0.975)]
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const sumBy = (xs, f) => xs.reduce((a, x) => a + f(x), 0)

/** Per-contender numbers from its trials. Infra trials count toward cost, never toward rates. */
export function summarize(trials, k) {
  const byTask = new Map()
  for (const t of trials) {
    const s = byTask.get(t.task) ?? { task: t.task, n: 0, c: 0, infra: 0, validCost: 0, cost: 0 }
    s.cost += t.cost ?? 0
    if (t.infra) s.infra++
    else {
      s.n++
      s.c += t.solved ? 1 : 0
      s.validCost += t.cost ?? 0
    }
    byTask.set(t.task, s)
  }
  const all = [...byTask.values()].sort((a, b) => a.task.localeCompare(b.task))
  const scored = all.filter((s) => s.n > 0)
  const kk = (s) => Math.min(k, s.n) // tasks with fewer valid trials than k use k = n (reported as tasksShortOfK)
  const pass1 = (ts) => mean(ts.map((s) => s.c / s.n))
  const pAtK = (ts) => mean(ts.map((s) => passAtK(s.n, s.c, kk(s))))
  const pHatK = (ts) => mean(ts.map((s) => passHatK(s.n, s.c, kk(s))))
  const perSolved = (ts) => {
    const c = sumBy(ts, (s) => s.c)
    return c ? sumBy(ts, (s) => s.validCost) / c : Infinity
  }
  const valid = trials.filter((t) => !t.infra)
  const solved = sumBy(valid, (t) => (t.solved ? 1 : 0))
  const totalCost = sumBy(trials, (t) => t.cost ?? 0)
  const validCost = sumBy(valid, (t) => t.cost ?? 0)
  const infraTypes = {}
  for (const t of trials) if (t.infra) infraTypes[t.exception ?? 'no reward'] = (infraTypes[t.exception ?? 'no reward'] ?? 0) + 1
  const tok = (f) => mean(trials.map(f).filter((x) => x != null))
  const esc = trials.map((t) => t.escalations).filter((x) => x != null)
  const finite = (ci) => ci && ci.map((x) => (Number.isFinite(x) ? x : null))
  return {
    k,
    tasks: all.length,
    tasksScored: scored.length,
    tasksShortOfK: scored.filter((s) => s.n < k).length,
    trials: trials.length,
    validTrials: valid.length,
    solvedTrials: solved,
    infraErrors: trials.length - valid.length,
    infraTypes,
    pass1: pass1(scored),
    pass1CI: bootstrap(scored, pass1),
    pass1Wilson: wilson(solved, valid.length), // pooled trials; ignores per-task clustering, so narrower
    passAtK: pAtK(scored),
    passAtKCI: bootstrap(scored, pAtK),
    passHatK: pHatK(scored),
    passHatKCI: bootstrap(scored, pHatK),
    totalCost,
    validCost,
    infraCost: totalCost - validCost,
    costPerTask: all.length ? totalCost / all.length : null,
    costPerSolved: solved ? validCost / solved : null, // null: nothing solved (infinite)
    costPerSolvedCI: solved ? finite(bootstrap(scored, perSolved)) : null, // null bound: some resamples solved nothing
    costCoverage: {
      reported: trials.filter((t) => t.costSource === 'reported').length,
      estimated: trials.filter((t) => t.costSource === 'estimated').length,
      unknown: trials.filter((t) => t.costSource === 'unknown').length,
    },
    meanTokens: { input: tok((t) => t.inputTokens), cache: tok((t) => t.cacheTokens), output: tok((t) => t.outputTokens) },
    meanEscalations: esc.length ? mean(esc) : null,
    perTask: Object.fromEntries(all.map((s) => [s.task, { n: s.n, c: s.c, infra: s.infra, cost: s.cost }])),
  }
}

export function aggregate(spec) {
  const contenders = spec.contenders.map((c) => {
    const priceRef = c.priceAs ?? (c.model?.includes('/') ? c.model : null)
    const job = readJob(join(spec.jobsDir, jobName(spec, c)), priceFor(priceRef))
    return {
      id: c.id,
      agent: c.agent,
      model: c.model ?? null,
      profile: c.profile ?? null,
      job: jobName(spec, c),
      missing: job.missing,
      incomplete: job.incomplete,
      ...summarize(job.trials, spec.k),
    }
  })
  return { name: spec.name, dataset: spec.dataset, k: spec.k, generatedAt: new Date().toISOString(), contenders }
}

// ---------- outputs ----------

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
const ci = (c, f) => (c ? ` (${f(c[0])}–${f(c[1])})` : '')
const usd = (x) => (x == null ? '∞' : x >= 100 ? `$${x.toFixed(0)}` : `$${x.toFixed(x < 1 ? 3 : 2)}`)
const ktok = (x) => (x == null ? '–' : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(x < 1e4 ? 1 : 0)}k` : `${Math.round(x)}`)

export function markdown(summary) {
  const k = summary.k
  const lines = [
    `Dataset \`${summary.dataset}\`, k=${k}, generated ${summary.generatedAt.slice(0, 10)}. 95% intervals are a bootstrap over tasks.`,
    '',
    `| Contender | Agent | Model / profile | Tasks | pass@1 | pass@${k} | pass^${k} | $ total | $/task | $/solved | Tokens in / cached / out (mean) | Infra errors |`,
    '|---|---|---|--:|---|---|---|--:|--:|---|---|--:|',
  ]
  for (const c of summary.contenders) {
    const flag = c.costCoverage.unknown ? ' ⚠' : c.costCoverage.estimated ? ' *' : ''
    lines.push(
      `| ${c.id} | ${c.agent} | ${[c.profile && `profile ${c.profile}`, c.model].filter(Boolean).join(', ') || '–'} | ${c.tasksScored} | ` +
        `${pct(c.pass1)}${ci(c.pass1CI, pct)} | ${pct(c.passAtK)}${ci(c.passAtKCI, pct)} | ${pct(c.passHatK)}${ci(c.passHatKCI, pct)} | ` +
        `${usd(c.totalCost)}${flag} | ${c.costPerTask == null ? '–' : usd(c.costPerTask)} | ${usd(c.costPerSolved)}${ci(c.costPerSolvedCI, usd)} | ` +
        `${ktok(c.meanTokens.input)} / ${ktok(c.meanTokens.cache)} / ${ktok(c.meanTokens.output)} | ${c.infraErrors} |`,
    )
  }
  lines.push(
    '',
    `pass@1 is the mean over tasks of solved/valid trials; pass@${k} and pass^${k} are the unbiased estimators averaged over tasks. ` +
      'Infra errors (Harbor `reward_valid: false`: provider/API errors, Hesdor exit 3, sandbox failures) are left out of every rate; their cost is in $ total but not in $/solved. ' +
      '$/solved is the cost of valid trials divided by solved trials (∞ when nothing was solved). ' +
      '`*` some trial costs were estimated from tokens and catalog prices; `⚠` some trials reported no cost and no price was known, so the total is a lower bound. ' +
      'Treat gaps under about 3 points, or overlapping intervals, as noise.',
  )
  const tasks = [...new Set(summary.contenders.flatMap((c) => Object.keys(c.perTask)))].sort()
  if (tasks.length) {
    lines.push('', `<details><summary>Per-task outcomes (solved / valid trials, +n infra)</summary>`, '')
    lines.push(`| Task | ${summary.contenders.map((c) => c.id).join(' | ')} |`, `|---|${summary.contenders.map(() => '---').join('|')}|`)
    for (const t of tasks) {
      const cells = summary.contenders.map((c) => {
        const s = c.perTask[t]
        return s ? `${s.c}/${s.n}${s.infra ? ` +${s.infra}` : ''}` : '–'
      })
      lines.push(`| ${t} | ${cells.join(' | ')} |`)
    }
    lines.push('', '</details>')
  }
  return lines.join('\n') + '\n'
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const THEMES = {
  light: { bg: '#ffffff', fg: '#1f2328', muted: '#59636e', grid: '#d1d9e0', hesdor: '#0f8f80', 'claude-code': '#b35900', codex: '#0969da', other: '#6e7781' },
  dark: { bg: '#0f1115', fg: '#eef1f5', muted: '#9aa3b2', grid: '#2f3540', hesdor: '#3ed6c1', 'claude-code': '#f0b44c', codex: '#6cb6ff', other: '#9aa3b2' },
}

/** Scatter: x = $ per solved task (log scale), y = pass@1, with 95% whiskers. One file per theme, like docs/assets. */
export function svgChart(summary, theme = 'light') {
  const T = THEMES[theme]
  const W = 860, H = 520, L = 80, R = 200, TOP = 56, B = 70
  const pw = W - L - R, ph = H - TOP - B
  const pts = summary.contenders.filter((c) => c.costPerSolved != null && c.pass1 != null)
  const skipped = summary.contenders.filter((c) => !pts.includes(c))
  const xsAll = pts.flatMap((c) => [c.costPerSolved, ...(c.costPerSolvedCI ?? [])]).filter((x) => x != null && x > 0)
  let lo = xsAll.length ? Math.min(...xsAll) : 0.01, hi = xsAll.length ? Math.max(...xsAll) : 10
  const ticks = []
  for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)) + 1; e++) for (const m of [1, 2, 5]) ticks.push(m * 10 ** e)
  lo = Math.max(...ticks.filter((t) => t <= lo * 0.8))
  hi = Math.min(...ticks.filter((t) => t >= hi * 1.25))
  const x = (v) => L + ((Math.log10(Math.min(Math.max(v, lo), hi)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * pw
  const y = (p) => TOP + (1 - p) * ph
  const color = (c) => T[c.agent] ?? T.other
  const font = 'font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif"'
  const o = []
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${xmlEsc(`Pass rate versus dollars per solved task, ${summary.dataset}`)}">`)
  o.push(`<rect width="${W}" height="${H}" fill="${T.bg}"/>`)
  o.push(`<text x="${L}" y="30" ${font} font-size="17" font-weight="600" fill="${T.fg}">${xmlEsc(`Pass@1 vs $ per solved task: ${summary.dataset}, k=${summary.k}`)}</text>`)
  for (const t of ticks.filter((t) => t >= lo && t <= hi)) {
    o.push(`<line x1="${x(t).toFixed(1)}" y1="${TOP}" x2="${x(t).toFixed(1)}" y2="${TOP + ph}" stroke="${T.grid}" stroke-width="1"/>`)
    o.push(`<text x="${x(t).toFixed(1)}" y="${TOP + ph + 20}" ${font} font-size="12" fill="${T.muted}" text-anchor="middle">${xmlEsc(usd(t).replace(/\.?0+$/, ''))}</text>`)
  }
  for (let p = 0; p <= 1.0001; p += 0.2) {
    o.push(`<line x1="${L}" y1="${y(p).toFixed(1)}" x2="${L + pw}" y2="${y(p).toFixed(1)}" stroke="${T.grid}" stroke-width="1"/>`)
    o.push(`<text x="${L - 10}" y="${(y(p) + 4).toFixed(1)}" ${font} font-size="12" fill="${T.muted}" text-anchor="end">${Math.round(p * 100)}%</text>`)
  }
  o.push(`<text x="${L + pw / 2}" y="${H - 22}" ${font} font-size="13" fill="${T.fg}" text-anchor="middle">$ per solved task (log scale, lower is better)</text>`)
  o.push(`<text x="20" y="${TOP + ph / 2}" ${font} font-size="13" fill="${T.fg}" text-anchor="middle" transform="rotate(-90 20 ${TOP + ph / 2})">pass@1 (higher is better)</text>`)
  const placed = []
  for (const c of [...pts].sort((a, b) => b.pass1 - a.pass1)) {
    const cx = x(c.costPerSolved), cy = y(c.pass1), col = color(c)
    if (c.pass1CI) o.push(`<line x1="${cx.toFixed(1)}" y1="${y(c.pass1CI[1]).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(c.pass1CI[0]).toFixed(1)}" stroke="${col}" stroke-width="1.5" opacity="0.6"/>`)
    if (c.costPerSolvedCI) {
      const [a, b] = c.costPerSolvedCI
      o.push(`<line x1="${x(a ?? hi).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${x(b ?? hi).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${col}" stroke-width="1.5" opacity="0.6"/>`)
    }
    o.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${col}"><title>${xmlEsc(`${c.id}: ${pct(c.pass1)}, ${usd(c.costPerSolved)} per solved task`)}</title></circle>`)
    // shortcut: greedy label placement (estimated text width, push down until free); fine for a handful of contenders.
    const lw = c.id.length * 7.6
    let ly = cy - 8
    while (placed.some((p) => Math.abs(p.y - ly) < 15 && p.x < cx + 10 + lw && cx + 10 < p.x + p.w)) ly += 15
    placed.push({ x: cx + 10, y: ly, w: lw })
    o.push(`<text x="${(cx + 10).toFixed(1)}" y="${ly.toFixed(1)}" ${font} font-size="13" font-weight="600" fill="${T.fg}">${xmlEsc(c.id)}</text>`)
  }
  let ly = TOP + 6
  for (const [agent, label] of [['hesdor', 'Hesdor'], ['claude-code', 'Claude Code'], ['codex', 'Codex CLI'], ['other', 'other']]) {
    if (!summary.contenders.some((c) => (T[c.agent] ? c.agent : 'other') === agent)) continue
    o.push(`<circle cx="${L + pw + 30}" cy="${ly}" r="5" fill="${T[agent]}"/><text x="${L + pw + 42}" y="${ly + 4}" ${font} font-size="12" fill="${T.fg}">${label}</text>`)
    ly += 22
  }
  if (skipped.length) o.push(`<text x="${L + pw + 24}" y="${ly + 16}" ${font} font-size="11" fill="${T.muted}">${xmlEsc(`Not plotted (0 solved): ${skipped.map((c) => c.id).join(', ')}`)}</text>`)
  o.push(`<text x="${L + pw + 24}" y="${TOP + ph}" ${font} font-size="11" fill="${T.muted}">Whiskers: 95% bootstrap CI</text>`)
  o.push('</svg>')
  return o.join('\n') + '\n'
}

export function writeReport(summary, out) {
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  writeFileSync(join(out, 'results.md'), markdown(summary))
  writeFileSync(join(out, 'chart-light.svg'), svgChart(summary, 'light'))
  writeFileSync(join(out, 'chart-dark.svg'), svgChart(summary, 'dark'))
  return ['summary.json', 'results.md', 'chart-light.svg', 'chart-dark.svg'].map((f) => join(out, f))
}

// ---------- main ----------

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--out')
  if (!file) {
    console.error('usage: node scripts/bench/matrix.mjs <spec.json> [--execute | --aggregate] [--out <dir>]')
    process.exit(2)
  }
  const spec = loadSpec(file)
  const outIdx = argv.indexOf('--out')
  const out = outIdx >= 0 ? resolve(argv[outIdx + 1]) : join(spec.jobsDir, `${spec.name}-report`)
  if (argv.includes('--execute')) {
    for (const c of spec.contenders) {
      const cmd = harborCommand(spec, c)
      console.log(`\n$ ${formatCommand(cmd)}`)
      const env = { ...process.env, ...cmd.env }
      if (cmd.env.PYTHONPATH) env.PYTHONPATH = [join(root, cmd.env.PYTHONPATH), process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
      const r = spawnSync('harbor', cmd.args, { cwd: root, env, stdio: 'inherit' })
      if (r.error) throw new Error(`could not start harbor (${r.error.message}); install it with: uv tool install harbor`)
      if (r.status !== 0) console.error(`harbor exited ${r.status} for ${c.id}; continuing (rerun --execute to resume that job)`)
    }
  } else if (!argv.includes('--aggregate')) {
    dryRun(spec)
    console.log('\n# dry run: nothing was executed. Add --execute to run (paid model calls), --aggregate to summarize existing jobs.')
    return
  }
  const summary = aggregate(spec)
  for (const c of summary.contenders) if (c.missing) console.error(`no job folder for ${c.id} (${c.job})`)
  const files = writeReport(summary, out)
  console.log(markdown(summary))
  console.log(files.join('\n'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
