/**
 * dsh-usage-badge — the WebDAV client the cloud sync rides on.
 *
 * Hand-written rather than borrowed, for two reasons:
 *
 *   - **`fetch` cannot do Digest.** There is no hook for "send, read the 401 challenge,
 *     compute a response, retry" — undici's `credentials` are the browser's model, not
 *     digest's. So the request layer is `node:http`/`node:https`, and this module owns the
 *     whole handshake.
 *   - **the target is a known server, not "WebDAV in general".** The design deliberately
 *     supports only what `bytemark/webdav` (Apache httpd + mod_dav_fs) offers: `MD5` and
 *     `qop=auth`. Everything else — `SHA-256`, `algorithm=MD5-sess`, `qop=auth-int`, RFC
 *     2069's *use* of `auth-int`, `Basic` — is refused **by name**, so pointing this at a
 *     different server (Nextcloud, Synology) fails with a sentence you can act on rather
 *     than with a silent downgrade.
 *
 * `qop` **absent** is not refused: that is RFC 2069, which Apache can still serve
 * (`AuthDigestQop none`), and it is a small, well-specified path.
 *
 * Scope: `OPTIONS`, `PROPFIND`, `MKCOL`, `GET`, `PUT`, `DELETE`, `MOVE`. No `LOCK` — the
 * sync uses optimistic concurrency (compare the shard hash, then write) instead, because a
 * crashed client would otherwise leave a lock behind that makes every later `PUT` fail with
 * 423 until someone clears it by hand. No redirect following either: this server aliases
 * `/` to the DAV root and answers a `PROPFIND` on a directory without its trailing slash
 * with a 301, and the design wants that visible rather than silently chased.
 *
 * @module dsh-usage-badge/webdav
 */

import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** How long a request may take before it is abandoned. */
export const CONNECT_TIMEOUT_MS = 15000

/** Uploads are bigger and slower than the rest; a separate, longer budget. */
export const UPLOAD_TIMEOUT_MS = 60000

const DEFAULT_PORT = { 'http:': 80, 'https:': 443 }

/** RFC 7616 wants at least 64 bits of client entropy; 16 bytes is 128. */
const CNONCE_BYTES = 16

/**
 * How many times credentials may be re-sent for one request, beyond the initial handshake.
 *
 * Two, not one, because a `stale=true` rotation can legitimately arrive on a request that
 * already handshook — a long upload that outlives the nonce, or a container restarting
 * mid-sync. A third refusal is treated as a wrong password rather than retried: probing
 * credentials repeatedly is how an account gets locked out.
 */
const MAX_HANDSHAKES = 2

/** `nc` is exactly eight lowercase hex digits. */
const NONCE_COUNT_WIDTH = 8

/**
 * The digest parameters this build understands in a challenge.
 *
 * `algorithm` is stored raw (lowercased) so the refusal message can quote what the server
 * actually said, rather than what this module wishes it had said.
 */
const SUPPORTED = {
  algorithm: new Set(['', 'md5']),
  qop: new Set(['auth', '']),
}

/**
 * Quote a value for the `Authorization` header.
 *
 * Backslash and double quote are the only two characters the header grammar cannot carry
 * raw; both are escaped rather than rejected, because an unusual realm must not turn into
 * an unexplained 401 loop.
 */
const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Untaint a header parameter: strip the surrounding quotes and undo the escaping. */
const unquote = (value) => {
  const trimmed = String(value).trim()
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"')) || trimmed.length < 2) return trimmed
  return trimmed.slice(1, -1).replace(/\\(.)/g, '$1')
}

/**
 * Parse param=value pairs out of a header chunk, honouring quoted strings.
 *
 * Written by hand because `WWW-Authenticate` is not JSON and a `realm` may legally contain
 * commas and `=` — a naive `split(',')` would cut it in half and produce a digest that never
 * validates, with no clue why.
 */
