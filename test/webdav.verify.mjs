/**
 * Offline verification for the WebDAV client.
 *
 * Two layers, deliberately kept apart:
 *
 *   1. **Digest arithmetic**, asserted against RFC 2617's own example. The `Mufasa` vector
 *      pins `HA1`, `HA2`, the `qop=auth` response and the exact `Authorization` field order,
 *      so a mistake in the handshake shows up as a wrong string rather than as an
 *      unexplained 401 against a live server.
 *   2. **The client against a server that verifies digest properly**
 *      (`test/webdav-server.mjs`) — including the seven methods the sync needs, the
 *      `stale=true` retry, an RFC 2069 challenge, and the two refusals (`SHA-256`,
 *      `Basic`-only) that must be named rather than silently downgraded.
 *
 * Usage:
 *   node test/webdav.verify.mjs
 */

import { createHash } from 'node:crypto'

import { WebDavClient, buildAuthorization, normalizeWebdavUrl, parseChallenge, unsupportedChallenge } from '../lib/webdav.js'
import { startFakeWebDav } from './webdav-server.mjs'
import { createChecker } from './helpers.mjs'

const { check, finish } = createChecker('webdav (Digest client)')

/**
 * The save route and the client must agree on every address.
 *
 * They had a copy of this rule each, and the copies drifted: the route accepted a query string, embedded
 * credentials, `ftp:` and a newline — addresses the client then refused — so the panel stored one, showed
 * it in its own field, and the sync could not run at all. The invariant is one-directional and that is the
 * point: **whatever the client refuses, the route must refuse too**. Normalisation (the trailing slash) is
 * the one case where the route is more permissive, and only because it hands the client the fixed address.
 */
{
  const addresses = [
    'http://nas:19347/',
    'http://nas:19347',
    'https://nas.example/dav',
    'https://nas.example/dav/',
    'http://nas:19347/dav?x=1',
    'http://nas:19347/dav#frag',
    'http://user:pw@nas:19347/dav/',
    'ftp://nas:19347/dav/',
    'nas:19347/dav/',
    'not a url',
    'http://nas:19347/dav/../other/',
    '',
  ]
  const disagreements = []
  for (const address of addresses) {
    const judged = normalizeWebdavUrl(address)
    let clientAccepts = true
    try {
      new WebDavClient({ baseUrl: address, username: 'u', passwordHash: '0'.repeat(32) })
    } catch {
      clientAccepts = false
    }
    // The saved form (what the route would store) must be usable by the client.
    let savedUsable = false
    if (judged.ok) {
      try {
        new WebDavClient({ baseUrl: judged.url, username: 'u', passwordHash: '0'.repeat(32) })
        savedUsable = true
      } catch {
        savedUsable = false
      }
    }
    if (!judged.ok && clientAccepts) disagreements.push(`${JSON.stringify(address)}: route refuses, client accepts`)
    if (judged.ok && !savedUsable) disagreements.push(`${JSON.stringify(address)}: route stores ${judged.url}, client refuses it`)
    if (judged.ok && !clientAccepts && address !== 'http://nas:19347' && address !== 'https://nas.example/dav') {
      // Only the "add the slash" cases may differ, and only in that direction.
      disagreements.push(`${JSON.stringify(address)}: route accepts a raw form the client refuses`)
    }
  }
  check('the save route and the client agree on every address', disagreements.length === 0, disagreements.join(' | '))
  check('...the trailing slash is added rather than demanded', normalizeWebdavUrl('http://nas:19347/dav').url === 'http://nas:19347/dav/', JSON.stringify(normalizeWebdavUrl('http://nas:19347/dav')))
  // A bare host is **already** a collection: `new URL('http://nas:19347').pathname` is `/`, so nothing is
  // appended and the stored address is the one that was typed. (Assuming an empty pathname here once led me
  // to "fix" a doubling that could not happen.)
  check('...without touching an address that is already a collection', normalizeWebdavUrl('http://nas:19347').url === 'http://nas:19347/', JSON.stringify(normalizeWebdavUrl('http://nas:19347')))
  check('...or one with a path that already ends in a slash', normalizeWebdavUrl('http://nas/dav/').url === 'http://nas/dav/', JSON.stringify(normalizeWebdavUrl('http://nas/dav/')))
  check(
    '...while the client still refuses a path that lacks the slash',
    normalizeWebdavUrl('http://nas/dav', { allowTrailingSlashFix: false }).ok === false,
    JSON.stringify(normalizeWebdavUrl('http://nas/dav', { allowTrailingSlashFix: false })),
  )
  check('...and a plain-http address is reported as such', normalizeWebdavUrl('http://nas/').insecure === true && normalizeWebdavUrl('https://nas/').insecure === false)
  // `new URL('http:///dav')` does **not** fail: WHATWG drops the empty authority and reads `dav` as the
  // host, so accepting it would silently point the sync at another machine.
  const missingHost = normalizeWebdavUrl('http:///dav')
  check('...a URL with no host is refused rather than retargeted', missingHost.ok === false && /no host/.test(missingHost.reason), JSON.stringify(missingHost))
  check('...likewise a scheme with an empty authority', normalizeWebdavUrl('http:nas').ok === false, JSON.stringify(normalizeWebdavUrl('http:nas')))
  // An encoded slash is not a slash to Apache, and appending a real one after it makes a path nobody meant.
  const encodedSlash = normalizeWebdavUrl('http://nas/dav%2f')
  check('...and an encoded slash in the path is refused by name', encodedSlash.ok === false && /%2f/.test(encodedSlash.reason), JSON.stringify(encodedSlash))
  check('...while a percent-encoded space is left alone, because it is a real character in a name', normalizeWebdavUrl('http://nas/my%20dir').url === 'http://nas/my%20dir/', JSON.stringify(normalizeWebdavUrl('http://nas/my%20dir')))
}

