# Add a /health route to the HTTP server

> This is an EXAMPLE spec. Replace its contents with your own task, then run
> `ship` (or `/ship` inside Claude Code). Keep the shape: one H1 title, concrete
> requirements, exact filenames, explicit acceptance criteria, and an out-of-scope
> list. The Carpenter builds EXACTLY what is written here and makes no design
> decisions — so be specific.

## Goal
Expose a health-check endpoint so a load balancer can tell the service is up.

## Task
Add a `GET /health` route to the existing Express app in `src/server.js`.

- It must respond `200` with JSON body `{ "status": "ok" }`.
- Register it before the catch-all 404 handler.

## Acceptance criteria
- `GET /health` returns HTTP 200 and `{"status":"ok"}`.
- No existing route's behaviour changes.
- A test in `src/server.test.js` asserts the 200 + body.

## Out of scope
- Auth, rate limiting, or readiness/liveness distinction.
- Any change to other routes or the build config.
