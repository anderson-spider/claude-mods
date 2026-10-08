// Codex threads: the pure parts (no `$`). The threads plugin talks to the helper
// (helper/helper.mjs) over its Unix socket; the caller passes in the host calls it uses.
import { clip, oneLine } from "./core.mjs";

export const CODEX_HOST = "http://codex-threads";
// The ChatGPT app's node, which the helper runs under when it is installed.
export const CUA_NODE = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";

const APPROVAL_TEXT_MAX = 400;
const MODES = {
  default: { sandbox: "read-only", approval: "on-request" },
  acceptEdits: { sandbox: "workspace-write", approval: "on-request" },
  plan: { sandbox: "read-only", approval: "untrusted" },
  auto: { sandbox: "workspace-write", approval: "on-request" },
};
const HELPER_STATUS = new Set(["starting", "working", "idle", "needs-you", "exited"]);
const ACTIVITY_KIND = { answer: "assistant", approval: "wait" };

export const helperSocket = (home) => `${home}/.claude/threads-codex/run/helper.sock`;

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const parseReply = (text) => {
  try {
    const body = JSON.parse(text ?? "{}");
    return body !== null && typeof body === "object" ? body : { status: "error", message: "the helper sent no JSON object" };
  } catch {
    return { status: "error", message: "the helper sent no JSON" };
  }
};

/**
 * One call to the helper over its socket. `deps` = { fetch, socketPath }, where fetch is the host's
 * $.http.fetch. GET when there is no body. Never throws: an unreachable helper is status 0.
 */
export async function callHelper(deps, route, body) {
  const init = { socketPath: deps.socketPath, method: body === undefined ? "GET" : "POST" };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res;
  try {
    res = await deps.fetch(`${CODEX_HOST}${route}`, init);
  } catch (error) {
    return { ok: false, status: 0, body: { status: "error", message: `the Codex helper is not reachable (${messageOf(error)})` } };
  }
  const status = Number(res?.status) || 0;
  return { ok: status >= 200 && status < 300, status, body: parseReply(res?.text) };
}

// Single quotes, so a folder name cannot end the shell word early.
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The argv that starts the helper detached; it exits by itself when another one already serves. */
export function startHelperArgv(root, node = "node") {
  return ["sh", "-c", `nohup ${quote(node)} ${quote(`${root}/helper/helper.mjs`)} >/dev/null 2>&1 &`];
}

/** Thread permission mode -> the sandbox and approval policy Codex gets. Codex threads never bypass. */
export function codexModes(mode) {
  if (mode === "bypassPermissions") return { error: "Codex threads never bypass permissions. Use default, acceptEdits, plan or auto." };
  if (!Object.hasOwn(MODES, mode)) return { error: `Unknown permission mode "${mode}" for a Codex thread. Use default, acceptEdits, plan or auto.` };
  return { ...MODES[mode] };
}

/** The model a Codex thread asks for: any name passed through, or none for the account default. */
export function codexModelOf(raw) {
  const model = String(raw ?? "").trim();
  return model === "" || model.toLowerCase() === "codex" ? undefined : model;
}

/** The helper's status for a thread -> the plugin's status, plus the error to show (failed keeps the thread idle). */
export function statusFromHelper(h) {
  const status = h?.status;
  if (status === "failed") return { status: "idle", error: String(h.error ?? "the turn failed") };
  if (HELPER_STATUS.has(status)) return { status, error: status === "exited" ? String(h.error ?? "") : "" };
  return { status: "exited", error: `the helper reported an unknown status (${String(status)})` };
}

/** The text the person reads for a pending approval ({method, params} from the helper). */
export function approvalPrompt(pending) {
  if (!pending) return "";
  const params = pending.params ?? {};
  const reason = params.reason ? ` Reason: ${oneLine(params.reason)}.` : "";
  switch (pending.method) {
    case "item/commandExecution/requestApproval": {
      const where = params.cwd ? ` in ${oneLine(params.cwd)}` : "";
      return clip(`Codex asks to run ${oneLine(params.command ?? "a command")}${where}.${reason}`, APPROVAL_TEXT_MAX);
    }
    case "item/fileChange/requestApproval": {
      const files = Array.isArray(params.changes) ? params.changes.map((c) => c?.path).filter(Boolean) : [];
      const what = files.length ? files.map((f) => oneLine(f)).join(", ") : "files";
      return clip(`Codex asks to change ${what}.${reason}`, APPROVAL_TEXT_MAX);
    }
    case "item/permissions/requestApproval":
      return clip(`Codex asks for more permissions than this thread has.${reason}`, APPROVAL_TEXT_MAX);
    default:
      return clip(`Codex asks for an answer (${oneLine(pending.method)}).`, APPROVAL_TEXT_MAX);
  }
}

/**
 * What a registry row shows of its Codex thread, from the helper's snapshot
 * ({ reachable, byId }). A helper that is down, or no longer tracks the thread, means exited.
 */
export function codexStateOf(t, snapshot) {
  if (!snapshot.reachable) {
    return { status: "exited", codexError: "the Codex helper is not running, so this thread is no longer tracked", prompt: "", lastLine: "" };
  }
  const h = snapshot.byId.get(t.codexThreadId);
  if (!h) return { status: "exited", codexError: "the Codex helper no longer tracks this thread (it restarted)", prompt: "", lastLine: "" };
  const mapped = statusFromHelper(h);
  const prompt = h.pendingApproval ? approvalPrompt(h.pendingApproval) : "";
  let lastLine = "";
  if (prompt) lastLine = clip(`wait  ${prompt}`, 200);
  else if (h.lastAnswer?.text) lastLine = clip(`says  ${oneLine(h.lastAnswer.text)}`, 200);
  else if (h.error) lastLine = clip(`error ${oneLine(h.error)}`, 200);
  return { status: mapped.status, codexError: mapped.error, prompt, lastLine };
}

// The first message of a thread carries the preface; the feed shows only the task after it.
const PREFACE = /^You are a worker thread[\s\S]*?\n\nTask:\n([\s\S]*)$/;

/** The helper's activity lines as the feed shows them ({at, kind, text}). */
export function codexActivity(items) {
  return (Array.isArray(items) ? items : []).map((x) => {
    const text = String(x.text ?? "");
    const task = PREFACE.exec(text);
    return { at: Number(x.at) || 0, kind: ACTIVITY_KIND[x.kind] ?? x.kind, text: task ? `task: ${task[1]}` : text };
  });
}

/** The task a Codex thread starts with: a preface that says what it is, then the task. */
export function codexTaskText({ title, leadTitle, task }) {
  return [
    `You are a worker thread titled "${title}", started by the lead chat "${leadTitle}". That chat sees each of your answers and may send you more messages.`,
    "",
    "Task:",
    task,
  ].join("\n");
}
