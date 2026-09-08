import { dataResponse } from "@/lib/api-response";
import { getDriftData } from "@/lib/portal-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return dataResponse(getDriftData);
}
