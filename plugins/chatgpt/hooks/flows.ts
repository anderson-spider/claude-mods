import { ask } from './ask'
import { generateImage } from './image'
import { saveAnswer, saveImages } from './output'

// The flows a request can ask for. A row says how the flow runs in the prepared tab and how its result is saved;
// everything they share (the saveOnly guard, the tab, the compose and send steps) is in conversation.ts.
// A new flow is a row here, its module, and its texts, schema and tool registration.
export const FLOWS = {
  ask: { run: ask, save: saveAnswer },
  image: { run: generateImage, save: saveImages },
}

export type Kind = keyof typeof FLOWS
