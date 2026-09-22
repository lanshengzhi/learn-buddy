// Verify the shipped cross-process writer lock behaviour an OAuth refresh runs under.
// Non-destructive: works only inside a fresh temp directory.
import { writeFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '/home/lansy/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'))
const target = join(dir, 'probe.credentials.yaml')
const lock = target + '.lock'
writeFileSync(target, 'version: 1\n')

// normal acquisition
const ok = await withFileLock(target, async () => 'acquired', { waitMs: 1000 })
console.log('1) uncontended            ->', ok, '| lock left behind =', existsSync(lock))

// simulate a holder killed while refreshing: a stale lock file nobody owns
writeFileSync(lock, '999999\n')
const t0 = Date.now()
try {
  await withFileLock(target, async () => 'acquired', { waitMs: 1500 })
  console.log('2) orphan lock            -> acquired (unexpected)')
} catch (e) {
  console.log('2) orphan lock, waitMs=1500 ->', e.message, `(after ${Date.now() - t0} ms)`)
}
console.log('   stale lock still present =', existsSync(lock), '| pid inside =', '999999')
rmSync(lock, { force: true })
const after = await withFileLock(target, async () => 'acquired', { waitMs: 1000 })
console.log('3) after operator removes lock ->', after)
rmSync(dir, { recursive: true, force: true })
