import type { RequestContext } from "../config";
import { UploaderSchema, UploadersRequestSchema } from "../hottub/schemas";
import { getProvider, listProviders } from "../providers/registry";
import type { ProviderContext } from "../providers/types";
import { HttpError } from "../utils/errors";
import { jsonResponse, parseBody } from "../utils/http";
import { enforceRateLimit, rateLimitHeaders } from "../utils/rate-limit";

export async function uploadersHandler(
  context: RequestContext,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const request = await parseBody(context.request, UploadersRequestSchema);
  const rateLimit = await enforceRateLimit(context, "uploaders", 60, 60);
  const provider = request.channel
    ? getProvider(request.channel)
    : listProviders().find((candidate) => candidate.capabilities.uploaderBrowse);
  if (!provider) {
    throw new HttpError(
      404,
      "No enabled provider supports uploader profiles.",
      "uploader_not_supported",
    );
  }
  if (!provider.capabilities.uploaderBrowse || !provider.getUploader) {
    throw new HttpError(
      404,
      `${provider.name} does not support uploader profiles.`,
      "uploader_not_supported",
    );
  }
  const providerContext: ProviderContext = {
    env: context.env,
    fetch: fetcher,
    requestId: context.requestId,
    now: new Date(),
  };
  const uploader = await provider.getUploader(request, providerContext);
  if (!uploader) throw new HttpError(404, "Uploader was not found.", "uploader_not_found");
  const validated = UploaderSchema.parse(uploader);
  return jsonResponse(validated, 200, rateLimitHeaders(rateLimit));
}
