import { helpText, parseArgs, VERSION } from './args.js'
// Every command is imported lazily (the bundle is code-split): --version and --help load only args.js,
// and only the command that runs pays for agent-core, providers, the SDKs or Ink.
const headless = () => import('./headless.js')
const setup = () => import('./setup.js')

export { VERSION }

async function main(): Promise<void> {
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}\n\n${helpText()}`)
    process.exitCode = 1
    return
  }

  if (parsed.flags.version) {
    console.log(`hesdor ${VERSION}`)
    return
  }
  if (parsed.flags.help) {
    console.log(helpText())
    return
  }

  switch (parsed.command) {
    case 'init': {
      const { printInitResult, runInit } = await import('./init.js')
      printInitResult(await runInit(parsed.flags.force))
      return
    }
    case 'doctor':
      process.exitCode = await (await import('./doctor.js')).runDoctor(parsed.flags)
      return
    case 'setup':
      process.exitCode = await (await setup()).runSetup()
      return
    case 'pricing':
      process.exitCode = (await import('./pricing.js')).runPricing()
      return
    case 'model':
      process.exitCode = await (await setup()).runModelCommand(parsed.prompt, parsed.flags)
      return
    case 'provider':
      process.exitCode = await (await setup()).runProviderCommand(parsed.prompt)
      return
    case 'auth':
      process.exitCode = await (await import('./auth.js')).runAuthCommand(parsed.prompt)
      return
    case 'login':
      process.exitCode = await (await import('./chatgpt-login.js')).runLoginCommand(parsed.prompt)
      return
    case 'logout':
      process.exitCode = await (await import('./chatgpt-login.js')).runLogoutCommand(parsed.prompt)
      return
    case 'policy':
      process.exitCode = await (await import('./policy-cmd.js')).runPolicyCommand(parsed.args ?? [])
      return
    case 'mcp':
      process.exitCode = await (await import('./mcp-cmd.js')).runMcpCommand(parsed.args ?? [])
      return
    case 'config':
      process.exitCode = await (await import('./config-layers.js')).runConfigCommand(parsed.args ?? [])
      return
    case 'checkpoints':
      process.exitCode = await (await import('./checkpoints-cmd.js')).runCheckpointsCommand(parsed.args ?? [])
      return
    case 'export':
      process.exitCode = await (await import('./export.js')).runExport(parsed.prompt, parsed.flags)
      return
    case 'import':
      process.exitCode = await (await import('./import.js')).runImport(parsed.prompt, parsed.flags)
      return
    case 'upgrade':
      process.exitCode = await (await import('./update.js')).runUpgrade()
      return
    case 'acp':
      // Lazy: keeps the ACP SDK out of every other command's startup.
      process.exitCode = await (await import('./acp.js')).runAcp(parsed.flags)
      return
    case 'run':
      process.exitCode = await (await headless()).runHeadless('build', parsed.prompt, parsed.flags)
      return
    case 'ask':
      process.exitCode = await (await headless()).runHeadless('ask', parsed.prompt, parsed.flags)
      return
    case 'plan':
      process.exitCode = await (await headless()).runHeadless('plan', parsed.prompt, parsed.flags)
      return
    case 'review':
      process.exitCode = await (await import('./review.js')).runReview(parsed.prompt, parsed.flags)
      return
    case 'interactive':
      // `hesdor "<prompt>"` opens the TUI and immediately starts that task.
      // Lazy: Ink/React cost ~0.5 s to load, which headless runs, doctor, --version and --help skip.
      process.exitCode = await (await import('./interactive.js')).startInteractive(parsed.flags, parsed.prompt || undefined)
      return
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exitCode = 1
})
