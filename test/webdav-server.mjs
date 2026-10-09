/**
 * A throwaway WebDAV server for the offline half of the sync tests.
 *
 * It answers the seven methods the sync uses, and — the part that matters — it *verifies*
 * the digest response the client computed, exactly as Apache's `mod_auth_digest` does:
 * `MD5(HA1:nonce:nc:cnonce:qop:HA2)` with `HA1 = MD5(user:realm:pass)`. A client that gets
 * any field of that wrong (a decoded `uri`, a reused `nc`, a missing `opaque`) fails here,
 * offline, instead of against a container someone has to keep running.
 *
 * Deliberate misbehaviours are switchable, because a client is only as good as its handling
 * of them:
 *
 *   - `qop: null`  → an RFC 2069 challenge (no qop, no nc, no cnonce);
 *   - `staleOnce`  → the first authenticated request is refused with `stale=true`;
 *   - `algorithm`  → a challenge this build must refuse by name;
 *   - `scheme`     → `Basic` only, which must produce "not Digest" rather than a fallback.
 *
 * It is a plain object, not a test framework: the suite drives it and asserts on the result.
 *
 * @module dsh-usage-badge/test/webdav-server
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const md5 = (value) => createHash('md5').update(value).digest('hex')

/** Parse `Digest k=v, k="v"` into a lowercase-keyed object. */
function parseAuthorization(header) {
  const out = {}
  if (!header) return out
  const body = header.replace(/^\s*Digest\s+/i, '')
  const pattern = /([a-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,]*)/gi
  let match
  while ((match = pattern.exec(body)) !== null) {
    const raw = match[2].trim()
    out[match[1].toLowerCase()] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
  }
  return out
}

