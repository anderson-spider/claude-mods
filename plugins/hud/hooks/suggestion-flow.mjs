import { suggestionData, freshSuggestions, skillList, forkPrompt, completePrompt, parseSuggestions } from "./suggestions.mjs";

// Turn over: ask for suggestions, detached, so the turn's completion never waits on it.
export function startSuggestions({ show, commands: listCommands, fork, complete, log, suggest }, e) {
  if (e.reason !== "answer" || (e.answer ?? "").trim().length < suggestionData.minAnswerChars) return;
  const turnId = e.turnId;
  const { model, lastRequest } = suggestionData;
  show({ kind: "loading", turnId });
  void (async () => {
    let items = [];
    try {
      // Without the list the model still suggests; slash prompts go unchecked.
      const commands = await listCommands().catch(() => null);
      const known = commands === null ? null : new Set(commands.map((command) => command.name));
      const skills = suggestionData.suggestSkills && commands !== null ? skillList(commands) : "";
      const reply = model === "fork"
        ? await fork({ prompt: forkPrompt(skills) })
        : await complete({ model: "haiku", effort: "low", maxTokens: 600, timeoutMs: 20000, prompt: completePrompt(skills, lastRequest, e.answer) });
      items = reply.isAnswered ? parseSuggestions(reply.text, known) : [];
      if (!reply.isAnswered) log(`${model} failed: ${reply.reason}`);
    } catch (error) {
      log(`${model} failed: ${String(error)}`);
    }
    // A newer turn started (or another completed) while we waited: drop ours.
    if (suggestionData.current.kind !== "loading" || suggestionData.current.turnId !== turnId) return;
    show(items.length === 0 ? freshSuggestions() : { kind: "offer", items });
    if (items[0]) void suggest({ text: items[0].prompt }).catch(() => undefined);
  })();
}

// Writes one suggestion to the prompt box as a draft and hides the block; the person edits and sends it.
// A press from an older, longer offer names an item the current one does not have: ignored.
export function fillSuggestion({ show, fill, toast }, index) {
  if (suggestionData.current.kind !== "offer") return;
  const item = suggestionData.current.items[index];
  if (!item) return;
  show(freshSuggestions());
  fill({ text: item.prompt }).then(
    (r) => r.isFilled || toast("could not fill the prompt box"),
    (error) => toast(`could not fill: ${String(error)}`),
  );
}
