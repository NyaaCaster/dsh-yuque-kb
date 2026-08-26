/**
 * The `/api/dsh-yuque-kb` route family (kind `prefix`, SSOT §3.2 plus the P4
 * contract updates): connection test, catalogue tree, enabled toggles, sync
 * trigger, status polling, and the runtime-token write entry. Every route
 * carries the loopback trust fence (`src/loopback.ts`) — never forwarded
 * headers, socket + Host + browser same-origin markers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { isLoopbackRequest } from './loopback.ts'
import type { KbEngine } from './engine.ts'

/** Route-mount prefix (kind `prefix` matches `/api/dsh-yuque-kb/…`). */
export const KB_API_PREFIX = '/api/dsh-yuque-kb'

/** Cap on JSON request bodies (all payloads are small). */
const MAX_JSON_BODY_BYTES = 16 * 1024

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Route family dependencies. */
export interface KbRoutesDeps {
  /** Plugin context (settings + jobs are consulted opportunistically). */
  ctx: Context
  /** The engine implementing every operation. */
  engine: KbEngine
  /** The settings namespace used by the token write entry. */
  ns: SettingsNamespace
}

/** Endpoint table: sub-path → allowed HTTP method. */
const ENDPOINTS: Record<string, string> = {
  '/test': 'POST',
  '/tree': 'GET',
  '/toggle': 'POST',
  '/sync': 'POST',
  '/status': 'GET',
  '/token': 'POST',
}

/**
 * Minimal surface of the optional background-job registry
 * (`@deepseek-ai/dsh-jobs`), mirroring `src/tools.ts` — no type dependency on
 * the host package; `ctx.get('jobs')` resolves the live registry when mounted.
 */
interface KbJobRegistry {
  start(spec: {
    kind: string
    label: string
    run(): {
      cancel(reason?: string): void
      done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
    }
  }): string
}

/**
 * Build the single prefix route dispatching the six endpoints.
 * @param deps - context, engine, settings namespace.
 * @returns the route list (one prefix route).
 */
export function makeRoutes(deps: KbRoutesDeps): WebRoute[] {
  const { ctx, engine, ns } = deps

  return [
    {
      kind: 'prefix',
      path: KB_API_PREFIX,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sub = url.pathname.slice(KB_API_PREFIX.length).replace(/\/+$/, '')
        const method = req.method ?? 'GET'
        const expected = ENDPOINTS[sub]
        if (expected === undefined) {
          writeJson(res, 404, { error: `no dsh-yuque-kb endpoint for ${method} ${url.pathname}` })
          return
        }
        if (expected !== method) {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }

        // ------------------------------------------------------------ test
        if (sub === '/test') {
          const body = await readJsonBody(req)
          const candidate = typeof body?.token === 'string' && body.token !== '' ? body.token : undefined
          try {
            const result = await engine.testConnection(candidate)
            writeJson(res, 200, result)
          } catch (error) {
            writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // ------------------------------------------------------------ tree
        if (sub === '/tree') {
          const refresh = queryParam(url, 'refresh') === '1' || queryParam(url, 'refresh') === 'true'
          try {
            if (refresh) await engine.refreshCatalog()
            writeJson(res, 200, engine.tree())
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // ---------------------------------------------------------- toggle
        if (sub === '/toggle') {
          const body = await readJsonBody(req)
          const kind = body?.kind
          const id = typeof body?.id === 'string' ? body.id : ''
          const enabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined
          if ((kind !== 'repo' && kind !== 'doc') || id === '' || enabled === undefined) {
            writeJson(res, 400, { error: 'kind (repo|doc), id and enabled (boolean) are required' })
            return
          }
          try {
            const applied = await engine.toggle(kind, id, enabled)
            if (!applied) {
              writeJson(res, 404, { ok: false, error: `${kind} ${id} not found in the local store` })
              return
            }
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // ------------------------------------------------------------ sync
        if (sub === '/sync') {
          const body = await readJsonBody(req)
          const repos = Array.isArray(body?.repos)
            ? (body.repos as unknown[]).filter((entry): entry is string => typeof entry === 'string')
            : undefined
          // Prefer the background registry when mounted, and degrade to an
          // inline foreground run when the registry rejects the request
          // (unserved owner, limit reached) — a UI-triggered sync must not
          // die with an opaque 400. The response states which path ran.
          const jobs = ctx.get('jobs') as KbJobRegistry | undefined
          if (jobs !== undefined) {
            const controller = new AbortController()
            const spec = {
              kind: 'kb-sync',
              label: 'sync yuque kb (web)',
              run: (): { done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>; cancel: (reason?: string) => void } => ({
                done: engine.sync({ repos, signal: controller.signal })
                  .then(result => ({
                    status: 'completed' as const,
                    detail: `synced ${result.synced} docs, ${result.errors.length} errors`,
                    output: '',
                  }))
                  .catch(error => ({
                    status: 'failed' as const,
                    detail: error instanceof Error ? error.message : String(error),
                    output: '',
                  })),
                cancel: (reason?: string) => controller.abort(reason),
              }),
            }
            try {
              const id = jobs.start(spec)
              writeJson(res, 200, { ok: true, jobId: id })
              return
            } catch (error) {
              // Registry rejected the start (e.g. no controller serves an
              // unowned job in this composition): fall through to inline.
              deps.ctx.logger.warn(
                `[dsh-yuque-kb] background job rejected, running sync inline: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }
          try {
            await engine.sync({ repos })
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        // ---------------------------------------------------------- status
        if (sub === '/status') {
          writeJson(res, 200, engine.status())
          return
        }
        // ----------------------------------------------------------- token
        if (sub === '/token') {
          const body = await readJsonBody(req)
          const token = typeof body?.token === 'string' ? body.token : ''
          if (token.trim() === '') {
            writeJson(res, 400, { error: 'token is required' })
            return
          }
          try {
            // Settings service first (the secret lives in the user document);
            // without one, keep the runtime credential in the domain global.
            const settings = ctx.get('settings')
            if (settings !== undefined) {
              await settings.update(ns, { yuqueToken: token })
            } else {
              await engine.saveRuntimeToken(token)
            }
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }

        writeJson(res, 404, { error: `no dsh-yuque-kb endpoint for ${method} ${url.pathname}` })
      },
    },
  ]
}