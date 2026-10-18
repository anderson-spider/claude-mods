// List prices in USD per million tokens, for an estimate only: the host reports token counts, never money.
// Source: the Claude API reference's model table (cached 2026-10-06; prices as of that date) for input, output and the cache reads it lists
// (Fable 5.1, Opus 5.5, Sonnet 5.5); other cache rates use its stated multipliers, reads at 0.1x and 5-minute writes at
// 1.25x input. The host does not say which cache lifetime a request wrote, so writes are priced at the 5-minute rate and
// the estimate is a lower bound. Haiku 5.5 has a second rate card for a prompt (input plus cache) above 100K tokens. An
// unlisted model has no price.

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }
type Row = { match: RegExp; long?: Price } & Price

const LONG_PROMPT = 100_000

const price = (input: number, output: number, cacheRead = input / 10): Price => ({ input, output, cacheRead, cacheWrite: input * 1.25 })
const row = (match: RegExp, input: number, output: number, cacheRead?: number, long?: Price): Row => ({ match, ...price(input, output, cacheRead), ...(long ? { long } : {}) })

/** First match wins, so a version comes before its family. */
export const PRICES: readonly Row[] = [
  row(/(fable|mythos)-5-1/, 10, 50, 0.25),
  row(/(fable|mythos)-5(?!-\d)/, 10, 50),
  row(/opus-5-5/, 4, 20, 0.2),
  row(/opus-(5(?!-\d)|4-[678])/, 5, 25),
  row(/sonnet-5-5/, 2, 10, 0.2),
  row(/sonnet-5(?!-\d)/, 2, 10),
  row(/sonnet-4-6/, 3, 15),
  row(/haiku-5-5/, 0.1, 0.5, undefined, price(0.5, 2.5)),
  row(/haiku-4-5/, 1, 5),
]

/** The rates for `model`, on its long-prompt card when the request's prompt passes 100K tokens and it has one. */
export function priceOf(model: string, promptTokens = 0): Price | undefined {
  const found = PRICES.find(p => p.match.test(model))
  return found?.long && promptTokens > LONG_PROMPT ? found.long : found
}
