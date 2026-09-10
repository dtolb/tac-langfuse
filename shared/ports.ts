/**
 * Ports and origins that two sides must agree on.
 *
 * One named constant per value, because the failure mode of disagreement is silent: the
 * browser fetches a path nothing serves and gets `index.html` with a 200, then dies inside
 * `JSON.parse`. Importing the number instead of retyping it makes drift impossible.
 *
 * shared/ is compiled by BOTH tsconfig projects, so nothing here may touch a Node global
 * or a DOM global.
 */

/**
 * The agent process: TAC's Fastify server plus our own API and SSE routes.
 *
 * 8910 is chosen to collide with nothing else on this machine. Three ports were rejected:
 *
 *   8080 — the Traefik dev box publishes its dashboard there (127.0.0.1:8080). The failure
 *          is nasty rather than loud: Fastify binds the remaining interfaces, logs four
 *          cheerful "Server listening" lines, and every localhost:8080 request is answered
 *          by Traefik's plain-text "404 page not found". It reads as a bug in your own app.
 *   8787 — nw-poc and aci-quality-poc both hard-code it (`DEFAULT_PORT = 8787`), so sharing
 *          it means this scaffold cannot run alongside the demos it was cloned from.
 *   8000 — TAC's own default. An explicit port can never be accidentally right.
 */
export const AGENT_PORT = 8910;

/**
 * Next's dev server. Also the container port for the `web` service.
 *
 * Langfuse's own web container defaults to 3000 too, which is why the compose override
 * remaps it to 3100 on the host — otherwise `next dev` and `langfuse-web` collide.
 */
export const WEB_PORT = 3000;

/** Self-hosted Langfuse, remapped off 3000 to avoid the collision above. */
export const LANGFUSE_HOST_PORT = 3100;

/** Where the browser reaches the agent during local development. */
export const AGENT_DEV_ORIGIN = `http://localhost:${AGENT_PORT}`;
