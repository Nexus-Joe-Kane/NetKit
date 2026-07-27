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