const md5 = (value) => createHash('md5').update(value).digest('hex')

/** The RFC 2617 §3.5 example, verbatim: it is the one digest everybody can check by hand. */
const RFC = {
  username: 'Mufasa',
  password: 'Circle Of Life',
  realm: 'testrealm@host.com',
  nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
  uri: '/dir/index.html',
  method: 'GET',
  cnonce: '0a4f113b',
  nc: '00000001',
  opaque: '5ccc069c403ebaf9f0171e9517f40e41',
  expected: '6629fae49393a05397450978507c4ef1',
}

// ── 1. challenge parsing ─────────────────────────────────────────────────────
{
  const parsed = parseChallenge({
    'www-authenticate': `Digest realm="${RFC.realm}", qop="auth", nonce="${RFC.nonce}", opaque="${RFC.opaque}"`,
  })
  check('a challenge is parsed into fields', parsed?.realm === RFC.realm && parsed?.nonce === RFC.nonce && parsed?.qop === 'auth', JSON.stringify(parsed))

  const withComma = parseChallenge({ 'www-authenticate': 'Digest realm="a,b=c, d", nonce="n1", qop="auth"' })
  check('a realm containing commas and = survives parsing', withComma?.realm === 'a,b=c, d', JSON.stringify(withComma))

  const folded = parseChallenge({ 'www-authenticate': 'Digest realm="WebDAV",\r\n nonce="n2",\r\n qop="auth"' })
  check('a folded header (a proxy may do it) is unfolded', folded?.nonce === 'n2' && folded?.realm === 'WebDAV', JSON.stringify(folded))

  const list = parseChallenge({ 'www-authenticate': 'Basic realm="x", Digest realm="y", nonce="n3"' })
  check('the first Digest challenge wins over an earlier Basic one', list?.realm === 'y', JSON.stringify(list))

  check('no header at all is null, not a crash', parseChallenge({}) === null)
  check('a non-digest header is null', parseChallenge({ 'www-authenticate': 'Basic realm="x"' }) === null)
}

