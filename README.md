# free-model-aggregator-02 — quality-ranked free-model aggregator

One server, two client wires. A client points at it and every completion is
answered live by a free OpenRouter model, dialled through the grader's
gateway.

- `POST /v1/chat/completions` — OpenAI wire, JSON and SSE streaming
- `POST /v1/messages` — Anthropic wire, JSON and SSE streaming
- `GET /v1/models` — OpenAI list shape for `Authorization: Bearer`, Anthropic
  list shape for `x-api-key`
- `node main.ts --list` — prints the catalog document and exits 0

## How it picks a model

The brief at `$MAKEFUN_PROMPT_FILE` lists 14 free models with the house's
quality ratings and capabilities. For each prompt the server ranks the models
that meet the prompt's requirements (JSON mode, tools, vision) by rating
descending, then context length, then id — fully deterministic, no clock, no
unseeded randomness. Best overall is
`openrouter/thinkingmachines/inkling-2-small:free` (1475); best JSON-capable
is `openrouter/nvidia/nemotron-3.5-super-vl:free` (1303).

## Failover

A gateway refusal (429 / 5xx / unreachable) retries the prompt on the next
best model that meets the requirements, up to 4 attempts. A model that
answers 429 cools down for the rest of the run. Refused attempts are reported
on the response as `x-makefun-upstream-failures` (max 8 rows). The dialled
model id is stamped back onto every answer and every streamed chunk, since the
provider echoes the model without the `openrouter/` prefix.

## Layout

- `main.ts` — the whole server, Node 22 stdlib only, no dependencies, no
  `npm install`. Run with `node main.ts` (trial mode) or `node main.ts --list`.
- `LICENSE` — MIT.

## Trial flow

The server listens on `0.0.0.0` at an OS-chosen port, registers
`{protocol_version: 1, port, catalog}` at `POST $MAKEFUN_ENV_URL/register`,
serves the six prompts (translating Anthropic requests to Chat Completions
for the gateway and back), polls `GET $MAKEFUN_ENV_URL/work` every 100 ms,
and exits 0 when the env says done. It never calls the Anthropic gateway
route — every model is dialled on Chat Completions only.
