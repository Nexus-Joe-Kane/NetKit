import type { Env } from "../config";
import type {
  Channel,
  ChannelStatus,
  Uploader,
  UploadersRequest,
  Video,
  VideosRequest,
} from "../hottub/schemas";

export interface ProviderCapabilities {
  publicBrowse: boolean;
  publicSearch: boolean;
  uploaderBrowse: boolean;
  authenticatedAccess: boolean;
  history: boolean;
  likes: boolean;
  playlists: boolean;
  premiumAccess: boolean;
}

export interface ProviderContext {
  env: Env;
  fetch: typeof fetch;
  requestId: string;
  now: Date;
}

export interface ProviderVideoPage {
  items: Video[];
  hasNextPage: boolean;
  totalResults?: number;
  message?: string;
  error?: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly channel: Channel;
  readonly capabilities: ProviderCapabilities;
  readonly status: ChannelStatus;
  readonly integration: "official" | "public" | "federated" | "unavailable";
  readonly unavailableReason?: string;

  listVideos(request: VideosRequest, context: ProviderContext): Promise<ProviderVideoPage>;
  searchVideos(request: VideosRequest, context: ProviderContext): Promise<ProviderVideoPage>;
  getUploader?(request: UploadersRequest, context: ProviderContext): Promise<Uploader | null>;

  /**
   * Validates an operator-supplied session before it is stored. Present only
   * on providers with no delegated-access API, where the operator signs in
   * themselves and hands over the resulting session.
   */
  connectSession?(
    sessionCookie: string,
    fetcher: typeof fetch,
  ): Promise<{ authenticated: boolean; detail: string }>;

  /**
   * Exchanges revocable, app-specific credentials for a session. Preferred
   * over `connectSession` where the provider offers a usable sign-in endpoint,
   * because the session can then be renewed without the operator pasting a new
   * cookie each time one expires.
   */
  connectCredentials?(
    login: string,
    password: string,
    fetcher: typeof fetch,
  ): Promise<{
    authenticated: boolean;
    detail: string;
    sessionCookie?: string;
    premium?: boolean;
  }>;

  /**
   * Attaches playable `formats[]` to catalogue items using a stored session.
   *
   * Present only where the app cannot extract playback for itself: yt-dlp runs
   * on the device with no account, so a protected source is invisible to it.
   * Supplying formats bypasses that extraction entirely and carries the
   * `httpHeaders` a hotlink-protected CDN needs.
   */
  resolvePlayback?(
    items: readonly Video[],
    sessionCookie: string,
    context: ProviderContext,
  ): Promise<Video[]>;

  /**
   * Reports what an authenticated session exposes on a watch page. Used to
   * establish how playback is delivered to an entitled account before a
   * format resolver is written against it.
   */
  diagnosePlayback?(
    sessionCookie: string,
    watchUrl: string,
    fetcher: typeof fetch,
  ): Promise<string>;
}
