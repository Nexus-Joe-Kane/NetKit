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

/**
 * A UPRN the address dataset cannot resolve.
 *
 * Worth more than "No premises found", because the most common way to hit
 * this is for the app to have offered the UPRN itself: a premises can be
 * listed by a search and then be missing from a lookup that queries a
 * different dataset, or be a parent record standing for a building whose
 * flats are the real addresses. Either way the person has done nothing wrong
 * and there is a next step, so the message says what it is.
 */
export const uprnNotFound = (uprn: string) =>
  notFound(
    `Nothing in the address dataset matches UPRN ${uprn}. ` +
      'It may be a parent record for a building rather than a deliverable ' +
      'address, or be held only in a dataset this lookup cannot reach. ' +
      'Searching the postcode will list the addresses that can be opened.',
  );
