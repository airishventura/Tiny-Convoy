/**
 * Small helpers shared by every function.
 *
 * Nothing clever: method guards, JSON parsing that cannot throw, a consistent
 * error shape, and a client IP good enough for rate limiting.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export const json = (res: VercelResponse, status: number, body: unknown): void => {
  res.status(status).setHeader('content-type', 'application/json').send(JSON.stringify(body));
};

export const fail = (res: VercelResponse, status: number, error: string): void => json(res, status, { error });

export const requireMethod = (req: VercelRequest, res: VercelResponse, method: 'GET' | 'POST'): boolean => {
  if (req.method === method) return true;
  res.setHeader('allow', method);
  fail(res, 405, 'method_not_allowed');
  return false;
};

export const body = <T,>(req: VercelRequest): T | null => {
  if (!req.body) return null;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body) as T;
    } catch {
      return null;
    }
  }
  if (typeof req.body !== 'object' || Array.isArray(req.body)) return null;
  return req.body as T;
};

export const clientIp = (req: VercelRequest): string => {
  // `x-real-ip` is set by the platform edge and cannot be spoofed by the
  // caller; `x-forwarded-for` can carry client-supplied entries in front of the
  // real one, so it is only the fallback.
  const real = req.headers['x-real-ip'];
  const realIp = (Array.isArray(real) ? real[0] : real)?.trim();
  if (realIp) return realIp;
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw?.split(',')[0] ?? req.socket?.remoteAddress ?? 'unknown').trim() || 'unknown';
};

export const str = (value: unknown, max = 200): string => (typeof value === 'string' ? value.slice(0, max) : '');

export const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * Errors go to the platform log, never to the caller. Response bodies carry a
 * stable machine-readable reason and nothing about the inside of the server.
 */
export const logError = (scope: string, err: unknown): void => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[${scope}] ${detail}`);
};
