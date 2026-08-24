import { helpText, parseArgs, VERSION } from './args.js'
import { runDoctor } from './doctor.js'
import { printInitResult, runInit } from './init.js'
import { runHeadless } from './headless.js'
import { startInteractive } from './interactive.js'
import { runModelCommand, runProviderCommand, runSetup } from './setup.js'
import { runPricing } from './pricing.js'

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
    case 'init':
      printInitResult(await runInit(parsed.flags.force))
      return
    case 'doctor':
      process.exitCode = await runDoctor(parsed.flags)
      return
    case 'setup':
      process.exitCode = await runSetup()
      return
    case 'pricing':
      process.exitCode = runPricing()
      return
    case 'model':
      process.exitCode = await runModelCommand(parsed.prompt)
      return
    case 'provider':
      process.exitCode = await runProviderCommand(parsed.prompt)
      return
    case 'run':
      process.exitCode = await runHeadless('build', parsed.prompt, parsed.flags)
      return
    case 'ask':
      process.exitCode = await runHeadless('ask', parsed.prompt, parsed.flags)
      return
    case 'plan':
      process.exitCode = await runHeadless('plan', parsed.prompt, parsed.flags)
      return
    case 'interactive':
      // `hesdor "<prompt>"` opens the TUI and immediately starts that task.
      process.exitCode = await startInteractive(parsed.flags, parsed.prompt || undefined)
      return
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exitCode = 1
})
