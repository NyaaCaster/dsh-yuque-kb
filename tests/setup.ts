import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Auto-cleanup between component tests (testing-library requires the hook).
afterEach(() => {
  cleanup()
})