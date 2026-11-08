// node --test scripts/bench
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  aggregate, dryRun, formatCommand, harborCommand, loadSpec, markdown, passAtK, passHatK, priceFor, readJob,
  readTrial, selectTasks, svgChart, wilson, writeReport,
} from './matrix.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'hesdor-bench-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

// A Harbor TrialResult as written to <job>/<trial>/result.json (harbor/models/trial/result.py).
function trialResult({ task, reward = 1, exception = null, valid = exception == null, cost = 0.1, tokens = [1000, 800, 50], metadata = {} }) {
  const short = task.split('/').pop()
  return {
    id: crypto.randomUUID(),
    task_name: task,
    trial_name: `${short.slice(0, 32)}__${Math.random().toString(36).slice(2, 9)}`,
    trial_uri: `file:///jobs/${short}`,
    task_id: { org: 'terminal-bench', name: short, ref: 'sha256:0' },
    source: 'terminal-bench/terminal-bench-2-1',
    task_checksum: '0',
    config: {},
    agent_info: { name: 'hesdor', version: '0.2.0', model_info: { name: 'claude-sonnet-5', provider: 'anthropic' } },
    agent_result: { n_input_tokens: tokens[0], n_cache_tokens: tokens[1], n_output_tokens: tokens[2], cost_usd: cost, model_usage: null, rollout_details: null, metadata },
    verifier_result: exception && !valid ? null : { rewards: { reward } },
    exception_info: exception && { exception_type: exception, exception_message: 'x', exception_traceback: '', occurred_at: '2026-11-08T00:00:00Z' },
    started_at: '2026-11-08T00:00:00Z',
    finished_at: '2026-11-08T00:05:00Z',
    reward_valid: valid,
  }
}

function writeJob(jobsDir, name, trials, { running = 0 } = {}) {
  const dir = join(jobsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ id: 'job', n_total_trials: trials.length, stats: {} })) // job-level, ignored
  writeFileSync(join(dir, 'config.json'), '{}')
  for (const t of trials) {
    const r = trialResult(t)
    mkdirSync(join(dir, r.trial_name), { recursive: true })
    writeFileSync(join(dir, r.trial_name, 'result.json'), JSON.stringify(r))
  }
  for (let i = 0; i < running; i++) mkdirSync(join(dir, `running-task__run${i}`), { recursive: true })
}

test('pass@k and pass^k estimators', () => {
  assert.equal(passAtK(3, 1, 3), 1)
  assert.equal(passHatK(3, 1, 3), 0)
  near(passAtK(3, 2, 1), 2 / 3)
  near(passHatK(3, 2, 1), 2 / 3)
  near(passAtK(5, 2, 3), 0.9) // 1 - C(3,3)/C(5,3)
  near(passHatK(5, 4, 3), 0.4) // C(4,3)/C(5,3)
  assert.equal(passAtK(3, 0, 3), 0)
  assert.equal(passHatK(3, 3, 3), 1)
})

test('Wilson interval', () => {
  const [a, b] = wilson(5, 10)
  near(a, 0.2366)
  near(b, 0.7634)
  const [z0, z1] = wilson(0, 10)
  assert.equal(z0, 0)
  near(z1, 0.2775)
  assert.deepEqual(wilson(0, 0), [0, 1])
})

