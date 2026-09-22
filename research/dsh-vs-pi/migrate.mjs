// Prove (a) pi's auth.json oauth payload parses into a DSH credentials document
// verbatim, and (b) pi-ai resolves the migrated payload.
// Non-destructive: reads the REAL ~/.pi/agent/auth.json read-only, never prints
// token values, and writes its YAML into a fresh temp directory.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const N = '/home/lansy/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai'
const { parseCredentialsDocument } = await import(`${N}/dsh-credentials-local/lib/index.js`)
const D = '/home/lansy/Work/LearnBuddy/ai-service/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist'
const { openaiCodexProvider } = await import(`${D}/providers/openai-codex.js`)
const { resolveProviderAuth } = await import(`${D}/auth/resolve.js`)
const { defaultProviderAuthContext } = await import(`${D}/auth/context.js`)
const { InMemoryCredentialStore } = await import(`${D}/auth/credential-store.js`)

const authPath = join(homedir(), '.pi', 'agent', 'auth.json')
const auth = JSON.parse(readFileSync(authPath, 'utf8'))
console.log('pi auth.json providers      =', Object.keys(auth).join(', '))
const entry = auth['openai-codex']
console.log('openai-codex fields         =', Object.keys(entry).join(', '))
console.log('type                        =', entry.type)
console.log('expires                     =', new Date(entry.expires).toISOString(),
  '| expired =', entry.expires < Date.now(), '| ms left =', entry.expires - Date.now())

// (a) the migration: auth.json entry -> DSH credentials document record
const dir = mkdtempSync(join(tmpdir(), 'dsh-migrate-'))
const yaml = [
  'version: 1',
  'records:',
  '  llm-pi-ai/openai-codex:',
  '    kind: grant',
  '    payload:',
  ...Object.entries(entry).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`),
  '',
].join('\n')
writeFileSync(join(dir, 'seeded.credentials.yaml'), yaml)
const doc = parseCredentialsDocument(yaml, 'seeded.credentials.yaml')
const record = doc.records.get('llm-pi-ai/openai-codex')
console.log('DSH parse record kind       =', record?.kind)
console.log('payload deep-equals pi entry=', JSON.stringify(record?.payload) === JSON.stringify(entry))

// (b) pi-ai resolves the migrated payload. A fabricated same-shaped token is
// used so no refresh can ever touch the family credential or the network.
const probePayload = { ...entry, access: 'PROBE-ACCESS', refresh: 'PROBE-REFRESH', expires: Date.now() + 3600_000 }
const store = new InMemoryCredentialStore()
await store.modify('openai-codex', async () => probePayload)
const resolved = await resolveProviderAuth(openaiCodexProvider(), store, defaultProviderAuthContext())
console.log('resolve with migrated-shaped payload ->',
  resolved?.auth ? `auth present, source=${resolved.source}` : 'no auth')
rmSync(dir, { recursive: true, force: true })
