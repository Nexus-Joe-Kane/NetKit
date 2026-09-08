import type { ApiError } from '@sw/shared';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiError['code'],
    message: string,
    readonly detail?: unknown,
    readonly suggestions?: ApiError['suggestions'],
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toApiError(): ApiError {
    return {
      code: this.code,
      message: this.message,
      ...(this.suggestions ? { suggestions: this.suggestions } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

export const badRequest = (message: string, detail?: unknown) =>
  new HttpError(400, 'bad_request', message, detail);

export const notFound = (message: string) => new HttpError(404, 'not_found', message);

export const notConfigured = (message: string) => new HttpError(501, 'not_configured', message);

export const upstream = (message: string, detail?: unknown) =>
  new HttpError(502, 'upstream_error', message, detail);

/** A quota or fair-use budget has been spent, not a transport failure. */
export const rateLimited = (message: string, detail?: unknown) =>
  new HttpError(429, 'rate_limited', message, detail);

/** The action is understood but this user is not permitted to take it. */
export const forbidden = (message: string, detail?: unknown) =>
  new HttpError(403, 'bad_request', message, detail);

/** Thrown when a query matches several premises and the user must choose. */
export const ambiguous = (message: string, suggestions: ApiError['suggestions']) =>
  new HttpError(300, 'ambiguous', message, undefined, suggestions);
