/**
 * Migration runner: applies pending SQL migrations and supports rollback.
 * Tracks applied migrations in schema_migrations so each runs once.
 *
 * Usage:
 *   npm run migrate                    – apply all pending migrations
 *   npm run migrate:rollback           – roll back the last 1 migration
 *   npm run migrate:rollback 3         – roll back the last 3 migrations
 *   npm run migrate:verify-rollback    – dry-run apply+rollback every migration
 *                                         against a scratch database
 *   npm run migrate:verify-rollback -- --only=001_foo,002_bar
 *
 * File conventions (both supported):
 *   Legacy:  001_foo.sql          → up-only, no rollback available
 *   Paired:  001_foo.up.sql  +  001_foo.down.sql  → supports rollback
 *
 * See docs/migration-rollback-verification.md for the verification design.
 */

import pg from 'pg'
import { readdir, readFile, access, appendFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = join(__dirname, 'migrations')

// ─── helpers ────────────────────────────────────────────────────────────────

/** Returns all unique migration versions, sorted ascending. */
export async function discoverMigrations(dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = await readdir(dir)
  const versions = new Set<string>()

  for (const f of files) {
    if (f.endsWith('.up.sql')) {
      versions.add(f.replace(/\.up\.sql$/, ''))
    } else if (f.endsWith('.sql') && !f.endsWith('.down.sql')) {
      // legacy up-only file
      versions.add(f.replace(/\.sql$/, ''))
    }
  }

  return [...versions].sort()
}

/** Reads the UP sql for a version. Prefers .up.sql, falls back to legacy .sql */
export async function getUpSql(version: string, dir: string = MIGRATIONS_DIR): Promise<string> {
  const upPath = join(dir, `${version}.up.sql`)
  try {
    await access(upPath)
    return readFile(upPath, 'utf-8')
  } catch {
    // try legacy
    const legacyPath = join(dir, `${version}.sql`)
    try {
      await access(legacyPath)
      return readFile(legacyPath, 'utf-8')
    } catch {
      throw new Error(`No up-migration file found for version: ${version}`)
    }
  }
}

/**
 * Reads the DOWN sql for a version.
 * Throws a clear error if the .down.sql file is missing — rollback is refused.
 */
export async function getDownSql(version: string, dir: string = MIGRATIONS_DIR): Promise<string> {
  const downPath = join(dir, `${version}.down.sql`)
  try {
    await access(downPath)
    return readFile(downPath, 'utf-8')
  } catch {
    throw new Error(
      `Cannot roll back "${version}": missing ${version}.down.sql — ` +
      `create this file to enable rollback for this migration.`
    )
  }
}

// ─── core logic ─────────────────────────────────────────────────────────────

export async function runMigrations(client: pg.Client, dir: string = MIGRATIONS_DIR): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const versions = await discoverMigrations(dir)
  const applied = new Set(
    (await client.query('SELECT version FROM schema_migrations'))
      .rows.map((r: { version: string }) => r.version)
  )

  const pending = versions.filter((v) => !applied.has(v))

  if (pending.length === 0) {
    console.log('No pending migrations.')
    return
  }

  for (const version of pending) {
    const sql = await getUpSql(version, dir)
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
      await client.query('COMMIT')
      console.log(`Applied: ${version}`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`Migration failed for "${version}": ${(err as Error).message}`)
    }
  }
}

export async function runRollback(
  client: pg.Client,
  steps: number = 1,
  dir: string = MIGRATIONS_DIR
): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT $1',
    [steps]
  )

  if (rows.length === 0) {
    console.log('Nothing to roll back.')
    return
  }

  // Validate ALL .down.sql files exist BEFORE touching the database
  for (const { version } of rows) {
    await getDownSql(version, dir) // throws immediately if missing
  }

  for (const { version } of rows) {
    const sql = await getDownSql(version, dir)
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [version])
      await client.query('COMMIT')
      console.log(`Rolled back: ${version}`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw new Error(`Rollback failed for "${version}": ${(err as Error).message}`)
    }
  }
}

// ─── rollback dry-run verification ─────────────────────────────────────────
//
// Verifies that a migration's down.sql cleanly reverses its up.sql: applies
// up, applies down, and diffs the database schema before/after. This never
// touches production data — it is a structural (DDL) check run against a
// disposable scratch database (see `assertScratchDatabase`).

/**
 * Statement patterns that PostgreSQL refuses to run inside a transaction
 * block (they implicitly commit or require to run outside BEGIN/COMMIT).
 * Migrations containing these are executed in autocommit mode: each
 * statement takes effect immediately and a failure partway through cannot
 * be rolled back by us — only reported.
 */
const NON_TRANSACTIONAL_DDL_RE =
  /\b(CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY|DROP\s+INDEX\s+CONCURRENTLY|REINDEX\s+CONCURRENTLY|ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE|VACUUM|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM|CLUSTER)\b/i

/** Returns true if `sql` contains a statement that cannot run inside BEGIN/COMMIT. */
export function requiresAutocommit(sql: string): boolean {
  return NON_TRANSACTIONAL_DDL_RE.test(sql)
}