test('aggregation: infra exclusion, zero solves, per-task outcomes', () => {
  const jobsDir = join(tmp, 'jobs')
  const T = (n) => `terminal-bench/task-${n}`
  writeJob(jobsDir, 'm-a', [
    ...[1, 1, 1].map((reward) => ({ task: T(1), reward })),
    ...[1, 0, 0].map((reward) => ({ task: T(2), reward })),
    { task: T(2), exception: 'ApiRateLimitError', cost: 0.05 }, // infra: excluded from rates, counted in cost
    ...[0, 0, 0].map(() => ({ task: T(3), exception: 'AgentAuthenticationError', cost: 0 })), // all infra: task not scored
    { task: T(4), reward: 0, exception: 'AgentTimeoutError', valid: true }, // a timeout is the agent's failure
  ], { running: 1 })
  writeJob(jobsDir, 'm-b', [1, 2].flatMap((n) => [0, 0, 0].map(() => ({ task: T(n), reward: 0, cost: 0.2 }))))

  const spec = {
    name: 'm', dataset: 'terminal-bench/terminal-bench-2-1', k: 3, jobsDir,
    contenders: [{ id: 'a', agent: 'hesdor', profile: 'economy' }, { id: 'b', agent: 'codex', model: 'openai/gpt-5.6-sol' }, { id: 'c', agent: 'claude-code', model: 'x/y' }],
  }
  const s = aggregate(spec)
  const [a, b, c] = s.contenders

  assert.equal(a.incomplete, 1)
  assert.equal(a.trials, 11)
  assert.equal(a.infraErrors, 4)
  assert.deepEqual(a.infraTypes, { ApiRateLimitError: 1, AgentAuthenticationError: 3 })
  assert.equal(a.tasks, 4)
  assert.equal(a.tasksScored, 3)
  assert.equal(a.tasksShortOfK, 1) // task-4 has a single valid trial
  near(a.pass1, (1 + 1 / 3 + 0) / 3)
  near(a.passAtK, (1 + 1 + 0) / 3)
  near(a.passHatK, (1 + 0 + 0) / 3)
  assert.equal(a.solvedTrials, 4)
  near(a.totalCost, 7 * 0.1 + 0.05)
  near(a.infraCost, 0.05)
  near(a.costPerSolved, (7 * 0.1) / 4)
  near(a.costPerTask, (7 * 0.1 + 0.05) / 4)
  assert.ok(a.pass1CI[0] <= a.pass1 && a.pass1 <= a.pass1CI[1])
  assert.ok(a.costPerSolvedCI[0] <= a.costPerSolved)
  const t2 = a.perTask['terminal-bench/task-2']
  assert.deepEqual([t2.n, t2.c, t2.infra], [3, 1, 1])
  near(t2.cost, 0.35)
  near(a.meanTokens.input, 1000)

  assert.equal(b.solvedTrials, 0)
  assert.equal(b.costPerSolved, null) // infinite, not divided by zero
  assert.equal(b.pass1, 0)
  assert.equal(c.missing, true)
  assert.equal(c.trials, 0)

  const md = markdown(s)
  assert.match(md, /\| a \| hesdor \| profile economy \| 3 \| 44\.4%/)
  assert.match(md, /\| b \| codex .*\| \$0\.600 \| ∞ \| 1\.0k \/ 800 \/ 50 \| 0 \|/)
  assert.match(md, /\| c \| claude-code \| x\/y \| 0 \| n\/a .*\| – \| ∞ \|/)
  assert.match(md, /\| terminal-bench\/task-2 \| 1\/3 \+1 \| 0\/3 \| – \|/)
  assert.ok(JSON.parse(JSON.stringify(s)).contenders[1].costPerSolved === null)

  const files = writeReport(s, join(tmp, 'report'))
  assert.equal(files.length, 4)
})

test('cost estimated from tokens when the agent reports none', () => {
  const r = trialResult({ task: 't', cost: null, tokens: [1_000_000, 900_000, 10_000] })
  const t = readTrial(r, { input: 2, output: 10, cacheRead: 0.2 })
  assert.equal(t.costSource, 'estimated')
  near(t.cost, 0.2 + 0.18 + 0.1)
  assert.equal(readTrial(r, null).costSource, 'unknown')
  assert.equal(readTrial(trialResult({ task: 't', metadata: { hesdor_profile: 'economy', hesdor_escalations: 2 } })).escalations, 2)
  // older results without reward_valid: no reward means infra
  const old = trialResult({ task: 't', exception: 'ApiError' })
  delete old.reward_valid
  assert.equal(readTrial(old).infra, true)
})

test('readJob on a missing folder', () => {
  assert.deepEqual(readJob(join(tmp, 'nope')), { trials: [], incomplete: 0, missing: true })
})

