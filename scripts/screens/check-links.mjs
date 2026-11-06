#!/usr/bin/env node
// Checks relative links and image paths (and #heading anchors) in README.md and docs/*.md.
//   node scripts/screens/check-links.mjs     exit 1 when something does not resolve
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './fixture.mjs'

const files = ['README.md', ...readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)]
/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to dashes. */
const slug = (h) => h.trim().toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')
const anchors = (file) => {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '')
  return new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])))
}

let bad = 0
let checked = 0
for (const file of files) {
  const abs = path.join(ROOT, file)
  const text = readFileSync(abs, 'utf8').replace(/```[\s\S]*?```/g, '')
  const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1])
  for (const target of targets) {
    if (/^[a-z]+:/i.test(target)) continue // http(s), mailto
    checked++
    const [rel, hash] = target.split('#')
    const dest = rel === '' ? abs : path.resolve(path.dirname(abs), decodeURIComponent(rel))
    if (!existsSync(dest)) {
      console.log(`${file}: missing ${target}`)
      bad++
    } else if (hash && dest.endsWith('.md') && !anchors(dest).has(hash)) {
      console.log(`${file}: no heading for #${hash} in ${path.relative(ROOT, dest)}`)
      bad++
    }
  }
}
console.log(`${checked} relative links checked in ${files.length} files, ${bad} broken`)
process.exit(bad ? 1 : 0)
