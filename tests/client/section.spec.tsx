// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { YuqueKbSection } from '../../src/client/section/YuqueKbSection.tsx'
import type { KbApi } from '../../src/client/api.ts'
import { zh } from '../../src/client/locales.ts'

const t = (key: keyof typeof zh, params?: Record<string, string | number>): string => {
  let text = zh[key] ?? ''

  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value))
  }
  return text
}

function stubApi(): KbApi & { readTree: ReturnType<typeof vi.fn>; writeToken: ReturnType<typeof vi.fn>; test: ReturnType<typeof vi.fn>; startSync: ReturnType<typeof vi.fn>; readStatus: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> } {
  return {
    readTree: vi.fn().mockResolvedValue({
      repos: [],
      lastSyncAt: null,
      rateRemaining: 4999,
      tokenConfigured: false,
    }),
    writeToken: vi.fn().mockResolvedValue({ ok: true }),
    test: vi.fn().mockResolvedValue({ ok: true, user: { login: 'nyaa-rgeis', name: 'Nyaa', booksCount: 9 } }),
    startSync: vi.fn().mockResolvedValue({ ok: true }),
    readStatus: vi.fn().mockResolvedValue({
      syncing: false,
      progress: null,
      lastSyncAt: 1724000000000,
      rateRemaining: 4999,
      tokenConfigured: false,
    }),
    toggle: vi.fn().mockResolvedValue({ ok: true }),
  }
}

describe('YuqueKbSection', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('loads the tree on mount and shows sync status', async () => {
    const api = stubApi()
    render(<YuqueKbSection api={api} t={t} />)
    await waitFor(() => expect(api.readTree).toHaveBeenCalledWith(false))
    expect(screen.getByText(/上次同步/)).toBeTruthy()
    expect(screen.getByText(/4999/)).toBeTruthy()
    expect(screen.getAllByText(zh.tokenNotConfigured).length).toBeGreaterThan(0)
  })

  it('saves the token through the api and stops echoing it', async () => {
    const api = stubApi()
    render(<YuqueKbSection api={api} t={t} />)
    const input = screen.getByLabelText(zh.tokenLabel) as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByText(zh.tokenSave))
    await waitFor(() => expect(api.writeToken).toHaveBeenCalledWith('secret-token'))
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('runs a connection test and renders the user line', async () => {
    const api = stubApi()
    // The test button is only actionable when a token is configured.
    api.readStatus.mockResolvedValue({
      syncing: false,
      progress: null,
      lastSyncAt: 1724000000000,
      rateRemaining: 4999,
      tokenConfigured: true,
    })
    render(<YuqueKbSection api={api} t={t} />)
    // Wait for the async status snapshot (tokenConfigured=true) before acting.
    await screen.findByText(zh.tokenConfigured)
    fireEvent.click(screen.getByText(zh.testButton))
    await waitFor(() => expect(api.test).toHaveBeenCalled())
    expect(screen.getByText(/连接成功：Nyaa/)).toBeTruthy()
  })

  it('starts a sync from the status line', async () => {
    const api = stubApi()
    render(<YuqueKbSection api={api} t={t} />)
    fireEvent.click(screen.getByText(zh.syncButton))
    await waitFor(() => expect(api.startSync).toHaveBeenCalled())
  })
})