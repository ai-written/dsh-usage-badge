/**
 * Package-contract verification.
 *
 * DSH loads a plugin from its `package.json` declarations, and the failure modes
 * are silent or confusing: a `dsh.client` declaration with no `./client` export
 * throws at composition, a patch row whose name does not match the package
 * disappears without mounting, and a stray `export default` in the host half
 * makes the loader's `unwrapExports` collapse the module and drop `inject` (the
 * pitfall documented in DSH's own `dsh-tool-todo` README).
 *
 * This checks the declarations against the files on disk so those failures are
 * caught here instead of at boot.
 *
 * Usage:
 *   node test/manifest.verify.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`ok    ${label}`)
  else {
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
    failures.push(label)
  }
}

const pkg = JSON.parse(read('package.json'))

// ── identity and the bundle patch ────────────────────────────────────────────
check('manifest version is the declared format (1)', pkg.dsh?.manifestVersion === 1, String(pkg.dsh?.manifestVersion))
check('package name is dsh-usage-badge', pkg.name === 'dsh-usage-badge', pkg.name)
check('type is module', pkg.type === 'module', pkg.type)

const patchPath = pkg.dsh?.bundle?.patch
check('declares dsh.bundle.patch', typeof patchPath === 'string', String(patchPath))
check('the patch file exists', Boolean(patchPath) && existsSync(join(root, patchPath)), String(patchPath))

const patch = patchPath && existsSync(join(root, patchPath)) ? read(patchPath) : ''
// The loader resolves a row by name out of the profile's own node_modules, so a
// mismatch between the row and the package name means the plugin never mounts.
check('patch inserts a row', /^\s*-\s*insert:/m.test(patch))
check('the patch row name equals the package name', new RegExp(`name:\\s*${pkg.name}\\b`).test(patch))
check('the patch row carries an id', /id:\s*[A-Za-z0-9_-]+/.test(patch))

// ── browser half ─────────────────────────────────────────────────────────────
const clientManifest = pkg.dsh?.client
check('declares dsh.client', Boolean(clientManifest))
check('targets the web platform', clientManifest?.platform === 'web', String(clientManifest?.platform))

const clientExport = pkg.exports?.['./client']?.default
check('exports ./client', typeof clientExport === 'string', String(clientExport))
check('the client bundle exists', Boolean(clientExport) && existsSync(join(root, clientExport)), String(clientExport))

const clientSource = clientExport && existsSync(join(root, clientExport)) ? read(clientExport) : ''
check('the bundle registers through the module loader', /window\.__ModuleLoader__\.load\(/.test(clientSource))
check('the bundle registers under the package name', new RegExp(`id:\\s*['"]${pkg.name}['"]`).test(clientSource))
check('the bundle requires nothing but the platform baseline', !/require\(['"](?!react['"])/.test(clientSource))
check('the bundle needs no external declaration', (clientManifest?.external ?? []).length === 0, JSON.stringify(clientManifest?.external))

// ── host half ────────────────────────────────────────────────────────────────
check('main points at the host entry', typeof pkg.main === 'string', String(pkg.main))
check('the host entry exists', Boolean(pkg.main) && existsSync(join(root, pkg.main)), String(pkg.main))

const hostSource = pkg.main && existsSync(join(root, pkg.main)) ? read(pkg.main) : ''
check('the host half exports apply()', /export function apply\b/.test(hostSource))
check('the host half exports inject', /export const inject\b/.test(hostSource))
// A default export makes the loader fold the module and discard `inject`.
check('the host half has no default export', !/export default\b/.test(hostSource))
check('the host half has no default export in its helpers', !/export default\b/.test(read('lib/fold.js')) && !/export default\b/.test(read('lib/pricing.js')))

// ── packaging ────────────────────────────────────────────────────────────────
const files = pkg.files ?? []
check('the published file list includes lib/', files.includes('lib'))
check('the published file list includes the patch', files.includes('cordis.patch.yml'))
check('declares a Node floor for zstd support', typeof pkg.engines?.node === 'string', String(pkg.engines?.node))

// ── README references ────────────────────────────────────────────────────────
// Two ways to end up with a dead reference: the file is missing, or it exists but is
// not shipped — which breaks it on npm even though GitHub is fine.
const readme = read('README.md')
const references = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#'))
for (const target of references) {
  check(`README reference exists on disk: ${target}`, existsSync(join(root, target)), target)
}
// Any `dir/file` reference means `dir` has to be in the published file list.
const referencedDirs = [...new Set(references.filter((t) => t.includes('/')).map((t) => t.split('/')[0]))]
check('the published file list ships every referenced directory',
  referencedDirs.every((dir) => files.includes(dir)),
  `${referencedDirs.join(',') || '(none)'} vs ${files.join(',')}`)

// ── the bundled holiday calendar ─────────────────────────────────────────────
// It ships inside `lib/`, so the plugin needs no network and no extra file entry
// to know the Chinese public holidays the peak/valley rule is defined against.
const table = JSON.parse(read('lib/holidays-cn.json'))
const years = Object.keys(table.years ?? {})
check('the holiday table ships inside the published lib/', files.includes('lib'))
check('the holiday table covers 2025 and 2026', years.includes('2025') && years.includes('2026'), years.join(','))
check('every holiday block has a name and an in-range span',
  years.every((year) => table.years[year].blocks.every((block) => block.name && /^\d{4}-\d{2}-\d{2}$/.test(block.from) && block.from <= block.to)),
  'blocks are well formed')
check('the holiday table records a source document per year',
  years.every((year) => table.source?.[year]?.document && /^https:\/\//.test(table.source[year].url ?? '')),
  years.map((year) => table.source?.[year]?.document).join(' | '))
check('every 调休 workday is a real date',
  years.every((year) => table.years[year].workdays.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))),
  'workdays are well formed')

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nMANIFEST VERIFY PASSED')