// ── 2. the RFC 2617 vector ───────────────────────────────────────────────────
{
  const authorization = buildAuthorization({
    challenge: { realm: RFC.realm, nonce: RFC.nonce, qop: 'auth', opaque: RFC.opaque },
    method: RFC.method,
    uri: RFC.uri,
    username: RFC.username,
    password: RFC.password,
    cnonce: RFC.cnonce,
    nonceCount: 1,
  })
  const response = /response="([0-9a-f]+)"/.exec(authorization)?.[1]
  check('RFC 2617 §3.5: the response matches the published value', response === RFC.expected, `${response} vs ${RFC.expected}`)
  check('RFC: the client nonce and nonce count are the ones supplied', authorization.includes(`cnonce="${RFC.cnonce}"`) && authorization.includes('nc=00000001'))
  check('RFC: the opaque field is echoed', authorization.includes(`opaque="${RFC.opaque}"`))
  check('RFC: the header starts with the scheme and keeps the documented field order', authorization.startsWith(`Digest username="${RFC.username}", realm="${RFC.realm}", nonce="${RFC.nonce}", uri="${RFC.uri}", qop=auth, nc=00000001, cnonce="${RFC.cnonce}", response="${RFC.expected}"`), authorization)

  // The vector proves `qop=auth`. The other half of the same example (RFC 2069) is a
  // different formula, so it is checked against a hash computed here rather than quoted.
  const noQop = buildAuthorization({
    challenge: { realm: RFC.realm, nonce: RFC.nonce, algorithm: 'MD5' },
    method: RFC.method,
    uri: RFC.uri,
    username: RFC.username,
    password: RFC.password,
  })
  const ha1 = md5(`${RFC.username}:${RFC.realm}:${RFC.password}`)
  const ha2 = md5(`${RFC.method}:${RFC.uri}`)
  check('an RFC 2069 challenge (no qop) uses the three-part formula', noQop.includes(`response="${md5(`${ha1}:${RFC.nonce}:${ha2}`)}"`), noQop)
  check('...and carries no nc, cnonce or qop', !/nc=|cnonce=|qop=/.test(noQop), noQop)
  check('...and states algorithm=MD5 when the server did', noQop.includes('algorithm=MD5'), noQop)
}

// ── 3. refusals are named, not silently downgraded ───────────────────────────
{
  const sha = unsupportedChallenge({ realm: 'r', nonce: 'n', algorithm: 'SHA-256' })
  check('SHA-256 is refused by name', sha.some((problem) => problem.includes('algorithm=sha-256')), JSON.stringify(sha))
  const sess = unsupportedChallenge({ realm: 'r', nonce: 'n', algorithm: 'MD5-sess' })
  check('MD5-sess is refused by name', sess.some((problem) => problem.includes('md5-sess')), JSON.stringify(sess))
  const integrity = unsupportedChallenge({ realm: 'r', nonce: 'n', qop: 'auth-int' })
  check('auth-int-only is refused by name', integrity.some((problem) => problem.includes('auth-int')), JSON.stringify(integrity))
  const both = unsupportedChallenge({ realm: 'r', nonce: 'n', qop: 'auth,auth-int' })
  check('a challenge offering auth and auth-int is accepted (auth is usable)', both.length === 0, JSON.stringify(both))
  check('MD5 is accepted', unsupportedChallenge({ realm: 'r', nonce: 'n', algorithm: 'MD5', qop: 'auth' }).length === 0)
  check('no algorithm field is accepted (it means MD5)', unsupportedChallenge({ realm: 'r', nonce: 'n', qop: 'auth' }).length === 0)

  let threw = null
  try {
    buildAuthorization({ challenge: { realm: 'r', nonce: 'n', algorithm: 'SHA-256' }, method: 'GET', uri: '/', username: 'u', password: 'p' })
  } catch (error) {
    threw = error.message
  }
  check('building a header for an unsupported challenge throws instead of guessing', /not supported/.test(String(threw)), String(threw))
}

// ── 4. the request-target is handed over exactly as it goes on the wire ──────
{
  const client = new WebDavClient({ baseUrl: 'http://host:19347/dav/', username: 'u', password: 'p', allowInsecureTls: false })
  const cases = [
    ['a%20b/x.json', '/dav/a%20b/x.json'],
    ['pricing.json', '/dav/pricing.json'],
    ['sub//double.json', '/dav/sub//double.json'],
  ]
  for (const [input, expected] of cases) {
    const target = WebDavClient.target(client.url(input))
    check(`the request-target keeps the wire form: ${input}`, target === expected, `${target} vs ${expected}`)
  }
  let escaped = null
  try {
    client.url('../../etc/passwd')
  } catch (error) {
    escaped = error.message
  }
  check('a path that climbs out of the base is refused', /refusing to escape/.test(String(escaped)), String(escaped))
  check('plain http:// is called out rather than accepted silently', typeof client.insecureWarning === 'string')
}

