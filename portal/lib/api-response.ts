export async function dataResponse<T>(loader: () => Promise<T>): Promise<Response> {
  try {
    return Response.json(await loader(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("[keel-portal] data request failed", error);
    return Response.json(
      { error: "data_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