function parseParams(source) {
  const params = {}
  let i = 0
  while (i < source.length) {
    while (i < source.length && (source[i] === ',' || source[i] === ' ' || source[i] === '\t')) i++
    const nameStart = i
    while (i < source.length && source[i] !== '=' && source[i] !== ',') i++
    const name = source.slice(nameStart, i).trim().toLowerCase()
    if (name === '') {
      i++ // a bare comma, or the trailing space of `Digest` — nothing to record
      continue
    }
    while (i < source.length && source[i] === ' ') i++
    if (source[i] !== '=') {
      params[name] = ''
      continue
    }
    i++ // '='
    while (i < source.length && source[i] === ' ') i++
    if (source[i] === '"') {
      i++
      let value = ''
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) i++
        value += source[i]
        i++
      }
      i++ // closing quote
      params[name] = unquote(`"${value}"`)
    } else {
      const valueStart = i
      while (i < source.length && source[i] !== ',') i++
      params[name] = source.slice(valueStart, i).trim()
    }
  }
  return params
}

/**
 * The digest challenge a response is asking for, or `null` when it carries none.
 *
 * A `WWW-Authenticate` header may offer several schemes; the first `Digest` one wins, and
 * `Basic` sitting before it does not make this module agree to send a password in the clear.
 * Header folding (obs-fold) is unfolded first because Apache does not emit it but a proxy
 * between here and the server might.
 */
export function parseChallenge(headers = {}) {
  const raw = headers['www-authenticate']
  if (!raw) return null
  const header = String(Array.isArray(raw) ? raw.join(', ') : raw).replace(/\r?\n\s+/g, ' ')
  const match = /(^|,)\s*digest\s+/i.exec(header)
  if (!match) return null
  return parseParams(header.slice(match.index + match[0].length))
}

/**
 * The parameters this build cannot honour, named.
 *
 * Returned as a list rather than thrown so a caller can decide where the message belongs —
 * and so the test can assert on exactly which fields trip it.
 */
export function unsupportedChallenge(challenge) {
  const problems = []
  const algorithm = String(challenge?.algorithm ?? '').trim().toLowerCase()
  const qopRaw = challenge?.qop
  if (!SUPPORTED.algorithm.has(algorithm)) {
    problems.push(
      `algorithm=${algorithm} (this server must use MD5; bytemark/webdav cannot do SHA-256, and MD5-sess is broken in Apache itself)`,
    )
  }
  // A challenge may offer a list (`qop="auth,auth-int"`); only the `auth` member is usable,
  // because `auth-int` would require hashing the whole body and Apache does not implement it.
  const offered = String(qopRaw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '')
  if (offered.length > 0 && !offered.includes('auth')) {
    problems.push(`qop=${offered.join(',')} (only qop=auth is implemented; auth-int is not)`)
  }
  return problems
}

/** A fresh client nonce; hex so it is header-safe. */
const newCnonce = () => randomBytes(CNONCE_BYTES).toString('hex')

/** The `nc` value: a counter, eight lowercase hex digits, started at 1. */
const formatNonceCount = (count) => count.toString(16).padStart(NONCE_COUNT_WIDTH, '0')

/**
 * The `Authorization` header for one request, built from the server's challenge.
 *
 * Exported because the whole point of the design is that this is testable without a socket:
 * the RFC 2617/7616 vectors are asserted against this function directly.
 *
 * `uri` must be the request-target **exactly as it goes on the wire** — path plus query, with
 * percent-escapes intact. Decoding it (or re-encoding a decoded one) is the classic way to
 * produce a digest that never validates.
 *
 * @param {{challenge:object, method:string, uri:string, username:string, password:string,
 *   cnonce?:string, nonceCount?:number, nc?:string, body?:Buffer}} options
 * @returns {string} ready for the `Authorization` header.
 */
