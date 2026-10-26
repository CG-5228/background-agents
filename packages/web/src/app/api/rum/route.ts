import { readBodyCapped } from "@open-inspect/shared/http-body";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { getRequestCorrelation } from "@/lib/request-context";
import { isValidTraceId } from "@/lib/request-correlation";
import { isSameOriginRequest } from "@/lib/same-origin-request";

const MAX_RUM_BODY_BYTES = 8 * 1024;
const milestoneSchema = z.number().int().min(0).max(600_000).optional();
const rumSchema = z.strictObject({
  v: z.literal(1),
  pageLoadId: z.uuid().refine(isValidTraceId),
  seq: z.number().int().min(1).max(50),
  reason: z.enum(["timer", "hidden", "pagehide"]),
  path: z
    .string()
    .max(256)
    .refine((path) => {
      if (!path.startsWith("/") || path.startsWith("//")) return false;
      try {
        return new URL(path, "https://rum.invalid").pathname === path;
      } catch {
        return false;
      }
    }),
  navigationType: z.enum(["navigate", "reload", "back_forward", "prerender"]).optional(),
  milestones: z
    .strictObject({
      auth_cleared: milestoneSchema,
      sidebar_populated: milestoneSchema,
      composer_ready: milestoneSchema,
      picker_ready: milestoneSchema,
    })
    .optional(),
  vitals: z
    .array(
      z.strictObject({
        name: z.enum(["CLS", "FCP", "INP", "LCP", "TTFB"]),
        value: z.number().finite().nonnegative(),
        rating: z.enum(["good", "needs-improvement", "poor"]),
        id: z.string().max(64),
      })
    )
    .max(10)
    .optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (Number(request.headers.get("content-length")) > MAX_RUM_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    const bytes = await readBodyCapped(request.body, MAX_RUM_BODY_BYTES);
    if (bytes === null) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const parsed = rumSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const rum = parsed.data;
  const { requestId } = await getRequestCorrelation();
  const fields: Record<string, unknown> = {
    trace_id: rum.pageLoadId,
    page_load_id: rum.pageLoadId,
    request_id: requestId,
    seq: rum.seq,
    reason: rum.reason,
    path: rum.path,
    navigation_type: rum.navigationType,
    region: process.env.VERCEL_REGION,
  };
  for (const [name, value] of Object.entries(rum.milestones ?? {})) {
    fields[`${name}_ms`] = value;
  }
  for (const vital of rum.vitals ?? []) {
    const metric = vital.name.toLowerCase();
    fields[metric === "cls" ? metric : `${metric}_ms`] = vital.value;
    fields[`${metric}_rating`] = vital.rating;
  }
  createLogger("rum").info("web.rum", fields);

  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
