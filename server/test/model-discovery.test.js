import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login } from './helpers.js';
import { bedrockAdapter } from '../src/llm/bedrock.js';
import { openaiAdapter } from '../src/llm/openai.js';
import { decrypt } from '../src/crypto.js';


let app, admin, seen;
const factory = (impl) => (row) => { seen.push(row); return { listModels: impl || (async () => ['b-model', 'a-model']) }; };
const lookup = async (h) => [{ address: ['localhost', 'internal.corp'].includes(h) ? '127.0.0.1' : '93.184.216.34' }]; // hermetic: no real DNS
const setup = async (impl) => { await freshDb(); seen = []; app = createApp({ deps: { adapterFactory: factory(impl), lookup } }); admin = await login(app, { username: 'provadmin', roles: ['administrator'] }); };

describe('POST /api/admin/providers/discover', () => {
  beforeEach(() => setup());

  it('lists models for a connection that has not been saved yet, without persisting anything', async () => {
    const r = await admin.post('/api/admin/providers/discover').send({ type: 'openai', config: { baseUrl: 'https://api.example.com/v1' }, secret: 'sk-live-123' });
    expect(r.body).toEqual({ ok: true, models: ['b-model', 'a-model'] });
    expect(seen[0].type).toBe('openai'); expect(decrypt(seen[0].secret_enc)).toBe('sk-live-123');
    expect((await sqlDb().prepare('SELECT COUNT(*) c FROM providers').get()).c).toBe(0);
    expect((await sqlDb().prepare("SELECT COUNT(*) c FROM audit WHERE action='provider.discover'").get()).c).toBe(1);
  });

  it('requires provider.write', async () => {
    const dev = await login(app, { username: 'devperson' });
    expect((await dev.post('/api/admin/providers/discover').send({ type: 'openai', config: {} })).status).toBe(403);
  });

  it('blocks SSRF targets (private hosts only for LM Studio) and validates the type', async () => {
    expect((await admin.post('/api/admin/providers/discover').send({ type: 'openai', config: { baseUrl: 'http://169.254.169.254/' } })).status).toBe(400);
    expect((await admin.post('/api/admin/providers/discover').send({ type: 'openai', config: { baseUrl: 'https://localhost/v1' }, secret: 'k' })).status).toBe(400);
    expect((await admin.post('/api/admin/providers/discover').send({ type: 'lmstudio', config: { baseUrl: 'http://localhost:1234/v1' } })).body.ok).toBe(true);
    expect((await admin.post('/api/admin/providers/discover').send({ type: 'nope', config: {} })).status).toBe(400);
    expect((await admin.post('/api/admin/providers/discover').send({ type: 'azure', config: {} })).body.error).toBe('azure_requires_endpoint');
  });

  it('reuses the stored key for an unchanged endpoint, but never forwards it to a changed one', async () => {
    const created = await admin.post('/api/admin/providers').send({ name: 'P', type: 'openai', config: { baseUrl: 'https://api.example.com/v1' }, secret: 'stored-secret' });
    const id = created.body.id;
    const same = await admin.post('/api/admin/providers/discover').send({ type: 'openai', config: { baseUrl: 'https://api.example.com/v1' }, providerId: id });
    expect(same.body.ok).toBe(true); expect(decrypt(seen.at(-1).secret_enc)).toBe('stored-secret');
    const calls = seen.length;
    const moved = await admin.post('/api/admin/providers/discover').send({ type: 'openai', config: { baseUrl: 'https://attacker.example.net/v1' }, providerId: id });
    expect(moved.status).toBe(400); expect(moved.body.error).toBe('secret_required');
    expect(seen.length).toBe(calls); // adapter never constructed, so the key was never sent anywhere
    const retyped = await admin.post('/api/admin/providers/discover').send({ type: 'openai', config: { baseUrl: 'https://other.example.com/v1' }, providerId: id, secret: 'new-key' });
    expect(retyped.body.ok).toBe(true); expect(decrypt(seen.at(-1).secret_enc)).toBe('new-key');
  });

  it('reports failures without leaking the key', async () => {
    await setup(async () => { throw new Error('401 Incorrect API key provided: sk-live-123'); });
    const r = await admin.post('/api/admin/providers/discover').send({ type: 'openai', config: { baseUrl: 'https://api.example.com/v1' }, secret: 'sk-live-123' });
    expect(r.status).toBe(200); expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('Incorrect API key'); expect(r.body.error).not.toContain('sk-live-123');
  });
});

