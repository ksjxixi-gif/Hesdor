// A tiny stdio MCP server for the /mcp screenshot: newline-delimited JSON-RPC with two tools, one prompt
// and one resource. It answers listings only; tool calls return a fixed text.
import { createInterface } from 'node:readline'

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
const results = {
  'tools/list': {
    tools: [
      { name: 'search_docs', description: 'Search the team docs', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
      { name: 'get_page', description: 'Read one docs page', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    ],
  },
  'prompts/list': { prompts: [{ name: 'summarize', description: 'Summarize a docs page' }] },
  'resources/list': { resources: [{ uri: 'docs://index', name: 'index' }] },
  'prompts/get': { messages: [{ role: 'user', content: { type: 'text', text: 'Summarize the docs index.' } }] },
  'tools/call': { content: [{ type: 'text', text: 'no results' }] },
  ping: {},
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return // notifications
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {}, prompts: {}, resources: {} },
      serverInfo: { name: 'docs', version: '1.0.0' },
    })
  } else if (msg.method in results) reply(msg.id, results[msg.method])
  else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not supported' } })}\n`)
})
