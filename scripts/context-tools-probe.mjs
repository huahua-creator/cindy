// Synthetic native-Claude probe. Never load real providers, credentials or user settings.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

const self = fileURLToPath(import.meta.url);
const description = 'Synthetic read-only context probe. '.repeat(8);
const large = process.argv.includes('--large');
const samples = Array.from({ length: large ? 114 : 1 }, (_, i) => ({
  name: i ? `sample_${i}` : 'sample', description, inputSchema: { type: 'object', properties: {} },
}));
if (process.argv.includes('--synthetic-mcp')) {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result;
    if (request.method === 'initialize') result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' },
    };
    else if (request.method === 'tools/list') result = { tools: samples };
    else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'synthetic' }] };
    else if (request.method === 'ping') result = {};
    else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } }) + '\n');
      continue;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
} else {
  const root = await mkdtemp(path.join(tmpdir(), 'cindy-context-probe-'));
  const binary = path.resolve(path.dirname(self), '../apps/claude-code-bin/win32-x64/claude.exe');
  const sentinel = 'SYNTHETIC_SAFETY_RULE_MUST_REMAIN';
  const results = [];
  const envBase = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));

  async function run(source, selection) {
    const dir = path.join(root, `${source}-${selection}`);
    const profile = path.join(dir, 'profile');
    const cwd = path.join(dir, 'work');
    await mkdir(profile, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, 'CLAUDE.md'), sentinel);
    const configPath = path.join(cwd, '.mcp.json');
    const projectConfig = JSON.stringify({ mcpServers: source === 'host' ? {} : {
      probe_project: { command: process.execPath, args: [self, '--synthetic-mcp', ...(large ? ['--large'] : [])] },
    } });
    await writeFile(configPath, projectConfig);
    const captures = [];
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/messages') {
        res.writeHead(404).end(); return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      captures.push({
        tools: (body.tools ?? []).map(t => t.name),
        schemaBytes: Buffer.byteLength(JSON.stringify(body.tools ?? [])),
        sentinel: JSON.stringify([body.system, body.messages]).includes(sentinel),
        deferred: (body.tools ?? []).filter(t => t.defer_loading).length,
      });
      const message = { id: 'msg_synthetic', type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      event('message_stop', {});
      res.end();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { ...envBase, USERPROFILE: profile, CLAUDE_CONFIG_DIR: profile,
      APPDATA: profile, LOCALAPPDATA: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile,
      XDG_DATA_HOME: profile, TEMP: profile, TMP: profile, TMPDIR: profile,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ANTHROPIC_API_KEY: 'synthetic-invalid-key', ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    };
    const targets = source === 'host' ? ['probe_bulk'] : source === 'project' ? ['probe_project'] : ['probe_bulk', 'probe_project'];
    const disallowedTools = selection === 'all' ? [] : targets.map(name =>
      `mcp__${name}__${selection === 'exact' ? 'sample' : '*'}`);
    const mk = name => createSdkMcpServer({ name, version: '1', tools: (name === 'probe_bulkish' ? samples.slice(0, 1) : samples)
      .map(sample => tool(sample.name, description, {}, async () => ({ content: [{ type: 'text', text: 'synthetic' }] }))) });
    const hostServers = { probe_bulkish: mk('probe_bulkish'), ...(source !== 'project' ? { probe_bulk: mk('probe_bulk') } : {}) };
    const selectedHostServers = Object.fromEntries(Object.entries(hostServers)
      .filter(([name]) => selection !== 'filtered' || !targets.includes(name)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let child;
    let q;
    try {
      q = query({ prompt: 'Reply OK without calling tools.', options: {
        cwd, env, pathToClaudeCodeExecutable: binary, model: 'claude-sonnet-4-6',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['project'], settings: { enableAllProjectMcpServers: true },
        persistSession: false, maxTurns: 1, abortController: controller, disallowedTools,
        mcpServers: selectedHostServers,
        canUseTool: async () => ({ behavior: 'deny', message: 'Synthetic probe disallows execution' }),
        spawnClaudeCodeProcess: options => {
          // SDK merges ambient env: replace it at the actual process boundary.
          child = spawn(options.command, options.args, { cwd, env, signal: options.signal, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
          child.stderr.resume();
          return child;
        },
      } });
      for await (const event of q) {
        if (event.type === 'result' && event.is_error) throw new Error(`native result: ${event.subtype}`);
      }
      assert.equal(captures.length, 1, 'one synthetic first-turn request');
      const capture = captures[0];
      assert(capture.sentinel, 'project safety sentinel retained');
      assert(capture.tools.includes('Read'), 'base Read retained');
      assert(capture.tools.includes('mcp__probe_bulkish__sample'), 'near-prefix keep tool retained');
      const selectionEffective = targets.every(target => capture.tools.includes(`mcp__${target}__sample`) === (selection === 'all'));
      if (selection === 'filtered') assert(selectionEffective, 'two-layer filter must remove both sources');
      assert.equal(await readFile(configPath, 'utf8'), projectConfig, 'project MCP config unchanged');
      results.push({ source, selection, selectionEffective, ...capture });
      console.log(JSON.stringify({ source, selection, selectionEffective, toolCount: capture.tools.length, schemaBytes: capture.schemaBytes, sentinel: capture.sentinel }));
    } finally {
      clearTimeout(timeout);
      q?.close();
      if (child && child.exitCode === null) child.kill();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
  for (const source of (large ? ['combined'] : ['host', 'project', 'combined'])) {
    for (const selection of (large ? ['all', 'filtered'] : ['all', 'exact', 'wildcard', 'filtered'])) await run(source, selection);
  }
  await writeFile(path.join(root, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(`Synthetic summary: ${path.join(root, 'summary.json')}`);
}