// ── 5. end to end against a server that verifies digest ──────────────────────
const server = await startFakeWebDav()
const client = new WebDavClient({ baseUrl: server.url, username: 'alice', password: 'secret1234' })
try {
  const options = await client.options()
  check('OPTIONS authenticates and reports DAV compliance', options.status === 200 && options.dav.includes('1'), JSON.stringify(options))
  check('the realm the server sent is captured', options.realm === 'WebDAV', String(options.realm))
  check('the first request was the challenge round trip and the second was authenticated', server.state.requests.length === 2 && server.state.denied.length === 0, JSON.stringify(server.state.requests))

  const created = await client.mkcol('usage-badge-test/')
  check('MKCOL creates the collection', created === true, String(created))
  const again = await client.mkcol('usage-badge-test/')
  check('MKCOL on an existing collection is not an error', again === false, String(again))

  const payload = Buffer.from(String.fromCharCode(...Array.from({ length: 512 }, (_, i) => i % 251)))
  const etag = await client.put('usage-badge-test/shard.bin', payload, { contentType: 'application/octet-stream' })
  check('PUT stores bytes and returns an etag', typeof etag === 'string' && etag.length > 2, String(etag))
  check('the server saw the same bytes', server.state.files.get('/usage-badge-test/shard.bin')?.equals(payload) === true)

  const fetched = await client.get('usage-badge-test/shard.bin')
  check('GET returns the same bytes unchanged', fetched?.equals(payload) === true, `${fetched?.length} bytes`)

  const missing = await client.get('usage-badge-test/nope.bin')
  check('GET of a missing resource is null, not an error', missing === null)

  const children = await client.propfind('usage-badge-test/')
  check('PROPFIND lists the collection’s children, not itself', children.length === 1 && children[0].name === 'shard.bin', JSON.stringify(children))
  check('...and reports it as a resource with a size', children[0].collection === false && children[0].bytes === payload.length, JSON.stringify(children[0]))

  const moved = await client.move('usage-badge-test/shard.bin', 'usage-badge-test/2026-09.bin')
  check('MOVE renames within the base', moved === true)
  check('...and the bytes survived the move', server.state.files.get('/usage-badge-test/2026-09.bin')?.equals(payload) === true)
  check('...and the source is gone', server.state.files.has('/usage-badge-test/shard.bin') === false)

  let refusedMove = null
  await client.put('usage-badge-test/other.bin', Buffer.from('other'))
  try {
    await client.move('usage-badge-test/other.bin', 'usage-badge-test/2026-09.bin')
  } catch (error) {
    refusedMove = error.message
  }
  check('MOVE with overwrite off refuses to clobber an existing shard', /already exists/.test(String(refusedMove)), String(refusedMove))

  const removed = await client.delete('usage-badge-test/2026-09.bin')
  check('DELETE removes the resource', removed === true && server.state.files.has('/usage-badge-test/2026-09.bin') === false)
  check('DELETE of something already gone is not an error', (await client.delete('usage-badge-test/nope.bin')) === false)

  check('every request that reached the server was authenticated', server.state.denied.length === 0, server.state.denied.join(' | '))
} finally {
  await server.close()
}

