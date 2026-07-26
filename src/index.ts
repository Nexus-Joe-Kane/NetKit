import type { Env } from "./config";
import { handleRequest } from "./router";

export default {
  fetch(request: Request, env: Env, execution: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, execution);
  },
} satisfies ExportedHandler<Env>;
