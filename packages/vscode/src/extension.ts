import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as vscode from 'vscode'
import type * as acp from '@agentclientprotocol/sdk'
import { NPX_FALLBACK, cmdQuote, resolveCommand, startAgent } from './agent.js'
import type { AgentProcess, Command } from './agent.js'
import { readTextFile, writeTextFile } from './fs-handlers.js'
import type { EditorFiles } from './fs-handlers.js'
import { addPermission, answerPermission, applyUpdate, initialState, permissionResponse } from './view-model.js'
import type { Diff, FromView, ToView, ViewState } from './view-model.js'

const DIFF_SCHEME = 'hesdor-diff'
/** ACP auth_required: no provider key yet. */
const AUTH_REQUIRED = -32000

export function activate(context: vscode.ExtensionContext): void {
  const chat = new ChatController(context)
  context.subscriptions.push(
    chat,
    vscode.window.registerWebviewViewProvider('hesdor.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, chat.diffDocs),
    vscode.commands.registerCommand('hesdor.newSession', () => chat.newSession()),
    vscode.commands.registerCommand('hesdor.cancel', () => chat.cancel()),
    vscode.commands.registerCommand('hesdor.addSelection', () => chat.addSelection()),
    vscode.commands.registerCommand('hesdor.setup', () => chat.runSetup()),
  )
}

export function deactivate(): void {}

/** Virtual documents for the before/after sides of a proposed change. */
class DiffDocs implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>()
  private next = 0
  uriFor(text: string, file: string, side: 'before' | 'after'): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${this.next++}/${side}/${path.basename(file)}` })
    this.texts.set(uri.toString(), text)
    return uri
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? ''
  }
}

class ChatController implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly diffDocs = new DiffDocs()
  private view: vscode.WebviewView | undefined
  private state: ViewState = initialState()
  private agent: AgentProcess | undefined
  private starting: Promise<AgentProcess> | undefined
  private sessionId: string | undefined
  private nextPermission = 0
  private readonly pending = new Map<number, { options: acp.PermissionOption[]; resolve: (r: acp.RequestPermissionResponse) => void }>()
  private attached: acp.EmbeddedResourceResource[] = []
  private postTimer: ReturnType<typeof setTimeout> | undefined
  private readonly log = vscode.window.createOutputChannel('Hesdor')

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    for (const p of this.pending.values()) p.resolve({ outcome: { outcome: 'cancelled' } })
    this.agent?.child.kill()
    this.log.dispose()
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist')
    view.webview.options = { enableScripts: true, localResourceRoots: [media, dist] }
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css'))
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'))
    view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Hesdor</title>
</head>
<body>
<header>
  <label for="mode">Mode</label>
  <select id="mode"></select>
  <button id="new" type="button" title="Start a new session">New</button>
  <button id="cancel" type="button" title="Stop the running turn">Stop</button>
</header>
<main id="log" role="log" aria-label="Conversation"></main>
<section id="plan" aria-label="Plan"></section>
<footer>
  <div id="context"></div>
  <textarea id="input" rows="3" aria-label="Message Hesdor" placeholder="Ask Hesdor… (Enter to send, Shift+Enter for a new line)"></textarea>
  <button id="send" type="button">Send</button>
</footer>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`
    view.webview.onDidReceiveMessage((m: FromView) => void this.onMessage(m).catch((err) => this.fail(err)))
  }

  private post(): void {
    // shortcut: posts the whole state, at most every 50 ms; send deltas if long sessions get slow.
    this.postTimer ??= setTimeout(() => {
      this.postTimer = undefined
      void this.view?.webview.postMessage({ type: 'state', state: this.state } satisfies ToView)
    }, 50)
  }

  private async onMessage(m: FromView): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.post()
      case 'prompt':
        return this.prompt(m.text)
      case 'cancel':
        return this.cancel()
      case 'newSession':
        return this.newSession()
      case 'setMode':
        return this.setMode(m.modeId)
      case 'permission': {
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        p.resolve(permissionResponse(p.options, m.optionId))
        answerPermission(this.state, m.id, m.optionId)
        return this.post()
      }
      case 'showDiff': {
        const item = this.state.items[m.item]
        const diff = item && (item.kind === 'tool' || item.kind === 'permission') ? item.diffs[m.diff] : undefined
        if (diff) await this.showDiff(diff)
        return
      }
      case 'clearContext':
        this.attached = []
        this.state.context = []
        return this.post()
      case 'setup':
        return this.runSetup()
    }
  }

  private fail(err: unknown): void {
    const text = err instanceof Error ? err.message : String(err)
    const setup = typeof err === 'object' && err !== null && 'code' in err && err.code === AUTH_REQUIRED
    this.log.appendLine(`error: ${text}`)
    this.state.items.push({ kind: 'error', text, ...(setup ? { setup } : {}) })
    this.post()
  }

  private command(): Command {
    return resolveCommand(vscode.workspace.getConfiguration('hesdor').get<string>('path', 'hesdor'))
  }

  private cwd(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) throw new Error('Open a folder first: Hesdor works on a workspace.')
    return folder.uri.fsPath
  }

  /** The running agent, started on first use. */
  private async ensureAgent(): Promise<AgentProcess> {
    if (this.agent) return this.agent
    this.starting ??= (async () => {
      const cmd = this.command()
      if (cmd === NPX_FALLBACK) this.log.appendLine('`hesdor` not found on PATH: using npx (set hesdor.path to use an installed CLI)')
      const args = vscode.workspace.getConfiguration('hesdor').get<string[]>('args', [])
      const agent = await startAgent(cmd, args, this.cwd(), {
        update: (n) => {
          if (n.sessionId !== this.sessionId) return
          applyUpdate(this.state, n.update)
          this.post()
        },
        permission: (req, signal) => this.askPermission(req, signal),
        readTextFile: (params) => readTextFile(editorFiles, params),
        writeTextFile: (params) => writeTextFile(editorFiles, params),
        log: (line) => this.log.appendLine(line),
      })
      void agent.connection.closed.then(() => {
        if (this.agent !== agent) return
        this.agent = undefined
        this.sessionId = undefined
        if (this.state.busy) this.fail(new Error('Hesdor stopped; see the Hesdor output channel. Send again to restart it.'))
        this.state.busy = false
        this.post()
      })
      this.agent = agent
      return agent
    })().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async ensureSession(): Promise<{ agent: AgentProcess; sessionId: string }> {
    const agent = await this.ensureAgent()
    if (!this.sessionId) {
      const res = await agent.connection.agent.request('session/new', { cwd: this.cwd(), mcpServers: [] })
      this.sessionId = res.sessionId
      this.state.modes = res.modes?.availableModes ?? []
      if (res.modes) this.state.mode = res.modes.currentModeId
      this.post()
    }
    return { agent, sessionId: this.sessionId }
  }

  private async prompt(text: string): Promise<void> {
    if (!text.trim() || this.state.busy) return
    this.state.items.push({ kind: 'user', text })
    this.state.busy = true
    this.post()
    const context = this.attached
    this.attached = []
    this.state.context = []
    try {
      const { agent, sessionId } = await this.ensureSession()
      const prompt: acp.ContentBlock[] = [{ type: 'text', text }, ...context.map((resource) => ({ type: 'resource' as const, resource }))]
      const res = await agent.connection.agent.request('session/prompt', { sessionId, prompt })
      if (res.stopReason === 'cancelled') this.state.items.push({ kind: 'notice', severity: 'info', text: 'Stopped.' })
      else if (res.stopReason === 'max_turn_requests') this.state.items.push({ kind: 'notice', severity: 'warning', text: 'Stopped at the step limit.' })
    } catch (err) {
      this.fail(err)
    } finally {
      this.state.busy = false
      this.post()
    }
  }

  async cancel(): Promise<void> {
    if (this.agent && this.sessionId) await this.agent.connection.agent.notify('session/cancel', { sessionId: this.sessionId })
  }

  async newSession(): Promise<void> {
    await this.cancel()
    for (const p of this.pending.values()) p.resolve({ outcome: { outcome: 'cancelled' } })
    this.pending.clear()
    this.sessionId = undefined
    this.state = { ...initialState(), context: this.state.context }
    this.post()
  }

  private async setMode(modeId: string): Promise<void> {
    this.state.mode = modeId
    this.post()
    const { agent, sessionId } = await this.ensureSession()
    await agent.connection.agent.request('session/set_mode', { sessionId, modeId })
  }

  private askPermission(req: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const id = this.nextPermission++
    addPermission(this.state, id, req)
    this.post()
    const first = this.state.items.at(-1)
    if (first?.kind === 'permission' && first.diffs[0]) void this.showDiff(first.diffs[0])
    void vscode.commands.executeCommand('hesdor.chat.focus')
    return new Promise((resolve) => {
      this.pending.set(id, { options: req.options, resolve })
      signal.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return
        answerPermission(this.state, id, null)
        this.post()
        resolve({ outcome: { outcome: 'cancelled' } })
      })
    })
  }

  private async showDiff(diff: Diff): Promise<void> {
    const before = this.diffDocs.uriFor(diff.oldText ?? '', diff.path, 'before')
    const after = this.diffDocs.uriFor(diff.newText, diff.path, 'after')
    const label = vscode.workspace.asRelativePath(diff.path)
    await vscode.commands.executeCommand('vscode.diff', before, after, `${label} (proposed by Hesdor)`, { preview: true })
  }

  addSelection(): void {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.selection.isEmpty) return
    const { start, end } = editor.selection
    const text = editor.document.getText(editor.selection)
    this.attached.push({ uri: editor.document.uri.toString(), text, ...(editor.document.languageId ? { mimeType: `text/x-${editor.document.languageId}` } : {}) })
    this.state.context.push(`${vscode.workspace.asRelativePath(editor.document.uri)}:${start.line + 1}-${end.line + 1}`)
    this.post()
    void vscode.commands.executeCommand('hesdor.chat.focus')
  }

  runSetup(): void {
    const cmd = this.command()
    const terminal = vscode.window.createTerminal({ name: 'Hesdor setup', ...(vscode.workspace.workspaceFolders?.[0] ? { cwd: this.cwd() } : {}) })
    // A path with spaces must be quoted for the shell; npx stays bare.
    terminal.sendText([cmd.command === NPX_FALLBACK.command ? cmd.command : cmdQuote(cmd.command), ...cmd.args, 'setup'].join(' '))
    terminal.show()
  }
}

const editorFiles: EditorFiles = {
  roots: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  openText: (file) => {
    const target = vscode.Uri.file(file).toString()
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === target)?.getText()
  },
  readDisk: (file) => readFile(file, 'utf8'),
  write: async (file, content) => {
    const uri = vscode.Uri.file(file)
    let doc: vscode.TextDocument
    try {
      doc = await vscode.workspace.openTextDocument(uri)
    } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8')) // a new file: nothing to undo
      return
    }
    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content)
    if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) throw new Error(`could not write ${file} in the editor`)
  },
}
