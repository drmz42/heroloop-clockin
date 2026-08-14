const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

Deno.serve({ hostname: "0.0.0.0", port: 8080 }, (request) => {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/internal/health") {
    return Response.json({ ok: true, component: "api", phase: "skeleton" }, {
      headers: jsonHeaders,
    });
  }

  if (url.pathname === "/api/v1/health") {
    return Response.json(
      { ok: false, code: "self_hosted_api_not_ready" },
      { status: 503, headers: jsonHeaders },
    );
  }

  return Response.json({ ok: false, code: "not_found" }, {
    status: 404,
    headers: jsonHeaders,
  });
});
