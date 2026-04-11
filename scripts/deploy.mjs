import { spawnSync } from 'node:child_process'

function quoteForCmd(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function runProcess(command, args, options = {}) {
  if (process.platform === 'win32') {
    const commandLine = `& ${quoteForCmd(command)} ${args.map((arg) => quoteForCmd(arg)).join(' ')}`
    return spawnSync('powershell.exe', ['-NoProfile', '-Command', commandLine], options)
  }

  return spawnSync(command, args, options)
}

function run(command, args, options = {}) {
  const result = runProcess(command, args, {
    stdio: 'inherit',
    ...options,
  })

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status)
  }

  if (result.error) {
    throw result.error
  }
}

function runSilent(command, args, options = {}) {
  return runProcess(command, args, {
    stdio: 'pipe',
    ...options,
  })
}

function hasUpstream() {
  const result = runSilent('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return result.status === 0
}

// 1) Build app and sync dist -> docs.
run('npm', ['run', 'build'])
run('node', ['scripts/sync-dist-to-docs.mjs'])

// 2) Stage all changes (docs + source/config updates).
// .gitignore controls what is excluded.
run('git', ['add', '-A'])

// 3) Commit only when there are staged changes.
const diffResult = runSilent('git', ['diff', '--cached', '--quiet'])
const hasStagedChanges = diffResult.status === 1

if (!hasStagedChanges) {
  console.log('No staged changes to commit. Skipping commit and push.')
  process.exit(0)
}

const commitMessage =
  process.env.DEPLOY_MESSAGE ||
  `chore: deploy site ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`

run('git', ['commit', '-m', commitMessage])
if (hasUpstream()) {
  run('git', ['push'])
} else {
  run('git', ['push', '-u', 'origin', 'HEAD'])
}

console.log('Deploy complete: build + docs sync + commit + push finished.')
