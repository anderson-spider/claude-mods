# Contract suite

Black-box checks of the built proxy against local fakes: Anthropic, and one TLS remote serving both Messages inference and `/v8/management/`. It imports no proxy package. Run from `proxy/`, with mise's Go on PATH:

```sh
go test -race -count=1 -tags contract ./contract/...
go vet -tags contract ./...
```

`TestMain` builds normal and race-instrumented **contract** binaries; concurrency cases select the latter and any `DATA RACE` in stderr fails. Test injection points belong only to this build; [AGENTS.md](../../AGENTS.md#safety-and-contracts) owns the production-build safeguards.

## Re-recording

First check whether a mismatch is a regression. Re-record only an intended change in the allowed list below, one test at a time; `-update` rewrites every golden the run touches. List each changed `testdata/` file and its reason as a test edit.

```sh
go test -tags contract ./contract/... -run '^TestStatus$' -update
git diff contract/testdata
```

`testdata/count_tokens_reference.json` sets the estimate floor; twice that floor is the ceiling. `-update` creates it only when missing. Change it by hand with a reason.

### May be re-recorded, with a reason

| Golden | Incidental output; contracts that stay |
| --- | --- |
| `codex_error_long_message.golden` | Error wording only; keep the 300-character cut plus `…` and no control characters. |
| `cli_models_*`, `models_*`, `status_models.golden.json` | Intended catalog ids/labels/descriptions/`behavesAs`/order changes; keep four-key rows, picker/merged-list shape, `first_id`/`last_id`. |
| Guard messages | Wording except the `ccmproxy:` prefix and `unexpected Host header`. |

### Frozen contracts

These are asserted in code, not goldens; changing them breaks external or persisted contracts.

- Remote headers: only `Content-Type`, `Accept`, `Anthropic-Version`, `Anthropic-Beta`; no credential, proxy secret or `User-Agent` (`relay_test.go`).
- Remote body: model `<id>(<effort>)`, `metadata.user_id` as the salted HMAC v4 UUID, no `thinking` or `output_config.effort`, every other field as sent (`relay_test.go`).
- `ccmp1:` signatures in both directions: marked toward the client, marker stripped toward the remote, unmarked thinking dropped toward the remote and marked thinking dropped toward Anthropic (`relay_test.go`, `passthrough_test.go`).
- Error-status mappings, remote 401 as 403 `permission_error` (`errors_test.go`).
- Management key only on `/v8/management/*`; usage only through the api-call with `Bearer $TOKEN$` (`limits_test.go`).

## Coverage boundaries

`limits_test.go` pins on-demand readings, plain status without usage calls, `limit_reached` as 100%, backoff, logged-out remotes and clearing on remote failure. Unit tests own window parsing, single flight/deadline, bound-socket rechecks, constant-time comparisons and loopback DNS refusal.
