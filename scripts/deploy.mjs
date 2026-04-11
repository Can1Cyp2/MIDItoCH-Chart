import { spawnSync } from 'node:child_process'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
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
  return spawnSync(command, args, {
    stdio: 'pipe',
    shell: process.platform === 'win32',
    ...options,
  })
}

// 1) Build app and sync dist -> docs.
run('npm', ['run', 'build'])
run('node', ['scripts/sync-dist-to-docs.mjs'])

// 2) Stage docs changes.
run('git', ['add', 'docs'])

// 3) Commit only when there are staged changes.
const diffResult = runSilent('git', ['diff', '--cached', '--quiet'])
const hasStagedChanges = diffResult.status === 1

if (!hasStagedChanges) {
  console.log('No docs changes to commit. Skipping commit and push.')
  process.exit(0)
}

const commitMessage =
  process.env.DEPLOY_MESSAGE ||
  `chore: deploy docs ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`

run('git', ['commit', '-m', commitMessage])
run('git', ['push'])

console.log('Deploy complete: docs updated, committed, and pushed.')
