import { describe, expect, it } from '@jest/globals';

import { encodeErrorResponse } from './codec.js';

describe('encodeErrorResponse', () => {
  it('passes a short message through unchanged', () => {
    const env = JSON.parse(encodeErrorResponse(new Error('boom')));
    expect(env).toEqual({ ok: false, error: 'boom' });
  });

  it('truncates an oversized message so the wire reply stays within limits', () => {
    const huge = 'x'.repeat(50_000);
    const env = JSON.parse(encodeErrorResponse(new Error(huge)));
    expect(env.ok).toBe(false);
    expect(env.error.length).toBeLessThan(huge.length);
    expect(env.error.endsWith('… [truncated]')).toBe(true);
  });

  it('falls back when reading the message itself throws', () => {
    const evil = new Error('placeholder');
    Object.defineProperty(evil, 'message', {
      get() {
        throw new RangeError('Cannot create a string longer than ...');
      },
    });
    const env = JSON.parse(encodeErrorResponse(evil));
    expect(env).toEqual({ ok: false, error: 'error message too large' });
  });

  it('stringifies non-Error values', () => {
    const env = JSON.parse(encodeErrorResponse('plain string'));
    expect(env).toEqual({ ok: false, error: 'plain string' });
  });
});
