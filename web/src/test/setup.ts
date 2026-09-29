/**
 * Test setup, written fresh for JFlow (workflows' copy installs its in-memory `src/mocks`
 * API, which JFlow does not have).
 *
 * Every test starts with a transport that REFUSES: a test that forgot to stub a call fails
 * loudly with the method and path it tried, rather than reaching for `fetch` and a real
 * API. A test that needs answers installs its own transport with `__setTestTransport` and
 * this hook puts the refusing one back before the next test.
 */

import { beforeEach } from 'vitest';
import { ApiError, __setTestTransport } from '../api/client';
import type { TestTransport } from '../api/client';

export const refusingTransport: TestTransport = (method, path) =>
  Promise.reject(new ApiError(0, { error: `No test transport for ${method} ${path}` }));

__setTestTransport(refusingTransport);

beforeEach(() => {
  __setTestTransport(refusingTransport);
});
