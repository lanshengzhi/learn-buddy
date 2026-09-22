// Non-destructive probe (scratch, /tmp HOME): does pi-ai's ambient discovery see
// a pi agent dir auth.json, and is that oauth payload accepted verbatim by a
// pi CredentialStore (which is what DSH's dsh-llm-pi-ai implements)?
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const D = '/home/lansy/Work/LearnBuddy/ai-service/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist'
const { openaiCodexProvider } = await import(`${D}/providers/openai-codex.js`)
const { resolveProviderAuth } = await import(`${D}/auth/resolve.js`)
const { defaultProviderAuthContext } = await import(`${D}/auth/context.js`)
const { InMemoryCredentialStore } = await import(`${D}/auth/credential-store.js`)

const home = mkdtempSync(join(tmpdir(), 'fakehome-'))
mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
const oauth = { type: 'oauth', access: 'FAKE-ACCESS-TOKEN', refresh: 'FAKE-REFRESH-TOKEN', expires: Date.now() + 3600_000 }
writeFileSync(join(home, '.pi', 'agent', 'auth.json'), JSON.stringify({ 'openai-codex': oauth }, null, 2))
process.env.HOME = home
console.log('fake HOME            =', home)

const provider = openaiCodexProvider()
console.log('provider.id          =', provider.id)
console.log('provider.auth keys   =', Object.keys(provider.auth))
console.log('provider keys        =', Object.keys(provider))
console.log('provider.models type =', typeof provider.models, Array.isArray(provider.models) ? provider.models.length : Object.keys(provider.models ?? {}).slice(0,8))
console.log('oauth.isSubscription =', provider.auth.oauth?.isSubscription)

const ctx = defaultProviderAuthContext()
console.log('ambient env OPENAI_API_KEY   =', await ctx.env('OPENAI_API_KEY'))
console.log('ambient fileExists(auth.json)=', await ctx.fileExists(join(home, '.pi', 'agent', 'auth.json')))

const store = new InMemoryCredentialStore()
const a1 = await resolveProviderAuth(provider, store, ctx)
console.log('A) auth.json present, store empty ->', JSON.stringify(a1) ?? 'undefined')

await store.modify('openai-codex', async () => oauth)
const a2 = await resolveProviderAuth(provider, store, ctx)
console.log('B) same payload seeded in store  ->', JSON.stringify(a2))
