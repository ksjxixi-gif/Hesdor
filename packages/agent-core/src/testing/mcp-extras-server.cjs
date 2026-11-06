// 2025-era stdio MCP server for tests: annotated tools, prompts, resources and an elicitation round trip.
const big = 'x'.repeat(150000)
let buf = ''
let pending
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')

function handle(msg) {
  const reply = (result) => out({ id: msg.id, result })
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'extras', version: '1' } })
    case 'tools/list':
      return reply({
        tools: [
          { name: 'zap', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
          { name: 'look', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
          { name: 'fetch', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: true } },
          { name: 'ask', inputSchema: { type: 'object' } },
        ],
      })
    case 'prompts/list':
      return reply({ prompts: [{ name: 'greet', description: 'Say hello', arguments: [{ name: 'who', required: true }, { name: 'tone' }] }] })
    case 'prompts/get': {
      const a = msg.params.arguments || {}
      return reply({ messages: [{ role: 'user', content: { type: 'text', text: 'Hello ' + a.who + (a.tone ? ' (' + a.tone + ')' : '') } }] })
    }
    case 'resources/list':
      return reply({ resources: [{ uri: 'mem://big', name: 'big' }, { uri: 'mem://small', name: 'small' }] })
    case 'resources/read':
      return reply({ contents: [{ uri: msg.params.uri, text: msg.params.uri === 'mem://big' ? big : 'small body' }] })
    case 'tools/call':
      if (msg.params.name === 'ask') {
        pending = msg.id
        return out({ id: 'srv-elicit', method: 'elicitation/create', params: { message: 'Pick a name', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } })
      }
      return reply({ content: [{ type: 'text', text: 'ran ' + msg.params.name }] })
  }
  if (msg.id === 'srv-elicit') {
    const text = msg.result ? 'elicit:' + msg.result.action + JSON.stringify(msg.result.content || {}) : 'elicit:error ' + msg.error.code
    return out({ id: pending, result: { content: [{ type: 'text', text }] } })
  }
  if (msg.id !== undefined && msg.method) out({ id: msg.id, error: { code: -32601, message: 'Method not found' } })
}