test('dry run: commands and estimate', () => {
  const spec = {
    name: 'smoke', dataset: 'terminal-bench/terminal-bench-2-1', k: 3, concurrency: 2, jobsDir: join(tmp, 'j'),
    tasks: ['terminal-bench/a', 'terminal-bench/b'], resources: { cpus: 2, memoryMb: 4096 }, extraArgs: ['-r', '2'],
    contenders: [
      { id: 'h-eco', agent: 'hesdor', profile: 'economy', priceAs: 'anthropic/claude-sonnet-5', ak: { max_budget_usd: 2 } },
      { id: 'h-son', agent: 'hesdor', model: 'anthropic/claude-sonnet-5' },
      { id: 'cc', agent: 'claude-code', model: 'anthropic/claude-sonnet-5' },
    ],
  }
  const h = harborCommand(spec, spec.contenders[0])
  assert.deepEqual(h.env, { PYTHONPATH: 'evals/harbor' })
  const args = h.args.join(' ')
  assert.match(args, /^run -d terminal-bench\/terminal-bench-2-1 -a hesdor_agent:Hesdor --ak max_steps=100 --ak profile=economy --ak max_budget_usd=2 -i terminal-bench\/a -i terminal-bench\/b -k 3 -n 2 --override-cpus 2 --override-memory-mb 4096 -o .+ --job-name smoke-h-eco -r 2$/)
  assert.ok(!args.includes(' -m '))
  assert.match(harborCommand(spec, spec.contenders[1]).args.join(' '), / -m anthropic\/claude-sonnet-5 --ak max_steps=100 /)
  const cc = harborCommand(spec, spec.contenders[2])
  assert.deepEqual(cc.env, {})
  assert.ok(!cc.args.includes('--ak'))
  assert.match(formatCommand({ args: ['run', 'a b', "it's"], env: { X: 'y' } }), /^X=y harbor run 'a b' 'it'\\''s'$/)

  const out = []
  const rows = dryRun(spec, (l) => out.push(l))
  assert.equal(out.filter((l) => l.startsWith('PYTHONPATH=evals/harbor harbor run')).length, 2)
  const price = priceFor('anthropic/claude-sonnet-5')
  if (price) {
    // 2 tasks x k=3 = 6 trials at the default token assumption, no cache
    near(rows[0][3], 6 * ((1_500_000 * price.input + 50_000 * price.output) / 1e6))
    assert.ok(rows[0][2] < rows[0][3])
  }
})

test('seeded task sample is reproducible', () => {
  const pool = Array.from({ length: 50 }, (_, i) => `t${i}`)
  const a = selectTasks({ sample: { n: 10, seed: 1, pool } })
  assert.deepEqual(a, selectTasks({ sample: { n: 10, seed: 1, pool: [...pool].reverse() } }))
  assert.notDeepEqual(a, selectTasks({ sample: { n: 10, seed: 2, pool } }))
  assert.equal(new Set(a).size, 10)
  assert.throws(() => selectTasks({ sample: { n: 51, pool } }))
  const f = join(tmp, 'pool.txt')
  writeFileSync(f, '# names\nt1\r\nt2\n\nt3\n')
  assert.deepEqual(selectTasks({ sample: { n: 3, pool: f } }), ['t1', 't2', 't3'])
})

test('spec validation', () => {
  const f = join(tmp, 'bad.json')
  writeFileSync(f, JSON.stringify({ name: 'x', dataset: 'd', contenders: [{ id: 'a', agent: 'codex' }] }))
  assert.throws(() => loadSpec(f), /model is required/)
  writeFileSync(f, JSON.stringify({ name: 'x', dataset: 'd', contenders: [{ id: 'a', agent: 'codex', model: 'm/x', profile: 'economy' }] }))
  assert.throws(() => loadSpec(f), /profile is only for agent "hesdor"/)
  writeFileSync(f, JSON.stringify({ name: 'x', dataset: 'd', jobsDir: 'j', contenders: [{ id: 'a', agent: 'hesdor', profile: 'economy' }] }))
  assert.equal(loadSpec(f).jobsDir, join(tmp, 'j'))
})

// Minimal XML well-formedness check: balanced tags, quoted attributes, no raw "&" or "<" in text.
function assertWellFormed(xml) {
  const stack = []
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g
  let last = 0
  for (const m of xml.matchAll(re)) {
    const text = xml.slice(last, m.index)
    assert.ok(!/[<>]/.test(text), `stray markup near: ${text.slice(0, 60)}`)
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text), `raw & in: ${text.slice(0, 60)}`)
    last = m.index + m[0].length
    if (!m[2]) continue
    if (m[1]) assert.equal(stack.pop(), m[2], `mismatched </${m[2]}>`)
    else if (!m[4]) stack.push(m[2])
    assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(m[3] ?? ''), `raw & in attributes of <${m[2]}>`)
  }
  assert.ok(!/[<>]/.test(xml.slice(last).trim()), 'trailing markup')
  assert.deepEqual(stack, [], 'unclosed tags')
}

test('SVG chart is well-formed in both themes', () => {
  const base = { costPerSolvedCI: [0.1, 0.5], pass1CI: [0.3, 0.6], perTask: {} }
  const summary = {
    dataset: 'a&b <tb>', k: 3,
    contenders: [
      { ...base, id: 'hesdor-economy', agent: 'hesdor', pass1: 0.42, costPerSolved: 0.21 },
      { ...base, id: 'claude-code', agent: 'claude-code', pass1: 0.55, costPerSolved: 1.9, costPerSolvedCI: [1.2, null] },
      { ...base, id: 'codex', agent: 'codex', pass1: 0.5, costPerSolved: 2.5 },
      { ...base, id: 'mini', agent: 'mini-swe-agent', pass1: 0, costPerSolved: null, costPerSolvedCI: null },
    ],
  }
  for (const theme of ['light', 'dark']) {
    const svg = svgChart(summary, theme)
    assertWellFormed(svg)
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    assert.match(svg, /a&amp;b &lt;tb&gt;/)
    assert.match(svg, /Not plotted \(0 solved\): mini/)
    assert.equal(svg.match(/<circle cx="[\d.]+" cy="[\d.]+" r="6"/g).length, 3)
    assert.ok(!/NaN|Infinity|undefined/.test(svg))
    assert.ok(!/@import|url\(|<link/.test(svg), 'no external fonts or resources')
  }
  assert.notEqual(svgChart(summary, 'light'), svgChart(summary, 'dark'))
  assertWellFormed(svgChart({ dataset: 'd', k: 3, contenders: [] }, 'light'))
})
