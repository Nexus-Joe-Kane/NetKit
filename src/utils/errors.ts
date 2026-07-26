export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
