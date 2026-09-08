import { dataResponse } from "@/lib/api-response";
import { getCoverageData } from "@/lib/portal-data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Promise<Response> {
  return dataResponse(getCoverageData);
}
