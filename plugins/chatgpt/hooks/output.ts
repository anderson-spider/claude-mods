import { extensionOf, fileName, variantPath } from './input'
import type { AskResult, ImageResult, Outcome, OutputDeps, Preview, ProcessRunner, Request } from './model'
import { askOutcome, imageFailure, imageSummary, jpegPreview } from './presentation'

// The longest side of the preview the image tool hands back with the file.
const PREVIEW_SIDE = 768

async function outDir(tmpDir: OutputDeps['tmpDir']): Promise<string> {
  return `${((await tmpDir()) ?? '/tmp').replace(/\/$/, '')}/chatgpt`
}

// The host writes text only, so the bytes go through openssl's base64 decoder.
async function writeImage(run: ProcessRunner, path: string, base64: string): Promise<string | undefined> {
  const dir = path.slice(0, path.lastIndexOf('/')) || '/'
  await run(['mkdir', '-p', dir])
  const done = await run(['openssl', 'base64', '-d', '-A', '-out', path], { stdin: base64, timeoutMs: 60_000 })
  return done.exitCode === 0 ? undefined : `Could not write ${path}: ${done.stderr.trim()}`
}

// A small JPEG of the saved image (sips, on macOS), so the model sees it at once.
async function previewOf({ run, files }: Pick<OutputDeps, 'run' | 'files'>, path: string): Promise<Preview | undefined> {
  const small = `${path}.preview.jpg`
  try {
    const done = await run(['sips', '-Z', String(PREVIEW_SIDE), '-s', 'format', 'jpeg', path, '--out', small], { timeoutMs: 30_000 })
    if (done.exitCode !== 0) return undefined
    const { base64 } = await files.readBytes(small)
    return jpegPreview(base64)
  } catch {
    return undefined
  } finally {
    await run(['rm', '-f', small]).catch(() => undefined)
  }
}

export async function saveAnswer({ files, tmpDir }: Pick<OutputDeps, 'files' | 'tmpDir'>, result: AskResult, request: Request): Promise<Outcome> {
  let path: string | undefined
  if (result.markdown) {
    path = request.out ?? `${await outDir(tmpDir)}/${fileName(request.input.prompt, new Date())}`
    await files.write(path, `<!-- ${result.url} -->\n\n${result.markdown}\n`)
  }
  return askOutcome(result, path, request.maxChars)
}

export async function saveImages(deps: OutputDeps, result: ImageResult, request: Request): Promise<Outcome> {
  if (!result.ok) return imageFailure(result)
  const paths: string[] = []
  const previews: Preview[] = []
  const lines: string[] = []
  for (const [i, image] of result.images.entries()) {
    const ext = extensionOf(image.type)
    const base = request.out ?? `${await outDir(deps.tmpDir)}/${fileName(request.input.prompt, new Date(), ext)}`
    const path = variantPath(base, i, result.images.length)
    const failed = await writeImage(deps.run, path, image.base64)
    if (failed) return { ok: false, text: failed, error: failed, chatUrl: result.url, paths }
    paths.push(path)
    lines.push(`${path} (${image.width}x${image.height}, ${image.type})`)
    const preview = await previewOf(deps, path)
    if (preview) previews.push(preview)
  }
  return imageSummary(result.url, paths, previews, lines)
}