/**
 * Captures a structural snapshot of the public schema: columns, indexes,
 * and constraints. Deliberately excludes `schema_migrations` (its row
 * content changes as versions are applied/rolled back, but its structure
 * never does) and excludes table data — this is a DDL/shape check only.
 */
export async function captureSchemaSnapshot(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ entry: string }>(`
    SELECT 'column:' || table_name || '.' || column_name || ':' || data_type
      || ':' || is_nullable || ':' || COALESCE(column_default, '') AS entry
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name != 'schema_migrations'
    UNION ALL
    SELECT 'index:' || indexname || ':' || indexdef AS entry
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename != 'schema_migrations'
    UNION ALL
    SELECT 'constraint:' || tc.table_name || '.' || tc.constraint_name || ':' || tc.constraint_type AS entry
    FROM information_schema.table_constraints tc
    WHERE tc.table_schema = 'public' AND tc.table_name != 'schema_migrations'
    ORDER BY 1
  `)
  return rows.map((r) => r.entry)
}

export type SchemaDrift = { onlyBefore: string[]; onlyAfter: string[] }

/** Diffs two schema snapshots. Empty result on both sides means no drift. */
export function diffSchemaSnapshots(before: string[], after: string[]): SchemaDrift {
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  return {
    onlyBefore: before.filter((e) => !afterSet.has(e)),
    onlyAfter: after.filter((e) => !beforeSet.has(e)),
  }
}

/**
 * Runs `sql` transactionally unless `autocommit` is set, in which case it
 * runs as-is (required for statements like CREATE INDEX CONCURRENTLY that
 * PostgreSQL refuses inside BEGIN/COMMIT).
 */
async function execMaybeTransactional(client: pg.Client, sql: string, autocommit: boolean): Promise<void> {
  if (autocommit) {
    await client.query(sql)
    return
  }
  await client.query('BEGIN')
  try {
    await client.query(sql)
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

export interface RollbackVerificationResult {
  version: string
  ok: boolean
  upMs: number
  downMs: number
  autocommit: boolean
  schemaDrift: SchemaDrift | null
  error?: string
  phase?: 'discover' | 'up' | 'down' | 'reapply' | 'diff'
}

/**
 * Verifies a single migration's rollback: apply up, apply down, diff the
 * schema against the pre-up snapshot, then re-apply up so the scratch
 * database ends up fully migrated (matching what subsequent migrations in
 * the sequence — and a real deploy — expect).
 *
 * Assumes all migrations preceding `version` are already applied.
 */
export async function verifyMigrationRollback(
  client: pg.Client,
  version: string,
  dir: string = MIGRATIONS_DIR,
): Promise<RollbackVerificationResult> {
  let upSql: string
  let downSql: string
  try {
    upSql = await getUpSql(version, dir)
    downSql = await getDownSql(version, dir)
  } catch (err) {
    return {
      version, ok: false, upMs: 0, downMs: 0, autocommit: false,
      schemaDrift: null, error: (err as Error).message, phase: 'discover',
    }
  }

  const autocommit = requiresAutocommit(upSql) || requiresAutocommit(downSql)
  const before = await captureSchemaSnapshot(client)

  const upStart = Date.now()
  try {
    await execMaybeTransactional(client, upSql, autocommit)
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [version],
    )
  } catch (err) {
    return {
      version, ok: false, upMs: Date.now() - upStart, downMs: 0, autocommit,
      schemaDrift: null, error: `up migration failed: ${(err as Error).message}`, phase: 'up',
    }
  }
  const upMs = Date.now() - upStart

  const downStart = Date.now()
  try {
    await execMaybeTransactional(client, downSql, autocommit)
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [version])
  } catch (err) {
    // Best effort: up succeeded but down failed partway, so the scratch DB
    // is left with the migration applied. That's fine (it's disposable) —
    // the important thing is reporting it, not hiding it.
    return {
      version, ok: false, upMs, downMs: Date.now() - downStart, autocommit,
      schemaDrift: null, error: `down migration failed: ${(err as Error).message}`, phase: 'down',
    }
  }
  const downMs = Date.now() - downStart

  const afterDown = await captureSchemaSnapshot(client)
  const drift = diffSchemaSnapshots(before, afterDown)
  const hasDrift = drift.onlyBefore.length > 0 || drift.onlyAfter.length > 0

  try {
    await execMaybeTransactional(client, upSql, autocommit)
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
      [version],
    )
  } catch (err) {
    return {
      version, ok: false, upMs, downMs, autocommit,
      schemaDrift: hasDrift ? drift : null,
      error: `re-apply after rollback failed: ${(err as Error).message}`,
      phase: 'reapply',
    }
  }

  return {
    version,
    ok: !hasDrift,
    upMs,
    downMs,
    autocommit,
    schemaDrift: hasDrift ? drift : null,
    error: hasDrift ? 'schema drift detected: rollback did not fully reverse the up migration' : undefined,
    phase: hasDrift ? 'diff' : undefined,
  }
}

