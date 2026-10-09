# tailscale

`tailscale_get` and `tailscale_write` tools over the Tailscale API.

- `api.ts` is pure: `call` takes an injected `fetch`.
- `tests/tailscale.test.ts` uses only `api.ts`, with a fake `fetch`.
- `tests/register.test.ts` runs the tools through the test host with a fake `http.fetch`.
