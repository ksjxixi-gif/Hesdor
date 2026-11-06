import path from 'node:path'
import { decideCommand, findGitRoot, ruleToString, tokenize, validateRules } from '@hesdor/agent-core'
import type { PermissionPolicy, PermissionRules } from '@hesdor/agent-core'
import { configDir, loadConfig, readJsonObject, saveConfig } from './config.js'
import { loadManagedSettings } from './config-layers.js'

/** Project rules file: `{ "ask": [...], "deny": [...] }`. It can only tighten. */
export const PROJECT_PERMISSIONS = path.join('.hesdor', 'permissions.json')

async function readProjectRules(root: string): Promise<PermissionRules> {
  const file = path.join(root, PROJECT_PERMISSIONS)
  return validateRules(await readJsonObject(file), file)
}

/**
 * Rules for a session: user config.json `permissions` plus the project's ask/deny rules.
 * A project `allow` list is dropped: loosening comes from user scope only. Malformed rules
 * throw, so a typo never silently removes a deny rule.
 */
export async function loadPermissions(root: string): Promise<PermissionPolicy> {
  const user = validateRules((await loadConfig()).permissions, path.join(configDir(), 'config.json'))
  const project = await readProjectRules(root)
  // Managed ask/deny rules ride in the tighten-only slot, which nothing can loosen.
  const managed = (await loadManagedSettings()).permissions ?? {}
  const ask = [...(project.ask ?? []), ...(managed.ask ?? [])]
  const deny = [...(project.deny ?? []), ...(managed.deny ?? [])]
  return { user, project: { ...(ask.length ? { ask } : {}), ...(deny.length ? { deny } : {}) } }
}

const sameArgv = (rule: unknown, argv: string[]): boolean =>
  (Array.isArray(rule) ? rule : typeof rule === 'string' ? tokenize(rule) : []).join('\0') === argv.join('\0')

/**
 * "Always allow" from an approval prompt: persist a user-scope allow rule for exactly this
 * argv (ApprovalRequest.argv) in config.json. Pass the running turn's policy as `live` so the
 * rule also applies for the rest of that turn.
 */
export async function addUserAllowRule(argv: string[], live?: PermissionPolicy): Promise<void> {
  if (argv.length === 0) throw new Error('cannot allow an empty command')
  const rules = validateRules((await loadConfig()).permissions, path.join(configDir(), 'config.json'))
  const allow = rules.allow ?? []
  if (!allow.some((r) => sameArgv(r, argv))) await saveConfig({ permissions: { ...rules, allow: [...allow, [...argv]] } })
  if (live && !live.user.allow?.some((r) => sameArgv(r, argv))) (live.user.allow ??= []).push([...argv])
}

/** `hesdor policy check <command...>`: print the decision for a command and the rule behind it. */
export async function runPolicyCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const [sub, ...words] = args
  if (sub !== 'check' || words.length === 0) {
    console.error('usage: hesdor policy check <command...>   e.g. hesdor policy check git push --force')
    return 1
  }
  const argv = words.length === 1 ? tokenize(words[0]!) : words
  const root = findGitRoot(cwd) ?? path.resolve(cwd)
  let policy: PermissionPolicy
  try {
    policy = await loadPermissions(root)
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  const d = decideCommand(argv, policy)
  const where =
    d.source === 'user' ? path.join(configDir(), 'config.json') : d.source === 'project' ? path.join(root, PROJECT_PERMISSIONS) : null
  const effect =
    d.action === 'allow'
      ? 'runs without asking'
      : d.action === 'deny'
        ? 'refused'
        : d.source === 'default'
          ? 'interactive (and --yes): asks first; headless without --yes: runs, since no rule covers it'
          : 'interactive: asks first; headless: refused unless --yes'
  console.log(`${d.action}  ${JSON.stringify(argv)}`)
  console.log(`  effect: ${effect}`)
  console.log(`  why:    ${d.rule !== undefined ? `${d.source} ${d.action} rule ${ruleToString(d.rule)}` : d.reason}`)
  if (where) console.log(`  from:   ${where}`)
  try {
    const raw = await readJsonObject<{ allow?: unknown }>(path.join(root, PROJECT_PERMISSIONS))
    if (raw.allow !== undefined) console.log(`  note:   allow rules in ${PROJECT_PERMISSIONS} are ignored; only your user config can allow`)
  } catch {
    // reported above
  }
  return 0
}
