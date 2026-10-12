# Contract suite

Black-box checks of the built proxy against local fake Anthropic, Codex and token endpoints; imports no proxy package. Run from `proxy/`, with mise's Go on PATH:

```sh
go test -race -count=1 -tags contract ./contract/...
go vet -tags contract ./...
```

`TestMain` builds normal and race-instrumented **contract** binaries; concurrency cases select the latter and any `DATA RACE` in stderr fails. Test injection points belong only to this build; [AGENTS.md](../../AGENTS.md#safety-and-contracts) owns the production-build safeguards.

## Re-recording

First check whether a mismatch is a regression. Re-record only an intended change in the allowed list below, one test at a time; `-update` rewrites every golden the run touches. List each changed `testdata/` file and its reason as a test edit.

```sh
go test -tags contract ./contract/... -run 'TestCodexStreamTranslation/parallel_tool_calls' -update
git diff contract/testdata
```

`testdata/count_tokens_reference.json` sets the estimate floor; twice that floor is the ceiling. `-update` creates it only when missing. Change it by hand with a reason.

### May be re-recorded, with a reason

| Golden | Incidental output; contracts that stay |
| --- | --- |
| `codex_stream_*` (all) | Response message id (`resp_1`; update `mask` if minting ids), delta granularity, separate `"\n\n"` reasoning separator, zero `message_start.usage`. The exclusions below still apply. |
| `codex_stream_parallel_tool_calls.golden` | `output_index` ordering; blocks remain non-overlapping (`wellFormed`). |
| `codex_stream_arguments_not_an_object.golden`, `codex_stream_arguments_not_json.golden` | Dropped unusable calls: empty output in the first, later text `t` retained in the second. |
| `codex_stream_no_terminal.golden`, `codex_error_long_message.golden` | Error wording only; keep `api_error`, 300-character cut plus `…`, no control characters. |
| `codex_message_nonstream.golden.json` | Incidental stream behavior folded into JSON. |
| `cli_models_*`, `models_*`, `status_models.golden.json` | Intended catalog ids/labels/descriptions/`behavesAs`/order changes; keep four-key rows, picker/merged-list shape, `first_id`/`last_id`. |
| `status_codex_limits.golden.json` | Fake reading values; keep `{kind,percentUsed,resetsAt,windowMinutes,observedAt}`. |
| Guard messages | Wording except the `ccmproxy:` prefix and `unexpected Host header`. |

### Frozen contracts

These are excluded from re-recording: changing them breaks external/persisted contracts or requires a live Codex check first.

- Tool-use id is Codex `call_id`, replayed as `tool_use_id` (single/text-then-tool-call and request goldens).
- Usage: `input_tokens` excludes cache reads; `cache_read_input_tokens` carries them.
- Rich/long-name request shape: `include`, `store:false`, `stream:true`, `strict:false`, `instructions:""`, system as `developer`, `parallel_tool_calls`, `reasoning.summary:auto`, reasoning `content:null` and `summary:[]`.
- Tool names: exact cut/de-duplication, at most 64 characters (`codex_request_longnames.golden.json`).
- `ccmp1:` signatures in both directions: encrypted state out, marker stripped on replay (thinking/nonstream goldens and signature/passthrough tests).
- Literal OAuth client id/form fields, `Session_id` shape and error-status mappings (`TestCodexErrorMapping`).

## Coverage boundaries

`limits_test.go` pins status shape, answer-header readings (429 included), latest/unknown/malformed windows, local plain status, held-token-only refresh, single flight/backoff/deadline, secret gating and log privacy. Read those tests when changing limits instead of duplicating the matrix here.

Unit tests own bound-socket rechecks, constant-time comparisons, loopback DNS refusal, dangling credential links, unchanged-stamp refresh rereads, lock-wait cancellation and atomic private writes. Subprocess tests cover directory aliases sharing a lock, login/logout contention and obsolete config keys unable to override credentials/catalog/backend identity. The isolated callback-port seam must stay inert in the default build.
