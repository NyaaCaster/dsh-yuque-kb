/**
 * Loopback fence unit tests: the socket address, Host header, and browser
 * same-origin markers each gate independently; forwarded headers are never
 * trusted.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { isIPv4Loopback, isLoopbackAddress, isLoopbackHostname, isLoopbackRequest } from '../src/loopback.ts'

function request(overrides: { remoteAddress?: string; host?: string; secFetchSite?: string; origin?: string }): IncomingMessage {
  const headers: Record<string, string | string[] | undefined> = {}
  if (overrides.host !== undefined) headers.host = overrides.host
  if (overrides.secFetchSite !== undefined) headers['sec-fetch-site'] = overrides.secFetchSite
  if (overrides.origin !== undefined) headers.origin = overrides.origin
  return {
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
    headers,
  } as unknown as IncomingMessage
}

describe('isIPv4Loopback / isLoopbackAddress / isLoopbackHostname', () => {
  it('accepts 127/8 and rejects other IPv4 ranges', () => {
    expect(isIPv4Loopback('127.0.0.1')).toBe(true)
    expect(isIPv4Loopback('127.255.255.255')).toBe(true)
    expect(isIPv4Loopback('128.0.0.1')).toBe(false)
    expect(isIPv4Loopback('10.0.0.1')).toBe(false)
    expect(isIPv4Loopback('999.0.0.1')).toBe(false)
  })

  it('accepts ::1 and IPv4-mapped loopback, rejects others', () => {
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })

  it('accepts localhost / [::1] / 127.x hostnames', () => {
    expect(isLoopbackHostname('localhost')).toBe(true)
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('example.com')).toBe(false)
  })
})

describe('isLoopbackRequest', () => {
  it('allows a loopback socket + loopback Host with no browser markers', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3080' }))).toBe(true)
    expect(isLoopbackRequest(request({ remoteAddress: '::1', host: 'localhost:3080' }))).toBe(true)
    expect(isLoopbackRequest(request({ remoteAddress: '::ffff:127.0.0.1', host: '127.0.0.1:3080' }))).toBe(true)
  })

  it('denies a non-loopback socket even with a loopback Host', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '192.168.1.5', host: '127.0.0.1:3080' }))).toBe(false)
  })

  it('denies a loopback socket with a non-loopback Host', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: 'example.com' }))).toBe(false)
  })

  it('denies cross-site browser requests and mismatched origins', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3080', secFetchSite: 'cross-site' }))).toBe(false)
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1', host: '127.0.0.1:3080', origin: 'http://evil.example' }))).toBe(false)
  })

  it('accepts a same-origin browser request', () => {
    expect(isLoopbackRequest(request({
      remoteAddress: '127.0.0.1',
      host: '127.0.0.1:3080',
      secFetchSite: 'same-origin',
      origin: 'http://127.0.0.1:3080',
    }))).toBe(true)
  })

  it('denies a missing Host header', () => {
    expect(isLoopbackRequest(request({ remoteAddress: '127.0.0.1' }))).toBe(false)
  })
})