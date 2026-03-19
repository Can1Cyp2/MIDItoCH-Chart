import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const distPath = resolve(root, 'dist')
const docsPath = resolve(root, 'docs')

if (!existsSync(distPath)) {
  throw new Error('dist folder does not exist. Run npm run build first.')
}

if (existsSync(docsPath)) {
  rmSync(docsPath, { recursive: true, force: true })
}

mkdirSync(docsPath, { recursive: true })
cpSync(distPath, docsPath, { recursive: true })

console.log('Synced dist -> docs. Commit docs folder to deploy GitHub Pages from main/docs.')
