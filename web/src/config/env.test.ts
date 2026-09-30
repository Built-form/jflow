import { describe, expect, it } from 'vitest';
import { resolveApiBase, resolveAppEnv, windowTitle } from './env';

/**
 * The hostname picks the environment; unknown hosts are TEST; and a stack with no
 * address resolves to NO address — never to the other stack.
 */
describe('which environment this is', () => {
  it('is production only on the named host, test everywhere else', () => {
    expect(resolveAppEnv(undefined, 'jflow.built-form.co.uk')).toBe('production');
    expect(resolveAppEnv(undefined, 'JFLOW.built-form.co.uk ')).toBe('production');
    expect(resolveAppEnv('test', 'jflow.built-form.co.uk')).toBe('test');
    expect(resolveAppEnv(undefined, 'jflow-web.vercel.app')).toBe('test');
    expect(resolveAppEnv(undefined, 'mjflow.built-form.co.uk')).toBe('test');
    expect(resolveAppEnv(undefined, 'localhost')).toBe('test');
    expect(resolveAppEnv(undefined, '')).toBe('test');
    expect(resolveAppEnv('production', 'localhost')).toBe('production');
  });

  it('titles the tab', () => {
    expect(windowTitle('production')).toBe('JFlow');
    expect(windowTitle('test')).toBe('[TEST] JFlow');
  });
});

describe('where the API is', () => {
  it('is nowhere while a stage is not deployed — never the other stage', () => {
    expect(resolveApiBase('test', undefined, null, null)).toBe('');
    expect(resolveApiBase('production', undefined, null, 'https://test.example/api/v1')).toBe('');
  });

  it('takes the override first, without a trailing slash', () => {
    expect(resolveApiBase('test', 'http://localhost:5000/api/v1/', null, null)).toBe('http://localhost:5000/api/v1');
  });

  it('uses the stage address once it exists', () => {
    expect(resolveApiBase('test', undefined, null, 'https://t.example/api/v1')).toBe('https://t.example/api/v1');
    expect(resolveApiBase('production', ' ', 'https://p.example/api/v1/', null)).toBe('https://p.example/api/v1');
  });
});
