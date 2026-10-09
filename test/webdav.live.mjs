/**
 * Live check against a real WebDAV server — the cloud sync's version of
 * `official-pricing.live.mjs`.
 *
 * `webdav.verify.mjs` runs offline against a server this repository wrote, so it can only
 * prove the client agrees with *that* server. This script drives a real one through the whole
 * path the sync will use — `OPTIONS` (realm and DAV compliance), `MKCOL`, `PUT`, `GET` byte
 * comparison, `PROPFIND`, `MOVE`, `DELETE` — and prints what the server actually said. A
 * `bytemark/webdav` container is the target it was written for, but any Digest-only WebDAV
 * server that speaks these seven methods will do.
 *
 * Nothing is left behind: everything happens under a fresh `usage-badge-live-<random>/`
 * collection, which is deleted at the end even when an assertion fails.
 *
 * It needs the network, so it is not part of `npm test`.
 *
 * Usage (PowerShell):
 *   $env:DSH_USAGE_BADGE_WEBDAV_URL='http://nas:19347/'
 *   $env:DSH_USAGE_BADGE_WEBDAV_USER='alice'
 *   $env:DSH_USAGE_BADGE_WEBDAV_PASSWORD='…'
 *   node test/webdav.live.mjs
 *
 * A missing URL or username skips the run (exit 0) rather than failing, so a CI job can
 * include it unconditionally.
 */

import { randomBytes } from 'node:crypto'

import { WebDavClient } from '../lib/webdav.js'

const url = process.env.DSH_USAGE_BADGE_WEBDAV_URL
const username = process.env.DSH_USAGE_BADGE_WEBDAV_USER
const password = process.env.DSH_USAGE_BADGE_WEBDAV_PASSWORD

if (!url || !username || password === undefined) {
  console.log('SKIP: set DSH_USAGE_BADGE_WEBDAV_URL, DSH_USAGE_BADGE_WEBDAV_USER and DSH_USAGE_BADGE_WEBDAV_PASSWORD to run this check')
  process.exit(0)
}

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) console.log(`ok    ${label}`)
  else {
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
    failures.push(label)
  }
}

const dir = `usage-badge-live-${randomBytes(4).toString('hex')}/`
/** Deliberately not all-zero and not compressible, so a truncated transfer cannot look equal. */
const payload = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) % 256))

let client
try {
  client = new WebDavClient({ baseUrl: url, username, password, allowInsecureTls: true })
} catch (error) {
  console.error(`FAIL  cannot build a client for ${url}: ${error.message}`)
  process.exit(1)
}

console.log(`\n=== ${url}  (user ${username})`)
if (client.insecureWarning) console.log(`  note: ${client.insecureWarning}`)

let created = false
try {
  // 1. Handshake and capabilities.
  const options = await client.options()
  console.log(`  OPTIONS → ${options.status}   DAV: ${options.dav || '(none)'}   realm: ${options.realm ?? '(not captured)'}`)
  check('the endpoint answers OPTIONS', options.status === 200, String(options.status))
  check('it announces DAV class 1 (so it really is WebDAV)', /(^|,)\s*1(\s*,|$)/.test(options.dav) || options.dav.includes('1'), options.dav || '(empty DAV header)')
  check('it offered a Digest challenge (this is the authentication path under test)', options.realm !== null, 'no WWW-Authenticate: Digest seen')
  const methods = options.allow.split(',').map((m) => m.trim().toUpperCase())
  // Apache does not list MKCOL or PUT in `Allow` for a `Dav On` directory — only the methods
  // its own handlers intercept — so "DAV is enabled here" is read from the DAV token and the
  // DAV-specific methods it does advertise. The two that matter are exercised for real below.
  const davMethods = ['PROPFIND', 'PROPPATCH', 'COPY', 'MOVE', 'LOCK', 'UNLOCK']
  check('it advertises DAV-specific methods', davMethods.some((method) => methods.includes(method)), options.allow || '(empty Allow header)')
  console.log(`  Allow: ${options.allow || '(none)'}  — note MKCOL and PUT are not listed by Apache even though they work`)

  // 2. The collection the sync will live in.
  created = await client.mkcol(dir)
  check('MKCOL creates a collection', created === true, String(created))

  // 3. A round trip that compares bytes, not just status codes.
  await client.put(`${dir}shard.bin`, payload, { contentType: 'application/octet-stream' })
  const fetched = await client.get(`${dir}shard.bin`)
  check('PUT then GET returns the same bytes', fetched?.equals(payload) === true, `${fetched?.length ?? 'null'} of ${payload.length} bytes`)

  // 4. PROPFIND sees exactly what was written.
  const children = await client.propfind(dir)
  const entry = children.find((child) => child.name === 'shard.bin')
  console.log(`  PROPFIND → ${children.length} child(ren): ${children.map((c) => c.name + (c.collection ? '/' : '')).join(', ')}`)
  check('PROPFIND lists the uploaded shard', Boolean(entry), JSON.stringify(children))
  check('...and reports its length', entry?.bytes === payload.length, `${entry?.bytes} vs ${payload.length}`)

  // 5. MOVE, which is how a shard lands atomically after upload.
  await client.move(`${dir}shard.bin`, `${dir}2026-09.bin`)
  const moved = await client.get(`${dir}2026-09.bin`)
  check('MOVE renames and the bytes survive', moved?.equals(payload) === true, `${moved?.length ?? 'null'} bytes`)
  check('the source name is gone after MOVE', (await client.get(`${dir}shard.bin`)) === null)

  // 6. Overwrite protection, which keeps a crashed upload from clobbering a good shard.
  await client.put(`${dir}other.bin`, Buffer.from('other'))
  let clobbered = null
  try {
    await client.move(`${dir}other.bin`, `${dir}2026-09.bin`)
  } catch (error) {
    clobbered = error.message
  }
  check('MOVE refuses to overwrite an existing shard', /already exists/.test(String(clobbered)), String(clobbered))

  // 7. A missing resource is a 404, which the sync reads as "not there yet".
  check('GET of a missing resource is null', (await client.get(`${dir}nope.bin`)) === null)

  // 8. How the server treats a directory without its trailing slash. Apache answers 301 there,
  // and this client deliberately does not chase redirects — so the sync must always build
  // collection paths with the slash. Reporting the real answer makes that assumption visible.
  try {
    const slashless = await client.request('PROPFIND', dir.replace(/\/$/, ''), {
      headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>',
    })
    console.log(`  PROPFIND without the trailing slash → ${slashless.status}${slashless.status === 301 ? ` (Location: ${slashless.headers.location ?? '?'})` : ''}`)
    check('the slashless answer is a status the client reports rather than follows', [200, 207, 301, 302, 307, 308].includes(slashless.status), String(slashless.status))
  } catch (error) {
    console.log(`  PROPFIND without the trailing slash → ${error.message}`)
  }
} catch (error) {
  console.error(`FAIL  ${error.message}`)
  failures.push(error.message)
} finally {
  if (created) {
    try {
      await client.delete(`${dir}2026-09.bin`)
      await client.delete(`${dir}other.bin`)
      await client.delete(dir)
      console.log(`  cleaned up ${dir}`)
    } catch (error) {
      console.log(`  note: cleanup of ${dir} did not finish: ${error.message}`)
    }
  }
}

console.log(failures.length === 0 ? '\nLIVE CHECK: the WebDAV handshake and all seven methods work' : `\nLIVE CHECK: ${failures.length} failure(s)`)
process.exitCode = failures.length === 0 ? 0 : 2
