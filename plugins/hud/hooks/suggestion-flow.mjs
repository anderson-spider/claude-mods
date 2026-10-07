import { suggestionData, freshSuggestions, skillList, forkPrompt, parseSuggestions, combine } from "./suggestions.mjs";

// Turn over: ask the fork, detached, so the turn's completion never waits on it.
export function startSuggestions({ show, commands: listCommands, fork, log, suggest }, e) {
  if (e.reason !== "answer" || (e.answer ?? "").trim().length < suggestionData.minAnswerChars) return;
  const turnId = e.turnId;
  show({ kind: "loading", turnId });
  void (async () => {
    let items = [];
    try {
      // Without the list the fork still suggests; slash prompts go unchecked.
      const commands = await listCommands().catch(() => null);
      const known = commands === null ? null : new Set(commands.map((command) => command.name));
      const skills = suggestionData.suggestSkills && commands !== null ? skillList(commands) : "";
      const reply = await fork({ prompt: forkPrompt(skills) });
      items = reply.isAnswered ? parseSuggestions(reply.text, known) : [];
    } catch (error) {
      log(`fork failed: ${String(error)}`);
    }
    // A newer turn started (or another completed) while we waited: drop ours.
    if (suggestionData.current.kind !== "loading" || suggestionData.current.turnId !== turnId) return;
    show(items.length === 0 ? freshSuggestions() : { kind: "offer", items, picked: [] });
    if (items[0]) void suggest({ text: items[0].prompt }).catch(() => undefined);
  })();
}

// Picks an item, or drops it from the picks when it is already there. A press from an older, longer
// offer names an item the current one does not have: ignored.
export function togglePick(show, index) {
  if (suggestionData.current.kind !== "offer") return;
  const { items, picked } = suggestionData.current;
  if (!(index >= 0 && index < items.length)) return;
  show({ kind: "offer", items, picked: picked.includes(index) ? picked.filter((i) => i !== index) : [...picked, index] });
}

// Writes the picks to the prompt box as a draft and hides the block; the person edits and sends it.
export function writePicks({ show, fill, toast }) {
  if (suggestionData.current.kind !== "offer") return;
  const text = combine(suggestionData.current.items, suggestionData.current.picked);
  show(freshSuggestions());
  if (text === "") return;
  fill({ text }).then(
    (r) => r.isFilled || toast("could not fill the prompt box"),
    (error) => toast(`could not fill: ${String(error)}`),
  );
}