export interface RollbackVerificationReport {
  total: number
  passed: number
  failed: number
  results: RollbackVerificationResult[]
}

/**
 * Verifies rollback for `options.versions` (default: every discovered
 * migration), applying — but not verifying — any earlier migrations not in
 * that list so later target migrations have the schema they depend on.
 */
export async function runRollbackVerification(
  client: pg.Client,
  options: { versions?: string[]; dir?: string; stopOnFirstFailure?: boolean } = {},
): Promise<RollbackVerificationReport> {
  const dir = options.dir ?? MIGRATIONS_DIR
  const allVersions = await discoverMigrations(dir)
  const targets = options.versions ?? allVersions
  const targetSet = new Set(targets)

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  const results: RollbackVerificationResult[] = []

  for (const version of allVersions) {
    if (!targetSet.has(version)) {
      // Dependency migration: apply it (not under test) so later target
      // migrations in the sequence see the schema they expect.
      const { rows: existing } = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])
      if (existing.length === 0) {
        const sql = await getUpSql(version, dir)
        await client.query('BEGIN')
        try {
          await client.query(sql)
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version])
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw new Error(`Dependency migration "${version}" failed to apply: ${(err as Error).message}`)
        }
      }
      continue
    }

    const result = await verifyMigrationRollback(client, version, dir)
    results.push(result)
    if (!result.ok && options.stopOnFirstFailure) break
  }

  const passed = results.filter((r) => r.ok).length
  return { total: results.length, passed, failed: results.length - passed, results }
}

/** Renders a rollback verification report as a Markdown table for CI summaries. */
export function formatRollbackReportMarkdown(report: RollbackVerificationReport): string {
  const lines: string[] = []
  lines.push('## Migration rollback verification')
  lines.push('')
  lines.push(
    report.failed === 0
      ? `All ${report.total} migration(s) rolled back cleanly.`
      : `${report.failed}/${report.total} migration(s) failed rollback verification.`,
  )
  lines.push('')
  lines.push('| Version | Result | Up (ms) | Down (ms) | Mode | Notes |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of report.results) {
    const result = r.ok ? 'pass' : 'FAIL'
    const mode = r.autocommit ? 'autocommit (non-transactional DDL)' : 'transactional'
    let notes = r.error ?? ''
    if (r.schemaDrift) {
      notes = `schema drift: +${r.schemaDrift.onlyAfter.length} leftover, -${r.schemaDrift.onlyBefore.length} not restored`
    }
    lines.push(`| ${r.version} | ${result} | ${r.upMs} | ${r.downMs} | ${mode} | ${notes} |`)
  }
  return lines.join('\n')
}

/**
 * Refuses to run rollback verification against anything that doesn't look
 * like a disposable database. Verification applies and re-applies DDL
 * repeatedly and can leave a database mid-migration on failure — never
 * something to risk against a real environment.
 *
 * Passes for localhost/loopback hosts (the normal shape of a CI service
 * container or local scratch DB) or when the database name signals intent
 * (contains "test", "scratch", "ci", or "ephemeral"). Anything else must
 * opt in explicitly via MIGRATION_VERIFY_FORCE=true.
 */
export function assertScratchDatabase(connectionString: string): void {
  if (process.env.MIGRATION_VERIFY_FORCE === 'true') return

  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('Refusing to run rollback verification: DATABASE_URL is not a valid connection URL.')
  }

  const host = url.hostname.toLowerCase()
  const dbName = url.pathname.replace(/^\//, '').toLowerCase()
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  const looksScratch = /(^|[_-])(test|scratch|ci|ephemeral)([_-]|$)/.test(dbName)

  if (isLoopback || looksScratch) return

  throw new Error(
    `Refusing to run rollback verification against "${host}/${dbName}": it does not look like a ` +
    `disposable scratch database. Point DATABASE_URL at a throwaway database (localhost, or a name ` +
    `containing "test"/"scratch"/"ci"), or set MIGRATION_VERIFY_FORCE=true to override.`,
  )
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is required.')
    process.exit(1)
  }

  const command = process.argv[2]   // 'rollback' | 'verify-rollback' | undefined
  const steps   = parseInt(process.argv[3] ?? '1', 10)

  const client = new pg.Client({ connectionString })
  try {
    await client.connect()
    if (command === 'rollback') {
      await runRollback(client, steps)
    } else if (command === 'verify-rollback') {
      assertScratchDatabase(connectionString)

      const onlyArg = process.argv.slice(3).find((a) => a.startsWith('--only='))
      const versions = onlyArg
        ? onlyArg.slice('--only='.length).split(',').map((v) => v.trim()).filter(Boolean)
        : undefined

      const report = await runRollbackVerification(client, { versions })
      const markdown = formatRollbackReportMarkdown(report)
      console.log(markdown)

      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n')
      }

      if (report.failed > 0) {
        process.exitCode = 1
      }
    } else {
      await runMigrations(client)
    }
  } finally {
    await client.end()
  }
}

// Only run when executed directly (not when imported in tests)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('Fatal:', err.message)
    process.exit(1)
  })
}