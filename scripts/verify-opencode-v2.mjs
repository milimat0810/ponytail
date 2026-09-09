import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = path.resolve(process.argv[2] || fileURLToPath(new URL('../.opencode/v2', import.meta.url)));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ponytail-v2-'));
const requests = [];
let hold;
let subagentRequested = false;
const provider = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  requests.push(input);
  const primary = input.messages?.some((m) => m.role === 'system' && JSON.stringify(m.content).includes('PONYTAIL_V2_VERIFICATION'));
  if (hold && primary) {
    const pending = hold;
    hold = undefined;
    pending.started(input);
    await pending.release;
  }
  const completion = { id: 'probe', object: 'chat.completion', created: 1, model: 'probe',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  if (!input.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(completion));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  let chunks = [[{ role: 'assistant', content: 'OK' }, null], [{}, 'stop']];
  if (primary && !subagentRequested && JSON.stringify(input.messages.at(-1)).includes('SPAWN_PROBE')) {
    const tool = input.tools?.find((t) => t.function.name.includes('subagent'));
    assert.ok(tool, `No subagent tool: ${JSON.stringify(input.tools?.map((t) => t.function.name))}`);
    subagentRequested = true;
    const args = { agent: 'worker', description: 'Check inherited mode', prompt: 'Reply OK only.', background: false };
    chunks = [[{ tool_calls: [{ index: 0, id: 'probe-child', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] }, null], [{}, 'tool_calls']];
  }
  for (const [delta, finish_reason] of chunks) {
    res.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
});
provider.listen(0, '127.0.0.1');
await once(provider, 'listening');
const env = { ...process.env, HOME: root, PONYTAIL_DEFAULT_MODE: 'full' };
for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_')) delete env[key];
for (const name of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${name}_HOME`] = path.join(root, name.toLowerCase());
const configDir = path.join(env.XDG_CONFIG_HOME, 'opencode');
await fs.mkdir(configDir, { recursive: true });
await fs.writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({
  plugins: [plugin], model: 'test/probe', update: 'disable',
  default_agent: 'probe',
  agents: {
    probe: { mode: 'primary', system: 'PONYTAIL_V2_VERIFICATION. Reply OK only.' },
    worker: { mode: 'subagent', system: 'PONYTAIL_V2_CHILD. Reply OK only.', model: 'test/probe' },
  },
  providers: { test: {
    package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'test' },
    models: { probe: { name: 'Probe', limit: { context: 32000, output: 1000 },
      capabilities: { tools: true, input: ['text'], output: ['text'] } } },
  } },
}));
let server, url, authorization;
async function start() {
  server = spawn(process.env.OPENCODE_V2_BIN || 'opencode2', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 30000);
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Server exited ${code}: ${output}`)));
    const read = (chunk) => {
      output += chunk;
      const address = output.match(/server listening on (http:\/\/\S+)/);
      const password = output.match(/server password (\S+)/);
      if (!address || !password) return;
      url = address[1];
      authorization = `Basic ${Buffer.from(`opencode:${password[1]}`).toString('base64')}`;
      clearTimeout(timer);
      resolve();
    };
    server.stdout.on('data', read);
    server.stderr.on('data', read);
  });
  await api('/api/plugin/await-activation', {});
  const plugins = await api('/api/plugin');
  assert.ok(plugins.data.some((p) => p.id === 'ponytail'), JSON.stringify(plugins));
  const commands = await api('/api/command');
  assert.equal(commands.data.filter((c) => c.name.startsWith('ponytail')).length, 6);
  const skills = await api('/api/skill');
  assert.equal(skills.data.filter((s) => s.id.startsWith('ponytail')).length, 6);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  await exited;
}
async function api(endpoint, body) {
  const response = await fetch(url + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  assert.ok(response.ok, `${endpoint}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}
async function turn(session, mode, expected) {
  const before = requests.length;
  const endpoint = mode === null ? 'prompt' : 'command';
  await api(`/api/session/${session}/${endpoint}`, mode === null ? { text: 'Reply OK.' } : { command: 'ponytail', text: mode });
  await api(`/api/session/${session}/wait`, {});
  const outgoing = requests.slice(before).filter((r) => r.messages?.some((m) => ['system', 'developer'].includes(m.role) && JSON.stringify(m.content).includes('PONYTAIL_V2_VERIFICATION')));
  assert.ok(outgoing.length, `No model request for ${mode}; inspect ${root}`);
  for (const request of outgoing) {
    const system = request.messages.filter((m) => ['system', 'developer'].includes(m.role)).map((m) => JSON.stringify(m.content)).join('\n');
    if (expected === 'off') assert.doesNotMatch(system, /PONYTAIL MODE ACTIVE/);
    else assert.match(system, new RegExp(`PONYTAIL MODE ACTIVE[^\n]*level: ${expected}`));
  }
  console.log(`${mode === null ? 'next turn' : `/ponytail ${mode}`}: ${expected}`);
}
try {
  await start();
  const first = (await api('/api/session', { model: { providerID: 'test', id: 'probe' } })).data.id;
  const second = (await api('/api/session', { model: { providerID: 'test', id: 'probe' } })).data.id;
  await turn(first, 'ultra', 'ultra');
  await turn(first, null, 'ultra');
  await turn(second, null, 'full');
  await turn(first, 'off', 'off');
  await turn(first, null, 'off');
  await stop();
  await start();
  await turn(first, null, 'off');
  await turn(first, 'lite', 'lite');
  await turn(first, '', 'lite');
  await turn(first, 'typo', 'lite');
  // Separate sessions must not race through a machine-global mode flag.
  await Promise.all([
    api(`/api/session/${first}/command`, { command: 'ponytail', text: 'ultra' }),
    api(`/api/session/${second}/command`, { command: 'ponytail', text: 'off' }),
  ]);
  await Promise.all([api(`/api/session/${first}/wait`, {}), api(`/api/session/${second}/wait`, {})]);
  await turn(first, null, 'ultra');
  await turn(second, null, 'off');
  const moved = path.join(root, 'moved');
  await fs.mkdir(moved);
  await api(`/api/session/${first}/move`, { directory: moved });
  await turn(first, null, 'ultra');

  // A mode switch during an in-flight request applies at the next dispatch.
  let release, started;
  const admitted = new Promise((resolve) => { started = resolve; });
  hold = { started, release: new Promise((resolve) => { release = resolve; }) };
  await api(`/api/session/${first}/prompt`, { text: 'HOLD_PROBE' });
  const running = await admitted;
  await Promise.all(['lite', 'ultra'].map((text) => api(`/api/session/${first}/command`, { command: 'ponytail', text, delivery: 'queue' })));
  await api(`/api/session/${first}/command`, { command: 'ponytail', text: 'off', delivery: 'queue' });
  assert.match(JSON.stringify(running.messages.filter((m) => m.role === 'system')), /level: ultra/);
  const boundary = requests.length;
  release();
  await api(`/api/session/${first}/wait`, {});
  const queued = requests.slice(boundary).filter((r) => r.messages?.some((m) => m.role === 'system' && JSON.stringify(m.content).includes('PONYTAIL_V2_VERIFICATION')));
  assert.ok(queued.length, 'Queued command must dispatch after the in-flight request');
  for (const request of queued) assert.doesNotMatch(JSON.stringify(request.messages.filter((m) => m.role === 'system')), /PONYTAIL MODE ACTIVE/);
  console.log('queued switch: in-flight ultra preserved, next dispatch off');

  const beforeChild = requests.length;
  await api(`/api/session/${first}/prompt`, { text: 'SPAWN_PROBE' });
  await api(`/api/session/${first}/wait`, {});
  const children = requests.slice(beforeChild).filter((r) => r.messages?.some((m) => m.role === 'system' && JSON.stringify(m.content).includes('PONYTAIL_V2_CHILD')));
  assert.ok(children.length, 'Expected a real subagent request');
  for (const request of requests.slice(beforeChild)) assert.doesNotMatch(JSON.stringify(request.messages.filter((m) => m.role === 'system')), /PONYTAIL MODE ACTIVE/);
  console.log('subagent: inherits parent off mode');
  const childSessions = (await api(`/api/session?parentID=${first}`)).data;
  const childID = childSessions[0].id;
  await turn(first, 'ultra', 'ultra');
  // Exercise the real child again: inheritance follows later parent changes.
  const childStart = requests.length;
  await api(`/api/session/${childID}/prompt`, { text: 'Reply OK.' });
  await api(`/api/session/${childID}/wait`, {});
  const childRequest = requests.slice(childStart).find((r) => r.messages?.some((m) => m.role === 'system' && JSON.stringify(m.content).includes('PONYTAIL_V2_CHILD')));
  assert.ok(childRequest);
  assert.match(JSON.stringify(childRequest.messages.filter((m) => m.role === 'system')), /level: ultra/);
  for (let i = 0; i < 20; i++) await turn(first, null, 'ultra');
  console.log('20 subsequent dispatches: ultra retained');
  console.log(`Verified V2 modes, concurrency, queueing, moves, subagent inheritance, 20 later turns, and restart persistence. Artifacts: ${root}`);
} finally {
  await stop();
  provider.close();
}
