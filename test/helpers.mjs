/**
 * Shared harness for the host-half verification suites.
 *
 * Each scenario gets its own throwaway `DSH_HOME`, so the real one is never read
 * or written by a test. The plugin is re-imported with a cache-busting query per
 * scenario, because a mounted plugin holds per-apply state (the aggregator, the
 * resolved pricing document and the holiday rules).
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const homes = []

/** Disposers of every mounted plugin, so a home's files are not held open when it is removed. */
const disposers = []

/** A fresh throwaway harness home with a `storages` directory. */
export function makeHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), `dsh-usage-badge-${prefix}-`))
  mkdirSync(join(root, 'storages'), { recursive: true })
  homes.push(root)
  return root
}

/**
 * Dispose every mounted plugin, then remove every home this process created.
 *
 * The order matters on Windows: a mounted plugin holds its cache file open, and an open handle
 * makes the directory undeletable.
 */
export function cleanupHomes() {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch {
      // A failing disposer must not stop the cleanup.
    }
  }
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true })
}

/**
 * Write one session log. The provider/model come from a `request/context` event
 * and the usage from the following `assistant/message`, which is the shape the
 * fold reads.
 */
export function writeSession(root, dir, { provider, model, time, input = 0, cacheRead = 0, cacheWrite = 0, output = 0 }) {
  const path = join(root, 'sessions', dir)
  mkdirSync(path, { recursive: true })
  const events = [
    { seq: 1, time, type: 'request/context', data: { provider, model } },
    {
      seq: 2,
      time,
      type: 'assistant/message',
      data: { usage: { inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, outputTokens: output } },
    },
  ]
  writeFileSync(join(path, 'session.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'))
}

/** The plugin-owned directory under a harness home's `storages`. */
export const DATA_DIR = join('storages', 'usage-badge')

/** Write the price table the plugin should read, in its own directory. */
export function writePricing(root, pricing) {
  mkdirSync(join(root, DATA_DIR), { recursive: true })
  writeFileSync(join(root, DATA_DIR, 'pricing.json'), JSON.stringify(pricing, null, 2))
}

/** Write a price table at the pre-isolation location, to exercise the fallback. */
export function writeLegacyPricing(root, pricing) {
  mkdirSync(join(root, 'storages'), { recursive: true })
  writeFileSync(join(root, 'storages', 'usage-pricing.json'), JSON.stringify(pricing, null, 2))
}

/** Read the price table the plugin wrote back. */
export function readPricing(root) {
  return JSON.parse(readFileSync(join(root, DATA_DIR, 'pricing.json'), 'utf8'))
}

/** Whether the plugin created its own directory, and what is in it. */
export function listDataDir(root) {
  try {
    return readdirSync(join(root, DATA_DIR))
  } catch {
    return []
  }
}

/**
 * Mount the plugin against `root` once and hand back a caller.
 *
 * `process.env.DSH_HOME` is set while the plugin is imported *and* applied,
 * because the home is resolved inside `apply()`. Mounting once is what lets a test
 * observe state the plugin keeps across requests — the fold, the resolved pricing
 * document, and the fetched-price cache.
 *
 * @returns {Promise<{call:(method?:string, path?:string, payload?:unknown)=>Promise<{status:number, body:any}>}>}
 */
export async function mount(root, scenario) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  let call
  try {
    const { apply } = await import(`../lib/index.js?scenario=${scenario}`)
    const routes = []
    apply({
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
      effect(body) {
        const dispose = body()
        // Held rather than dropped: the cache store keeps a file handle open, and on Windows a
        // home with an open handle cannot be deleted — which is what `cleanupHomes` does.
        if (typeof dispose === 'function') disposers.push(dispose)
        return () => {}
      },
    })
    const route = routes[0]
    if (!route) throw new Error('the plugin registered no route')

    call = async (method = 'GET', path = '/usage-badge/summary', payload) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload)
      let responseBody = ''
      let status = 0
      await route.handler(
        {
          method,
          url: path,
          socket: { remoteAddress: '127.0.0.1' },
          on(event, listener) {
            if (event === 'data' && body !== undefined) listener(Buffer.from(body))
            if (event === 'end') listener()
            return this
          },
          destroy() {},
        },
        {
          writeHead(code) {
            status = code
          },
          end(chunk) {
            responseBody = chunk ? Buffer.from(chunk).toString('utf8') : ''
          },
        },
      )
      return { status, body: responseBody ? JSON.parse(responseBody) : null }
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  return { call }
}

/**
 * Mount the plugin against `root` and issue one HTTP request to it.
 *
 * @returns {Promise<{status:number, body:any}>}
 */
export async function request(root, scenario, method = 'GET', path = '/usage-badge/summary', payload) {
  const instance = await mount(root, scenario)
  return instance.call(method, path, payload)
}

/** Mount the plugin against `root` and return its summary payload. */
export async function summaryFor(root, scenario) {
  const { status, body } = await request(root, scenario, 'GET', '/usage-badge/summary')
  if (status !== 200) throw new Error(`summary route answered ${status}: ${JSON.stringify(body)}`)
  return body
}

/** A check collector that prints one line per assertion and fails the process at the end. */
export function createChecker(title) {
  const failures = []
  const check = (label, condition, detail = '') => {
    if (condition) console.log(`ok    ${label}`)
    else {
      console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
      failures.push(label)
    }
  }
  const finish = () => {
    cleanupHomes()
    if (failures.length > 0) {
      console.error(`\n${title}: ${failures.length} check(s) failed`)
      process.exit(1)
    }
    console.log(`\n${title} PASSED`)
  }
  return { check, finish }
}

/** Approximate numeric comparison for money assertions. */
export const close = (actual, expected, tolerance = 0.01) => Math.abs(actual - expected) < tolerance
