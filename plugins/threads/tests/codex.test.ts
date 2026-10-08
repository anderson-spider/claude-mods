import { describe, expect, test } from "claude-code/testing";
import { parseNew, resumeCommand, CODEX_NO_WORKTREE } from "../hooks/core.mjs";
import {
  approvalPrompt,
  callHelper,
  codexActivity,
  codexModelOf,
  codexModes,
  codexStateOf,
  codexTaskText,
  helperSocket,
  startHelperArgv,
  statusFromHelper,
} from "../hooks/codex.mjs";

describe("codex: the pure parts", () => {
  test("the helper's socket is under the threads folder of the home", () => {
    expect(helperSocket("/Users/someone")).toBe("/Users/someone/.claude/threads-codex/run/helper.sock");
  });

  test("the helper starts detached under the given node, with the script under the plugin folder", () => {
    expect(startHelperArgv("/plugins/threads", "node")).toEqual(["sh", "-c", "nohup 'node' '/plugins/threads/helper/helper.mjs' >/dev/null 2>&1 &"]);
    const cua = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";
    expect(startHelperArgv("/plugins/threads", cua)[2]).toBe(`nohup '${cua}' '/plugins/threads/helper/helper.mjs' >/dev/null 2>&1 &`);
  });

  test("a folder name with a quote cannot end the shell word early", () => {
    expect(startHelperArgv("/tmp/it's here", "node")[2]).toBe("nohup 'node' '/tmp/it'\\''s here/helper/helper.mjs' >/dev/null 2>&1 &");
  });

  test("each permission mode maps to Codex's sandbox and approval; bypass and unknown modes are refused", () => {
    expect(codexModes("default")).toEqual({ sandbox: "read-only", approval: "on-request" });
    expect(codexModes("acceptEdits")).toEqual({ sandbox: "workspace-write", approval: "on-request" });
    expect(codexModes("plan")).toEqual({ sandbox: "read-only", approval: "untrusted" });
    expect(codexModes("auto")).toEqual({ sandbox: "workspace-write", approval: "on-request" });
    expect((codexModes("bypassPermissions") as any).error).toMatch(/never bypass permissions/);
    expect((codexModes("toString") as any).error).toMatch(/Unknown permission mode/);
    expect((codexModes(undefined) as any).error).toMatch(/Unknown permission mode/);
  });

  test("the model passes through unchecked; codex or nothing means the account default", () => {
    expect(codexModelOf("gpt-5.4-codex")).toBe("gpt-5.4-codex");
    expect(codexModelOf("  gpt-5  ")).toBe("gpt-5");
    expect(codexModelOf("codex")).toBeUndefined();
    expect(codexModelOf("")).toBeUndefined();
    expect(codexModelOf(undefined)).toBeUndefined();
  });

  test("the helper's statuses map to the plugin's; failed stays idle with its error", () => {
    expect(statusFromHelper({ status: "starting" })).toEqual({ status: "starting", error: "" });
    expect(statusFromHelper({ status: "working" })).toEqual({ status: "working", error: "" });
    expect(statusFromHelper({ status: "idle" })).toEqual({ status: "idle", error: "" });
    expect(statusFromHelper({ status: "needs-you" })).toEqual({ status: "needs-you", error: "" });
    expect(statusFromHelper({ status: "exited", error: "codex app-server is gone: exit 1" })).toEqual({ status: "exited", error: "codex app-server is gone: exit 1" });
    expect(statusFromHelper({ status: "failed", error: "rate limited" })).toEqual({ status: "idle", error: "rate limited" });
    expect(statusFromHelper({ status: "sideways" }).status).toBe("exited");
  });

  test("an approval reads as the command and reason, the files, or the permissions asked for", () => {
    expect(approvalPrompt({ method: "item/commandExecution/requestApproval", params: { command: "npm test", cwd: "/work/app", reason: "check the change" } })).toBe(
      "Codex asks to run npm test in /work/app. Reason: check the change.",
    );
    expect(approvalPrompt({ method: "item/fileChange/requestApproval", params: { changes: [{ path: "a.ts" }, { path: "b.ts" }] } })).toBe("Codex asks to change a.ts, b.ts.");
    expect(approvalPrompt({ method: "item/fileChange/requestApproval", params: {} })).toBe("Codex asks to change files.");
    expect(approvalPrompt({ method: "item/permissions/requestApproval", params: { reason: "needs the network" } })).toBe("Codex asks for more permissions than this thread has. Reason: needs the network.");
    expect(approvalPrompt({ method: "item/unknown/requestApproval", params: {} })).toBe("Codex asks for an answer (item/unknown/requestApproval).");
    expect(approvalPrompt(null)).toBe("");
  });

  test("a command's text is one line and short", () => {
    const long = `echo ${"x\n".repeat(300)}`;
    const text = approvalPrompt({ method: "item/commandExecution/requestApproval", params: { command: long } });
    expect(text.includes("\n")).toBe(false);
    expect(text.length).toBeLessThanOrEqual(400);
  });

  test("callHelper posts JSON over the socket, gets GET for status, and reports an unreachable helper as status 0", async () => {
    const calls: any[] = [];
    const deps = {
      socketPath: "/s.sock",
      fetch: async (url: string, init: any) => {
        calls.push({ url, init });
        return { status: 200, text: '{"status":"ok","threadId":"th-9"}' };
      },
    };
    expect(await callHelper(deps, "/start", { cwd: "/w", task: "t", sandbox: "read-only", approval: "on-request" })).toEqual({
      ok: true,
      status: 200,
      body: { status: "ok", threadId: "th-9" },
    });
    expect(calls[0]).toEqual({ url: "http://codex-threads/start", init: { socketPath: "/s.sock", method: "POST", body: JSON.stringify({ cwd: "/w", task: "t", sandbox: "read-only", approval: "on-request" }) } });
    await callHelper(deps, "/status");
    expect(calls[1].init).toEqual({ socketPath: "/s.sock", method: "GET" });
    const gone = { socketPath: "/s.sock", fetch: async () => { throw new Error("connect ENOENT"); } };
    const down = await callHelper(gone, "/status");
    expect(down).toMatchObject({ ok: false, status: 0, body: { status: "error" } });
    expect(down.body.message).toMatch(/not reachable \(connect ENOENT\)/);
  });

  test("callHelper keeps the helper's refusal (status and code) and tolerates a reply that is not JSON", async () => {
    const busy = { socketPath: "/s", fetch: async () => ({ status: 409, text: '{"status":"error","code":"busy","message":"a turn is running"}' }) };
    expect(await callHelper(busy, "/send", { threadId: "th-1", text: "x" })).toEqual({
      ok: false,
      status: 409,
      body: { status: "error", code: "busy", message: "a turn is running" },
    });
    const junk = { socketPath: "/s", fetch: async () => ({ status: 500, text: "<html>" }) };
    expect(await callHelper(junk, "/read", { threadId: "th-1" })).toMatchObject({ ok: false, status: 500, body: { status: "error", message: "the helper sent no JSON" } });
  });

  test("a thread's state from the helper's snapshot: needs-you shows the approval, a missing helper or thread is exited", () => {
    const t = { codexThreadId: "th-1" } as any;
    const waiting = {
      reachable: true,
      byId: new Map([["th-1", { threadId: "th-1", status: "needs-you", pendingApproval: { method: "item/commandExecution/requestApproval", params: { command: "ls" } }, lastAnswer: null, error: null }]]),
    };
    expect(codexStateOf(t, waiting as any)).toMatchObject({ status: "needs-you", prompt: "Codex asks to run ls.", lastLine: "wait  Codex asks to run ls." });
    const answered = { reachable: true, byId: new Map([["th-1", { threadId: "th-1", status: "idle", pendingApproval: null, lastAnswer: { text: "Done.\nAll tests pass.", at: 1 }, error: null }]]) };
    expect(codexStateOf(t, answered as any)).toMatchObject({ status: "idle", prompt: "", lastLine: "says  Done. All tests pass." });
    expect(codexStateOf(t, { reachable: false, byId: new Map() } as any)).toMatchObject({ status: "exited", codexError: "the Codex helper is not running, so this thread is no longer tracked" });
    expect(codexStateOf(t, { reachable: true, byId: new Map() } as any)).toMatchObject({ status: "exited", codexError: "the Codex helper no longer tracks this thread (it restarted)" });
  });

  test("the helper's activity lines keep their times and read as the feed does", () => {
    expect(
      codexActivity([
        { at: 4, kind: "user", text: codexTaskText({ title: "Scout", leadTitle: "Main", task: "list" }) },
        { at: 5, kind: "user", text: "hi" },
        { at: 6, kind: "answer", text: "done" },
        { at: 7, kind: "approval", text: "asks: x" },
        { at: 8, kind: "tool", text: "commandExecution: ls" },
      ]),
    ).toEqual([
      { at: 4, kind: "user", text: "task: list" },
      { at: 5, kind: "user", text: "hi" },
      { at: 6, kind: "assistant", text: "done" },
      { at: 7, kind: "wait", text: "asks: x" },
      { at: 8, kind: "tool", text: "commandExecution: ls" },
    ]);
  });

  test("the task a Codex thread starts with says what it is, then the task", () => {
    const text = codexTaskText({ title: "Scout", leadTitle: "Main chat", task: "list the files" });
    expect(text).toContain('worker thread titled "Scout", started by the lead chat "Main chat"');
    expect(text.endsWith("Task:\nlist the files")).toBe(true);
  });

  test("parseNew reads --codex, passes --effort through, and refuses --worktree and a second backend flag", () => {
    expect(parseNew("codex Scout --codex -- list files")).toMatchObject({ model: "codex", title: "Scout", backend: "codex", task: "list files" });
    expect(parseNew("gpt-5 Scout --codex --effort high -- task")).toMatchObject({ model: "gpt-5", backend: "codex", effort: "high" });
    expect(parseNew("haiku Scout -- task")).toMatchObject({ backend: "auto" });
    expect(parseNew("codex Scout --codex --worktree -- task")).toEqual({ error: CODEX_NO_WORKTREE });
    expect((parseNew("codex Scout --codex --inline -- task") as any).error).toMatch(/Pick one of --inline, --session or --codex/);
    expect((parseNew("codex Scout --session --codex -- task") as any).error).toMatch(/Pick one/);
  });

  test("a Codex thread is resumed by its id; a Claude thread by its session", () => {
    expect(resumeCommand({ backend: "codex", codexThreadId: "th-1", cwd: "/w", sessionId: "" } as any)).toBe("codex resume th-1");
    expect(resumeCommand({ backend: "session", codexThreadId: "", cwd: "/w", sessionId: "abc" } as any)).toBe("cd '/w' && claude --resume abc");
  });
});