/** Percent-decode one path segment set, leaving everything else alone. */
const decodePath = (pathname) => {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

/**
 * Start the fake server.
 *
 * @param {{username?:string, password?:string, realm?:string, qop?:string|null,
 *   challengeEveryRequest?:boolean, staleOnce?:boolean, algorithm?:string, scheme?:string,
 *   documentRoot?:boolean}} [options]
 */
export async function startFakeWebDav(options = {}) {
  const config = {
    username: 'alice',
    password: 'secret1234',
    realm: 'WebDAV',
    qop: 'auth',
    challengeEveryRequest: false,
    staleOnce: false,
    algorithm: 'MD5',
    scheme: 'Digest',
    ...options,
  }
  const state = {
    files: new Map(),
    /** Collection paths, so `MKCOL` can report 405 for one that already exists. */
    collections: new Set(),
    nonces: new Set(),
    /** nonce → the highest `nc` accepted for it, so a reuse is caught. */
    counts: new Map(),
    issued: 0,
    staleNext: config.staleOnce,
    requests: [],
    denied: [],
  }

  const issueNonce = () => {
    state.issued++
    const nonce = `fake-nonce-${state.issued}-${md5(`${state.issued}:${config.realm}`).slice(0, 16)}`
    state.nonces.add(nonce)
    state.counts.set(nonce, 0)
    return nonce
  }

  const challenge = (nonce, stale) => {
    const parts = [`realm="${config.realm}"`, `nonce="${nonce}"`, 'opaque="fake-opaque"']
    if (config.algorithm) parts.push(`algorithm=${config.algorithm}`)
    if (config.qop) parts.push(`qop="${config.qop}"`)
    if (stale) parts.push('stale=true')
    return `${config.scheme} ${parts.join(', ')}`
  }

  /** Verify a digest response the way mod_auth_digest does. */
  const verify = (authorization, method, uri) => {
    const fields = parseAuthorization(authorization)
    if (!fields.username || !fields.response || !fields.nonce) return { ok: false, reason: 'incomplete Authorization header' }
    if (fields.username !== config.username) return { ok: false, reason: `unknown user ${fields.username}` }
    if (fields.uri !== uri) return { ok: false, reason: `uri mismatch: header said ${fields.uri}, request line said ${uri}` }
    if (!state.nonces.has(fields.nonce)) return { ok: false, reason: `unknown nonce ${fields.nonce}`, stale: true }
    const ha1 = md5(`${config.username}:${config.realm}:${config.password}`)
    const ha2 = md5(`${method}:${uri}`)
    let expected
    if (config.qop) {
      if (!fields.nc || !fields.cnonce || fields.qop !== config.qop) {
        return { ok: false, reason: `qop fields missing or wrong: qop=${fields.qop} nc=${fields.nc} cnonce=${!!fields.cnonce}` }
      }
      const seen = state.counts.get(fields.nonce) ?? 0
      const count = Number.parseInt(fields.nc, 16)
      if (!Number.isFinite(count)) return { ok: false, reason: `nc is not hex: ${fields.nc}` }
      if (count <= seen) return { ok: false, reason: `nc went backwards or repeated: ${fields.nc} after ${seen.toString(16)}` }
      state.counts.set(fields.nonce, count)
      expected = md5(`${ha1}:${fields.nonce}:${fields.nc}:${fields.cnonce}:${config.qop}:${ha2}`)
    } else {
      if (fields.qop || fields.nc || fields.cnonce) return { ok: false, reason: 'RFC 2069 challenge was answered with qop fields' }
      expected = md5(`${ha1}:${fields.nonce}:${ha2}`)
    }
    if (fields.response !== expected) return { ok: false, reason: `response mismatch (see RFC 2617 for the expected shape)` }
    return { ok: true, fields }
  }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const uri = req.url
      const path = decodePath(uri.split('?')[0])
      const method = req.method.toUpperCase()
      state.requests.push({ method, path, body: body.length })

      /** Record the header a failing test can inspect, without keeping credentials. */
      const fields = parseAuthorization(req.headers.authorization)
      state.lastAuth = req.headers.authorization ? { username: fields.username, uri: fields.uri, nc: fields.nc, algorithm: fields.algorithm } : null

      const refuse = (nonce, stale) => {
        res.writeHead(401, {
          'www-authenticate': challenge(nonce, stale),
          'content-type': 'text/plain',
        })
        res.end('unauthorized')
      }

      const cached = req.headers.authorization
      // A `stale=true` refusal means "your credentials are fine, this nonce is not" — so it must
      // be forced *before* verification. Forcing it after a signature check would never fire: the
      // retry that follows a challenge carries a perfectly valid response, only a new `nc`.
      const servedNonce = cached ? parseAuthorization(cached).nonce : null
      if (cached && state.staleNext && servedNonce !== null) {
        state.staleNext = false
        refuse(issueNonce(), true)
        return
      }
      if (!cached || config.challengeEveryRequest) {
        refuse(issueNonce(), false)
        return
      }
      const result = verify(cached, method, uri)
      if (!result.ok) {
        state.denied.push(result.reason)
        // An unknown nonce is what a restarted server looks like, so it is echoed with
        // `stale=true`; every other rejection is a plain 401 the client must not retry.
        refuse([...state.nonces][0], result.stale === true)
        return
      }

      const send = (status, headers = {}, payload = Buffer.alloc(0)) => {
        res.writeHead(status, { 'content-length': String(payload.length), ...headers })
        res.end(payload)
      }

      if (method === 'OPTIONS') {
        send(200, { dav: '1,2', allow: 'OPTIONS, PROPFIND, MKCOL, GET, PUT, DELETE, MOVE' })
        return
      }
      if (method === 'GET') {
        if (!state.files.has(path)) return send(404)
        send(200, { 'content-type': 'application/octet-stream' }, state.files.get(path))
        return
      }
      if (method === 'PUT') {
        const existed = state.files.has(path)
        state.files.set(path, body)
        send(existed ? 204 : 201, { etag: `"${md5(body)}"` })
        return
      }
      if (method === 'DELETE') {
        // A missing resource is 404, as Apache answers it: the client's "already gone is not an
        // error" path only means something if the server really reports the miss.
        if (!state.files.delete(path)) return send(404)
        send(204)
        return
      }
      if (method === 'MKCOL') {
        // Collections are recorded with the same leading slash the file map uses, so that a lookup by
        // path and a listing agree on what a child is called.
        const canonical = `/${path.replace(/^\/+/, '')}`
        // The real `mod_dav_fs` refuses a collection whose parent is missing (409, or 403 for some
        // builds). Modelling that is what catches a client that creates `a/b/` without creating `a/`
        // — an ordering bug that would otherwise only show up against a live server.
        const parent = canonical.replace(/[^/]+\/?$/, '')
        if (parent !== '' && parent !== '/' && !state.collections.has(parent)) return send(409)
        const existed = state.collections.has(canonical)
        // Mkdir -p semantics for the ancestors, as a WebDAV client expects once the parent check has
        // passed: every ancestor collection has to be listable, or `PROPFIND` would not show the tree.
        let prefix = ''
        for (const part of canonical.split('/').filter(Boolean)) {
          prefix += `/${part}`
          state.collections.add(`${prefix}/`)
        }
        state.collections.add(canonical)
        send(existed ? 405 : 201)
        return
      }
      if (method === 'MOVE') {
        const destination = req.headers.destination
        if (!destination) return send(400)
        const target = decodePath(new URL(destination, 'http://x').pathname)
        if (!state.files.has(path)) return send(404)
        if (state.files.has(target) && String(req.headers.overwrite ?? 'T').toUpperCase() === 'F') return send(412)
        state.files.set(target, state.files.get(path))
        state.files.delete(path)
        send(201)
        return
      }
      if (method === 'PROPFIND') {
        const prefix = path.endsWith('/') ? path : `${path}/`
        // Children of this collection: the files directly inside it, plus the collections whose
        // parent is this one. A real `mod_dav_fs` lists both; a mock that only listed files would
        // hide the device directories this sync discovers by name.
        const children = new Set([...state.files.keys()].filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/')))
        for (const collection of state.collections) {
          if (!collection.startsWith(prefix) || collection === prefix) continue
          const rest = collection.slice(prefix.length).replace(/\/$/, '')
          if (rest && !rest.includes('/')) children.add(collection)
        }
        const entries = [path, ...[...children].sort()]
        const xml =
          '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">' +
          entries
            .map((entry) => {
              const isFile = state.files.has(entry)
              return (
                `<D:response><D:href>${entry}</D:href><D:propstat><D:prop>` +
                `<D:resourcetype>${isFile ? '' : '<D:collection/>'}</D:resourcetype>` +
                `<D:getcontentlength>${isFile ? state.files.get(entry).length : 0}</D:getcontentlength>` +
                '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'
              )
            })
            .join('') +
          '</D:multistatus>'
        send(207, { 'content-type': 'application/xml; charset=utf-8' }, Buffer.from(xml))
        return
      }
      send(405)
    })
  })

  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}/`,
    state,
    config,
    async seed(path, contents) {
      state.files.set(path, Buffer.from(contents))
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
