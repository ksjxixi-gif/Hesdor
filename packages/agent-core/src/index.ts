export { ToolRegistry, createDefaultRegistry } from './registry.js'
export { runAgentLoop, DEFAULT_MAX_STEPS } from './loop.js'
export type { AgentLoopOptions } from './loop.js'
export { safeResolve, isInside, toRel, PathSafetyError } from './paths.js'
export { GitIgnoreMatcher, DEFAULT_IGNORES } from './ignore.js'
export {
  findGitRoot,
  getBranch,
  getStatus,
  diffHead,
  logOneline,
  runGit,
  GitError,
} from './git.js'
export type { GitStatusInfo } from './git.js'
export { discoverRepo } from './context.js'
export type { RepoContextInfo, ToolContext, ApprovalRequest } from './context.js'
export { buildSystemPrompt } from './prompt.js'
export {
  riskAllowedInMode,
  assertRiskAllowed,
  classifyCommand,
  PermissionDeniedError,
} from './policy.js'
export type { CommandClassification } from './policy.js'
export { execStreaming, killChild } from './exec.js'
export type { ExecOptions, ExecResult } from './exec.js'
export { hasRipgrep } from './tools/search.js'
export type { SearchResult } from './tools/search.js'
export { defineTool } from './tools/types.js'
export type { Tool, AnyTool, ExternalTool } from './tools/types.js'
export { undoLastChange, redoLastChange } from './undo.js'
export type { FileSnapshot } from './context.js'
export { loadPluginsFrom, hesdorGlobalDir } from './plugins.js'
export type { LoadedPlugin, PluginHooks, PluginBeforeResult, PluginWarning } from './plugins.js'
export { loadCommandsFrom } from './commands.js'
export type { CustomCommand } from './commands.js'
export { loadSkillsFrom, createReadSkillTool, skillsSummary } from './skills.js'
export type { SkillInfo } from './skills.js'
export { McpClient } from './mcp/client.js'
export { registerMcpServers } from './mcp/register.js'
export type { McpServerConfig, McpToolDef, McpCallResult } from './mcp/client.js'
export type { RegisteredMcpServer } from './mcp/register.js'
