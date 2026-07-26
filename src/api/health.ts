import type { RequestContext } from "../config";
import { listProviders } from "../providers/registry";
import { jsonResponse } from "../utils/http";

interface HealthRow {
  ok: number;
}

export async function healthHandler(context: RequestContext): Promise<Response> {
  let database = "ok";
  try {
    const row = await context.env.DB.prepare("SELECT 1 AS ok").first<HealthRow>();
    if (row?.ok !== 1) database = "degraded";
  } catch {
    database = "error";
  }
  const providers = listProviders();
  const status = database === "ok" ? "ok" : "degraded";
  return jsonResponse(
    {
      status,
      database,
      providers: {
        active: providers.filter((provider) => provider.status === "active").length,
        degraded: providers.filter((provider) => provider.status === "degraded").length,
        restricted: providers.filter((provider) => provider.status === "restricted").length,
        total: providers.length,
      },
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    },
    status === "ok" ? 200 : 503,
    { "Cache-Control": "no-store" },
  );
}