describe('adapter model listing', () => {
  it('Bedrock lists on-demand text models plus inference profiles (deduplicated, sorted)', async () => {
    const sent = [];
    const controlClient = { send: async (cmd) => {
      sent.push(cmd.constructor.name);
      if (cmd.constructor.name === 'ListFoundationModelsCommand') return { modelSummaries: [
        { modelId: 'anthropic.claude-x', inferenceTypesSupported: ['ON_DEMAND'] }, { modelId: 'amazon.provisioned-only', inferenceTypesSupported: ['PROVISIONED'] }, { modelId: 'meta.llama' }] };
      return { inferenceProfileSummaries: [{ inferenceProfileId: 'us.anthropic.claude-x' }, { inferenceProfileId: 'meta.llama' }] };
    } };
    const models = await bedrockAdapter({ cfg: { region: 'us-east-1' }, secret: '', controlClient }).listModels();
    expect(models).toEqual(['anthropic.claude-x', 'meta.llama', 'us.anthropic.claude-x']);
    expect(sent).toEqual(['ListFoundationModelsCommand', 'ListInferenceProfilesCommand']);
  });
  it('Bedrock still lists foundation models when inference profiles are not permitted', async () => {
    const controlClient = { send: async (cmd) => { if (cmd.constructor.name === 'ListInferenceProfilesCommand') throw new Error('AccessDenied'); return { modelSummaries: [{ modelId: 'm1' }] }; } };
    expect(await bedrockAdapter({ cfg: { region: 'r' }, secret: '', controlClient }).listModels()).toEqual(['m1']);
  });
  it('Azure lists deployment names via the data-plane API (api-key header, no redirects)', async () => {
    let req;
    const fetchImpl = async (url, init) => { req = { url, init }; return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-prod' }, { id: 'o3-mini' }] })); };
    const models = await openaiAdapter({ type: 'azure', cfg: { baseUrl: 'https://res.openai.azure.com/', apiVersion: '2024-10-21' }, secret: 'azkey', fetchImpl }).listModels();
    expect(models).toEqual(['gpt-4o-prod', 'o3-mini']);
    expect(req.url).toBe('https://res.openai.azure.com/openai/deployments?api-version=2024-10-21');
    expect(req.init.headers['api-key']).toBe('azkey'); expect(req.init.redirect).toBe('error');
  });
  it('Azure falls back to the model catalog when deployments cannot be listed', async () => {
    const fetchImpl = async () => new Response('nope', { status: 404 });
    const client = { models: { list: () => (async function* () { yield { id: 'gpt-4o' }; })() } };
    // `client` injection short-circuits the deployments call (unit-test seam), so exercise the fallback through a fake SDK too
    expect(await openaiAdapter({ type: 'azure', cfg: { baseUrl: 'https://r.openai.azure.com' }, secret: 'k', client, fetchImpl }).listModels()).toEqual(['gpt-4o']);
  });
  it('OpenAI-compatible and LM Studio return sorted ids', async () => {
    const client = { models: { list: () => (async function* () { yield { id: 'zeta' }; yield { id: 'alpha' }; })() } };
    expect(await openaiAdapter({ type: 'gemini', cfg: {}, secret: 'k', client: { models: { list: async function* () { yield { id: 'models/gemini-2.5-pro' }; yield { id: 'models/gemini-2.5-flash' }; } } } }).listModels()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    expect(await openaiAdapter({ type: 'lmstudio', cfg: {}, secret: '', client }).listModels()).toEqual(['alpha', 'zeta']);
  });
});