// ── 6. nonce lifetimes: preemption, rotation, and the retry budget ───────────
{
  const rotating = await startFakeWebDav({ staleOnce: true })
  const client = new WebDavClient({ baseUrl: rotating.url, username: 'alice', password: 'secret1234' })
  try {
    const first = await client.options()
    check('a stale=true refusal is retried with the new nonce, not reported as bad credentials', first.status === 200, JSON.stringify(first))
    const second = await client.options()
    check('...and the next request reuses the nonce with a single round trip', second.status === 200 && rotating.state.requests.length === 4, String(rotating.state.requests.length))
    const counts = [...rotating.state.counts.values()].filter((count) => count > 0)
    check('the rotated nonce was used twice (nc 1 then 2) and the abandoned one never', counts.length === 1 && counts[0] === 2, JSON.stringify([...rotating.state.counts.entries()]))
  } finally {
    await rotating.close()
  }

  const always = await startFakeWebDav({ challengeEveryRequest: true })
  const client2 = new WebDavClient({ baseUrl: always.url, username: 'alice', password: 'secret1234' })
  try {
    let message = null
    try {
      await client2.options()
    } catch (error) {
      message = error.message
    }
    check('a server that keeps challenging ends in one clear failure, not a loop', /401 — the username, password or realm is wrong/.test(String(message)), String(message))
    check('...and it never sent the password in the clear', always.state.requests.every((entry) => !JSON.stringify(entry).includes('secret1234')))
  } finally {
    await always.close()
  }

  const wrong = await startFakeWebDav()
  const client3 = new WebDavClient({ baseUrl: wrong.url, username: 'alice', password: 'not-the-password' })
  try {
    let message = null
    try {
      await client3.options()
    } catch (error) {
      message = error.message
    }
    check('a wrong password is reported as an authentication failure', /username, password or realm is wrong/.test(String(message)), String(message))
    check('the server recorded why it refused', wrong.state.denied.some((reason) => /response mismatch/.test(reason)), wrong.state.denied.join(' | '))
  } finally {
    await wrong.close()
  }
}

// ── 7. an RFC 2069 server (no qop) ───────────────────────────────────────────
{
  const old = await startFakeWebDav({ qop: null })
  const client = new WebDavClient({ baseUrl: old.url, username: 'alice', password: 'secret1234' })
  try {
    check('an RFC 2069 challenge is served without qop', (await client.options()).status === 200)
    await client.put('x.bin', Buffer.from('hello'))
    check('...and a PUT through it lands', old.state.files.get('/x.bin')?.toString() === 'hello')
  } finally {
    await old.close()
  }
}

// ── 8. refusals happen before any request is sent ────────────────────────────
{
  for (const [label, options, expected] of [
    ['a SHA-256 challenge', { algorithm: 'SHA-256' }, /not supported.*algorithm=sha-256/i],
    ['a Basic-only server', { scheme: 'Basic' }, /did not offer Digest/],
  ]) {
    const hostile = await startFakeWebDav(options)
    const client = new WebDavClient({ baseUrl: hostile.url, username: 'alice', password: 'secret1234' })
    try {
      let message = null
      try {
        await client.options()
      } catch (error) {
        message = error.message
      }
      check(`${label} is refused with a reason you can act on`, expected.test(String(message)), String(message))
    } finally {
      await hostile.close()
    }
  }
}

// ── 9. URL hygiene ───────────────────────────────────────────────────────────
{
  const bad = [
    ['a base with no trailing slash', 'http://host:19347/dav'],
    ['credentials inside the URL', 'http://u:p@host:19347/'],
    ['a query on the base', 'http://host:19347/?x=1'],
    ['a non-http scheme', 'ftp://host/'],
  ]
  for (const [label, baseUrl] of bad) {
    let message = null
    try {
      new WebDavClient({ baseUrl, username: 'u', password: 'p' })
    } catch (error) {
      message = error.message
    }
    check(`refused at construction: ${label}`, message !== null, String(message))
  }
  // `LOCATION` may put the DAV root under a subpath (bytemark's `Alias` maps it to the data
  // directory), so everything the client builds must stay under that prefix.
  const sub = new WebDavClient({ baseUrl: 'http://host:19347/dav/', username: 'u', password: 'p' })
  check('a sub-path base keeps its prefix in the request-target', WebDavClient.target(sub.url('usage-badge/x.json')) === '/dav/usage-badge/x.json', WebDavClient.target(sub.url('usage-badge/x.json')))
  const root = new WebDavClient({ baseUrl: 'http://host:19347/', username: 'u', password: 'p' })
  check('a root base keeps none', WebDavClient.target(root.url('usage-badge/x.json')) === '/usage-badge/x.json', WebDavClient.target(root.url('usage-badge/x.json')))
}

finish()
