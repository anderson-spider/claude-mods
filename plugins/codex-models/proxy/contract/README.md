# Contract suite

A black-box oracle for the codex-models proxy. It builds `cmd/ccmproxy` with
`-tags contract`, runs it as a subprocess against `httptest` fakes of the
Anthropic API, the Codex backend and the OAuth token endpoint, and checks what
a client sees and what the fakes received. It imports no package of the proxy,
so it stays valid whatever the packages become. The `CCMPROXY_CONTRACT_*`
variables that aim the binary at the fakes exist only in the `contract` build
(`contract_on.go` files); the default build has no such knob.

```
go test -race -count=1 -tags contract ./contract/...      # from plugins/codex-models/proxy
go vet -tags contract ./...
```

`go` must be on `PATH` (`mise exec --` locally, `setup-go` in CI): `TestMain`
builds the binary. With `-race` it also builds a race-instrumented binary,
which the concurrency tests (`opts{race: true}`) run; a `DATA RACE` in any
binary's stderr fails the test. The race binary takes about a second to start,
so the other tests use the plain one. The suite takes about 20 s with `-race`.

## Re-recording

`-update` rewrites every golden a run touches. Never run it on the whole
suite. Re-record one test at a time and list every changed file in
`testdata/` in the change as a test edit with its reason:

```
go test -tags contract ./contract/... -run 'TestCodexStreamTranslation/parallel_tool_calls' -update
git diff contract/testdata
```

`testdata/count_tokens_reference.json` is the floor of the `count_tokens`
estimate (the test also fails above twice the floor). `-update` writes it only
when the file is missing; to move it, edit it by hand and say why.

If the output of a test fails, the first question is whether the proxy broke a
contract; a golden is re-recorded only when it is in the list below and the
new output is intended.

## May be re-recorded, with a written reason

These pin today's behavior, which is not a promise to Claude Code or Codex.

| Golden | What is incidental |
| --- | --- |
| `codex_stream_*` (all) | The message `id` is the Codex response id (`resp_1`), not a minted `msg_` id (if ids are minted, `mask` in `harness_test.go` must learn them). One `text_delta` per upstream delta, and the reasoning-summary separator `"\n\n"` as its own `thinking_delta`. `message_start.usage` is all zeros. |
| `codex_stream_parallel_tool_calls.golden` | Calls come out in `output_index` order although the second finished first. Blocks must still never overlap (`wellFormed` enforces it). |
| `codex_stream_arguments_not_an_object.golden`, `codex_stream_arguments_not_json.golden` | A call with unusable arguments is dropped. In `arguments_not_an_object` the call was the turn's only output, so the message ends with no content block; in `arguments_not_json` the text block `t` after it is kept. |
| `codex_stream_no_terminal.golden`, `codex_error_long_message.golden` | The texts: "the Codex stream ended before the response completed", "the Codex backend reported a failed response". The type (`api_error`), the cut at 300 characters plus `…` and the absence of control characters stay. |
| `codex_message_nonstream.golden.json` | Same stream behavior, folded into one message. |
| `cli_models_*`, `models_*`, `status_models.golden.json` | The model catalog: ids, labels, descriptions, `behavesAs`, order. Re-record when the catalog changes on purpose; the shape of each row (four keys, the picker block, the merged list with `first_id` and `last_id`) is a contract. |
| The guard's messages other than the `ccmproxy:` prefix and `unexpected Host header` | Wording only. |

## Must never be re-recorded

Changing any of these breaks a persisted or external contract, or needs a live
check against the Codex backend first.

- tool_use `id` is the Codex `call_id`. It comes back as `tool_use_id` on the next turn and is matched by id (`codex_stream_single_tool_call`, `codex_stream_text_then_tool_call`, the request goldens).
- The usage arithmetic: `input_tokens` is net of cache reads, `cache_read_input_tokens` carries the cached part (`message_delta` in every stream golden).
- The request shape sent to Codex (`codex_request_rich.golden.json`, `codex_request_longnames.golden.json`): `include`, `store: false`, `stream: true`, `strict: false`, `instructions: ""` with the system prompt as a `developer` message, `parallel_tool_calls`, `reasoning.summary: auto`, and the reasoning item's `"content": null` with `"summary": []` (a typed struct that omits a null is a regression).
- The shortened tool names: at most 64 characters, the exact cut and de-duplication (`codex_request_longnames.golden.json`). The plan freezes them. The transcript keeps the full name and every request shortens it again, so this is a decision, not a persisted format.
- Every `ccmp1:` value, in both directions: the marker, `ccmp1:<encrypted_content>` on the way out and its removal on the way back (`codex_stream_thinking*`, `codex_message_nonstream`, `TestCodexThinkingSignatureIsMarked`, `TestPassthroughStripsProxyThinkingBlocks`).
- The literals in tests: the OAuth client id, the form fields, the `Session_id` shape, status mappings in `TestCodexErrorMapping`.

## Not covered here

Unit tests keep these: the exact ordering of the two flocks as an unexported
detail beyond what `locks_test.go` observes, the bound-socket re-check, the
constant-time compare, resolving a host name to loopback (needs DNS control),
and a case-insensitive `auth_file` match (needs such a file system).
