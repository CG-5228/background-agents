import { Hono } from "hono";
import { opencodePluginInputSchema } from "@open-inspect/shared/types/opencode-plugins";
import { OpencodePluginStore } from "../db/opencode-plugins";
import { isUniqueConstraintError } from "../db/errors";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { parseBody } from "./body";
import {
  GITHUB_USER_OR_SERVICE_ROUTE,
  error,
  json,
  requirePermission,
  type RequestContext,
} from "./shared";

const read = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("opencode_plugins.read"),
});
const manage = admit({
  ...GITHUB_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("opencode_plugins.manage"),
});
export const opencodePluginRoutes = new Hono<ControlPlaneHonoEnv>();

opencodePluginRoutes.get("/opencode-plugins", read, (c) =>
  dispatch(c, async (_request, _env, _params, ctx) => {
    if (!ctx.db) return error("Database not configured", 503);
    return json(await new OpencodePluginStore(ctx.db).list());
  })
);

async function save(request: Request, ctx: RequestContext, id?: string): Promise<Response> {
  if (!ctx.db) return error("Database not configured", 503);
  const input = await parseBody(
    request,
    opencodePluginInputSchema,
    "Invalid OpenCode plugin configuration"
  );
  if (input instanceof Response) return input;
  const store = new OpencodePluginStore(ctx.db);
  try {
    const plugin = id ? await store.update(id, input) : await store.create(input);
    return plugin ? json(plugin, id ? 200 : 201) : error("OpenCode plugin not found", 404);
  } catch (err) {
    if (isUniqueConstraintError(err)) return error("This plugin is already configured", 409);
    throw err;
  }
}
opencodePluginRoutes.post("/opencode-plugins", manage, (c) =>
  dispatch(c, (request, _env, _params, ctx) => save(request, ctx))
);
opencodePluginRoutes.put("/opencode-plugins/:id", manage, (c) =>
  dispatch(c, (request, _env, params: { id: string }, ctx) => save(request, ctx, params.id))
);
opencodePluginRoutes.delete("/opencode-plugins/:id", manage, (c) =>
  dispatch(c, async (_request, _env, params: { id: string }, ctx) => {
    if (!ctx.db) return error("Database not configured", 503);
    return (await new OpencodePluginStore(ctx.db).delete(params.id))
      ? json({ ok: true })
      : error("OpenCode plugin not found", 404);
  })
);
