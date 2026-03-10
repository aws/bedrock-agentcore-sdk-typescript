#!/usr/bin/env npx tsx

import * as fs from 'fs'
import * as path from 'path'

const root = path.join(import.meta.dirname, '..')
const src = path.join(root, 'src', 'tools', 'browser', 'live-view', 'nice-dcv-web-client-sdk')
const dest = path.join(root, 'dist', 'src', 'tools', 'browser', 'live-view', 'nice-dcv-web-client-sdk')

function copyDir(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name)
    const d = path.join(destDir, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

copyDir(src, dest)
console.log('Copied DCV web client SDK to dist/')
