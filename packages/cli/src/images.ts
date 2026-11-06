import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { isInside } from '@hesdor/agent-core'
import { imageMediaType, MAX_IMAGE_BYTES } from '@hesdor/protocol'
import type { ChatImage } from '@hesdor/protocol'

/** More images than this in one request make Anthropic apply a stricter per-image size limit. */
export const MAX_PROMPT_IMAGES = 20

/** Reads an image to attach to a prompt; throws a readable error for a missing, non-image or too large file. */
export async function loadImage(file: string, cwd = process.cwd()): Promise<ChatImage> {
  const abs = path.resolve(cwd, file)
  const info = await stat(abs).catch(() => undefined)
  if (!info?.isFile()) throw new Error(`image not found: ${file}`)
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`${file} is ${(info.size / 1e6).toFixed(1)} MB; images can be at most ${MAX_IMAGE_BYTES / 1e6} MB`)
  }
  const bytes = await readFile(abs)
  const mediaType = imageMediaType(bytes)
  if (!mediaType) throw new Error(`${file} is not a PNG, JPEG, GIF or WebP image`)
  return { mediaType, data: bytes.toString('base64') }
}

/** `@path` mentions of image files (png, jpg, jpeg, gif, webp) in a prompt, in order. */
export function imageMentions(prompt: string): string[] {
  return [...prompt.matchAll(/(?<=^|\s)@(\S+?\.(?:png|jpe?g|gif|webp))(?=$|[\s,;:.!?)])/gi)].map((m) => m[1]!)
}

/**
 * Images for a prompt: every `paths` entry (relative to `cwd`; any error is thrown) plus `@`-mentioned
 * image files that exist inside the workspace `root` (other mentions stay plain text).
 */
export async function promptImages(paths: string[], prompt: string, cwd: string, root: string): Promise<ChatImage[]> {
  const mentioned = imageMentions(prompt)
    .map((p) => path.resolve(root, p))
    .filter((abs) => isInside(root, abs) && existsSync(abs))
  const files = [...new Set([...paths.map((p) => path.resolve(cwd, p)), ...mentioned])]
  if (files.length > MAX_PROMPT_IMAGES) throw new Error(`too many images (${files.length}); attach at most ${MAX_PROMPT_IMAGES}`)
  return Promise.all(files.map((abs) => loadImage(abs)))
}
