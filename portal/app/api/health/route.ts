export function GET(): Response {
  // This is the only route allowed to bypass Access verification. It returns a
  // literal liveness value and deliberately reads no database, file, or service.
  return new Response('{"status":"ok"}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