export function buildAuthorization({ challenge, method, uri, username, password, passwordHash, cnonce, nonceCount = 1 }) {
  const realm = String(challenge?.realm ?? '')
  const nonce = String(challenge?.nonce ?? '')
  const algorithm = String(challenge?.algorithm ?? '').trim().toLowerCase()
  const problems = unsupportedChallenge(challenge)
  if (problems.length > 0) throw new Error(`this server's Digest challenge is not supported: ${problems.join('; ')}`)
  if (!nonce) throw new Error('the Digest challenge carries no nonce')

  const hash = (value) => createHash('md5').update(value).digest('hex')
  // `passwordHash` is the HA1 the server itself stores (`MD5(user:realm:pass)`). Accepting it means
  // the credential can be *kept* as the server keeps it — the plaintext never has to be written down
  // — while still producing exactly the same response as the plaintext path.
  const ha1 = passwordHash ? String(passwordHash).toLowerCase() : hash(`${username}:${realm}:${password}`)
  const ha2 = hash(`${method}:${uri}`)
  const fields = [
    `username=${quote(username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(uri)}`,
  ]

  const qop = String(challenge?.qop ?? '').trim().toLowerCase()
  const clientNonce = cnonce ?? newCnonce()
  if (qop === 'auth') {
    const nc = formatNonceCount(nonceCount)
    fields.push(`qop=auth`, `nc=${nc}`, `cnonce=${quote(clientNonce)}`)
    fields.push(`response=${quote(hash(`${ha1}:${nonce}:${nc}:${clientNonce}:auth:${ha2}`))}`)
  } else {
    // RFC 2069: no qop, no nc, no cnonce.
    fields.push(`response=${quote(hash(`${ha1}:${nonce}:${ha2}`))}`)
  }

  if (algorithm === 'md5') fields.push('algorithm=MD5')
  if (challenge?.opaque) fields.push(`opaque=${quote(challenge.opaque)}`)
  return `Digest ${fields.join(', ')}`
}

/** One request's outcome, with the raw body so binary shards survive the trip. */
const transport = (url, { method, headers, body, timeout }) =>
  new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || DEFAULT_PORT[url.protocol],
        method,
        path: `${url.pathname}${url.search}`,
        headers,
        // A fresh socket per request: this client makes a handful of calls per sync, so a
        // pool would only add a way for one broken socket to poison the next request.
        agent: false,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        )
        res.on('error', reject)
      },
    )
    req.setTimeout(timeout, () => req.destroy(new Error(`timed out after ${timeout} ms`)))
    req.on('error', reject)
    if (body && body.length > 0) req.write(body)
    req.end()
  })

/**
 * The one place a WebDAV base URL is judged and normalised.
 *
 * Exported so the **save route** can refuse exactly what the client refuses. When the two had their own
 * copies of this rule the host accepted addresses the client could never use — a query string, embedded
 * credentials, `ftp:` — and the panel stored one and displayed it while the sync could not run at all.
 * Two copies of a rule drift; one copy cannot.
 *
 * @param {string} baseUrl
 * @param {{allowTrailingSlashFix?:boolean}} [options] `allowTrailingSlashFix` appends the slash a
 *   collection needs instead of refusing the address, which is what a person typing a host:port means.
 *   It is the **second** parameter on purpose: a single destructured parameter silently ignores a string
 *   argument and falls back to the permissive default, which is the opposite of failing loudly.
 * @returns {{ok:true, url:string, insecure:boolean} | {ok:false, reason:string}}
 */
