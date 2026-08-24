#!/usr/bin/env node
import('../dist/bundle.js').catch((err) => {
  console.error(err?.stack ?? err)
  process.exit(1)
})
