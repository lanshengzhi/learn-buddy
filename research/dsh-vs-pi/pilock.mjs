// pi's own lock (proper-lockfile, as called in pi-coding-agent/dist/core/auth-storage.js:85-90)
// recovers an orphaned lock by mtime; DSH's wx lock does not. stale is 30_000 in pi.
// Non-destructive: works only inside a fresh temp directory.
import { existsSync, utimesSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from '/home/lansy/Work/LearnBuddy/ai-service/node_modules/@earendil-works/pi-coding-agent/node_modules/proper-lockfile/index.js'

const dir = mkdtempSync(join(tmpdir(), 'pi-lock-'))
const target = join(dir, 'probe.auth.json')
const lockdir = target + '.lock'
mkdirSync(lockdir, { recursive: true })
const old = Date.now() / 1000 - 120
utimesSync(lockdir, old, old)
const t0 = Date.now()
const release = await lockfile.lock(target, { realpath: false, retries: 0, stale: 1000 })
console.log('orphan lock with old mtime, stale=1000ms -> acquired in', Date.now() - t0, 'ms')
await release()
console.log('released; lock dir gone =', !existsSync(lockdir))
rmSync(dir, { recursive: true, force: true })