export function normalizeWebdavUrl(baseUrl, options = {}) {
  const { allowTrailingSlashFix = true } = options ?? {}
  const text = String(baseUrl ?? '').trim()
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: `this is not a URL: ${baseUrl}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `the URL must be http or https, got ${url.protocol}` }
  }
  // **A host has to be there.** `new URL('http:///dav')` does not fail: WHATWG drops the empty authority
  // and reads `dav` as the host, so a missing hostname silently retargets the address at another machine.
  // Whoever typed three slashes meant to fill something in, not to point somewhere else.
  const afterScheme = text.includes('://') ? text.slice(text.indexOf('://') + 3) : ''
  if (afterScheme === '' || afterScheme.startsWith('/')) {
    return { ok: false, reason: 'the URL has no host — it has to look like http://nas:19347/dav/' }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'put the username and password in their own fields, not in the URL' }
  }
  if (url.search) return { ok: false, reason: 'the URL must not carry a query string' }
  if (url.hash) return { ok: false, reason: 'the URL must not carry a #fragment' }
  // An encoded slash is not a slash to the server: Apache's default `AllowEncodedSlashes` policy answers
  // `%2f` with a 404, and appending a real slash after it produces a path nobody meant. Refused by name so
  // the field says why, instead of being accepted and 404ing at the first request.
  if (/%2f/i.test(url.pathname)) {
    return { ok: false, reason: 'the URL contains an encoded slash (%2f), which this server family rejects by default — write the "/" literally' }
  }
  // `new URL('http://nas:19347').pathname` is `"/"`, not `""`: the root is a collection and already ends
  // in its slash, so this is false for a bare host and nothing is appended. Only a **path** below the root
  // that lacks the slash (`/dav`) reaches the branch.
  if (!/\/$/.test(url.pathname)) {
    if (!allowTrailingSlashFix) {
      // The target is a collection; a WebDAV server answers a slash-less directory with a 301, and
      // chasing that redirect is what makes a missing slash look like a wrong password.
      return { ok: false, reason: `the URL must end with "/" (a collection), got ${baseUrl}` }
    }
    url.pathname = `${url.pathname}/`
  }
  return { ok: true, url: url.toString(), insecure: url.protocol === 'http:' }
}

/**
 * A WebDAV client bound to one server and one set of credentials.
 *
 * The nonce is cached per client because the target server sets no `AuthDigestDomain`
 * (bytemark's `dav.conf` omits it), which per Apache's own documentation makes clients send
 * `Authorization` on *every* request — so the preemptive path is the normal path here, and
 * the 401 round trip happens once per nonce lifetime rather than once per request.
 */
export class WebDavClient {
  /**
   * @param {{baseUrl:string, username:string, password?:string, passwordHash?:string,
   *   allowInsecureTls?:boolean, timeoutMs?:number, uploadTimeoutMs?:number, userAgent?:string}} options
   *   Supply exactly one of `password` (plaintext, hashed per challenge) or `passwordHash` (the
   *   digest HA1, which needs no plaintext at all).
   */
  constructor({ baseUrl, username, password = null, passwordHash = null, allowInsecureTls = false, timeoutMs = CONNECT_TIMEOUT_MS, uploadTimeoutMs = UPLOAD_TIMEOUT_MS, userAgent = 'dsh-usage-badge' }) {
    // The same judgement the save route uses, in one place. `allowTrailingSlashFix` is off here on
    // purpose: a person typing `host:port` should have the slash added for them by the route, but a client
    // constructed from a stored configuration must be handed an address that is already right — silently
    // changing it here would hide a configuration that was written wrong.
    const judged = normalizeWebdavUrl(baseUrl, { allowTrailingSlashFix: false })
    if (!judged.ok) throw new Error(judged.reason)
    if (judged.insecure && !allowInsecureTls) {
      // Digest over plain HTTP is not a secret leak by itself, but it is brute-forceable by a
      // passive eavesdropper. Say so once here; the panel says it again.
      this.insecureWarning = 'this WebDAV URL is plain http://; digest authentication over an unencrypted connection is brute-forceable by anyone who can watch it'
    }
    this.baseUrl = new URL(judged.url)
    this.username = username
    this.password = password
    this.passwordHash = passwordHash
    if (!this.password && !this.passwordHash) throw new Error('a WebDAV credential is required: either a password or its digest HA1')
    this.allowInsecureTls = allowInsecureTls
    this.timeoutMs = timeoutMs
    this.uploadTimeoutMs = uploadTimeoutMs
    this.userAgent = userAgent
    /** The last challenge the server gave, kept so the next request can preempt the 401. */
    this.challenge = null
    this.nonceCount = 0
  }

  /** The absolute URL for one path under the base. The path must stay under the base. */
  url(path) {
    const relative = String(path ?? '').replace(/^\/+/, '')
    const url = new URL(relative, this.baseUrl)
    if (!url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new Error(`refusing to escape the WebDAV base: ${path}`)
    }
    return url
  }

  /** The request-target exactly as it goes on the wire, escapes intact. */
  static target(url) {
    return `${url.pathname}${url.search}`
  }

  /**
   * Send one request, performing the digest handshake as few round trips as possible.
   *
   * The retry rules exist to tell three 401s apart, because they need three different answers:
   *
   *   - **the first one**, carrying no credentials, is the handshake itself — Apache always
   *     sends it (the bytemark image sets no `AuthDigestDomain`, so preemption is per-client
   *     state, not something the server invites). It must not consume the retry budget;
   *   - **`stale=true`** means "your credentials are fine, this nonce is not" — a restarted
   *     container looks exactly like this, and the answer is to retry with the new nonce;
   *   - **anything else** is a real refusal (wrong password, or a realm whose password file does
   *     not match) and must be reported, not retried into a lockout.
   */
  async request(method, path, { headers = {}, body = null, expect = null } = {}) {
    const url = this.url(path)
    const target = WebDavClient.target(url)
    const payload = body === null || body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(body)
    const timeout = payload ? this.uploadTimeoutMs : this.timeoutMs
    const base = {
      'user-agent': this.userAgent,
      accept: '*/*',
      connection: 'close',
      ...(payload ? { 'content-length': String(payload.length) } : {}),
      ...headers,
    }

    /** Round trips spent re-sending credentials; the handshake itself is not one of them. */
    let handshakes = 0
    for (;;) {
      const withAuth = { ...base }
      if (this.challenge) {
        withAuth.authorization = buildAuthorization({
          challenge: this.challenge,
          method,
          uri: target,
          username: this.username,
          password: this.password,
          passwordHash: this.passwordHash,
          nonceCount: ++this.nonceCount,
        })
      }

      let response
      try {
        response = await transport(url, { method, headers: withAuth, body: payload, timeout })
      } catch (error) {
        throw new Error(`${method} ${target} failed: ${error?.message ?? error}`)
      }

      if (response.status !== 401) {
        if (expect !== null && response.status !== expect) {
          throw new Error(`${method} ${target} answered ${response.status} (expected ${expect})`)
        }
        return response
      }

      const challenge = parseChallenge(response.headers)
      const stale = String(challenge?.stale ?? '').toLowerCase() === 'true'
      if (!challenge) {
        const offered = String(response.headers['www-authenticate'] ?? '(none)')
        throw new Error(
          `this server did not offer Digest authentication (WWW-Authenticate: ${offered}); only Digest is implemented`,
        )
      }
      const problems = unsupportedChallenge(challenge)
      if (problems.length > 0) throw new Error(`this server's Digest challenge is not supported: ${problems.join('; ')}`)
      if (!stale && handshakes >= MAX_HANDSHAKES) {
        throw new Error(`${method} ${target} was refused with 401 — the username, password or realm is wrong`)
      }
      // A stale nonce means "retry with these credentials", so the counter restarts.
      this.challenge = challenge
      this.nonceCount = 0
      handshakes++
    }
  }

  /** `OPTIONS` — used to confirm the endpoint is a WebDAV server and to read its realm. */
  async options(path = '') {
    const response = await this.request('OPTIONS', path)
    return {
      status: response.status,
      dav: String(response.headers.dav ?? ''),
      realm: this.challenge?.realm ?? null,
      allow: String(response.headers.allow ?? ''),
    }
  }

  /**
   * Create a collection, including its parent.
   *
   * `mod_dav_fs` does **not** create missing parents: a `MKCOL` on `a/b/` when `a/` does not exist
   * answers 409, which is the answer a real bytemark container gave when the plugin created a device
   * directory before `usage-badge/` existed. Some servers also answer 405 for a collection that is
   * already there, and a race between two devices can produce either — so both are success here.
   *
   * @returns {boolean} whether this call created the collection (false when it already existed).
   */
  async mkcol(path) {
    const segments = String(path ?? '').split('/').filter(Boolean)
    let created = false
    for (let i = 0; i < segments.length; i++) {
      const prefix = `${segments.slice(0, i + 1).join('/')}/`
      const response = await this.request('MKCOL', prefix)
      if (response.status === 201 || response.status === 200) {
        created = true
        continue
      }
      // 201/200 created it; 405 and 409 mean a collection is already there. Apache's `mod_dav_fs`
      // answers **403** for a parent that does not exist (RFC 4918 says 409, and a real bytemark
      // container answered 403 while a device directory was being created before `usage-badge/`
      // existed), so that is treated as "already there" too rather than failing the sync.
      if (response.status === 405 || response.status === 409 || response.status === 403) continue // already a collection
      throw new Error(`MKCOL ${prefix} answered ${response.status}`)
    }
    return created
  }

  /** Fetch a resource, or `null` when it does not exist yet. */
  async get(path) {
    const response = await this.request('GET', path)
    if (response.status === 404) return null
    if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}`)
    return response.body
  }

  /** Write a resource. */
  async put(path, body, { contentType = 'application/octet-stream', ifMatch = null } = {}) {
    const response = await this.request('PUT', path, {
      headers: { 'content-type': contentType, ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      body,
    })
    if (response.status !== 201 && response.status !== 204 && response.status !== 200) {
      throw new Error(`PUT ${path} answered ${response.status}`)
    }
    return response.headers.etag ?? null
  }

  /** Remove a resource; a missing one is success. */
  async delete(path) {
    const response = await this.request('DELETE', path)
    if (response.status === 404) return false
    if (response.status !== 204 && response.status !== 200) throw new Error(`DELETE ${path} answered ${response.status}`)
    return true
  }

  /**
   * Rename within the base.
   *
   * `overwrite: false` is the default because a shard that already exists is data, and the
   * sync uploads to a temporary name first precisely so that the move either lands whole or
   * not at all.
   */
  async move(from, to, { overwrite = false, sourceEtag = null } = {}) {
    const destination = this.url(to)
    const response = await this.request('MOVE', from, {
      headers: {
        destination: destination.href,
        overwrite: overwrite ? 'T' : 'F',
        ...(sourceEtag ? { 'if-match': sourceEtag } : {}),
      },
    })
    if (response.status === 201 || response.status === 204) return true
    if (response.status === 412) throw new Error(`MOVE ${from} refused: the destination already exists (overwrite is off)`)
    throw new Error(`MOVE ${from} answered ${response.status}`)
  }

  /**
   * `PROPFIND` at depth 1, returned as the bare list of child hrefs.
   *
   * Parsed with two regexes rather than an XML parser: the sync needs names, whether each is
   * a collection, and sizes — nothing else. A resource whose `href` cannot be read is skipped
   * rather than failing the whole listing, because a single odd entry (Apache leaves `|`-suffixed
   * temporaries behind when a write fails) must not stop a sync.
   */
  async propfind(path = '', { depth = '1' } = {}) {
    const response = await this.request('PROPFIND', path, {
      headers: { depth, 'content-type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/></prop></propfind>',
      expect: 207,
    })
    const xml = response.body.toString('utf8')
    const basePath = this.baseUrl.pathname
    const entries = []
    for (const block of xml.match(/<[^>]*response[\s>][\s\S]*?<\/[^>]*response>/gi) ?? []) {
      const href = /<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/i.exec(block)
      if (!href) continue
      const decoded = href[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      let pathname
      try {
        pathname = decodeURIComponent(new URL(decoded, this.baseUrl).pathname)
      } catch {
        continue
      }
      const isCollection = /<[^>]*collection\s*\/?>/i.test(block) || /<[^>]*collection\s*>/i.test(block)
      const length = /<[^>]*getcontentlength[^>]*>(\d+)</i.exec(block)
      const relative = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname
      entries.push({
        href: decoded,
        path: relative,
        name: relative.replace(/\/+$/, '').split('/').pop() ?? '',
        collection: isCollection,
        bytes: length ? Number(length[1]) : null,
      })
    }
    // The collection itself is always the first entry; callers want its children.
    return entries.filter((entry) => entry.path.replace(/\/+$/, '') !== path.replace(/^\/+|\/+$/g, ''))
  }
}
