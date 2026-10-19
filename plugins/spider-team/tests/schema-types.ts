// Type-level cases for hooks/schema.ts, checked by tsc only (no test runner loads this file). Each `@ts-expect-error`
// line must fail to compile; the lines without one must compile. Every plugin's copy is byte-for-byte this template.
import { allOf, type SchemaFor } from '../hooks/schema'

type Input = { text: string; mode?: 'plain' | 'upper'; on?: boolean; count?: number; tags?: string[]; body?: unknown }
type NoneRequired = { text?: string }
type Nested = { nested: { a: string } }

const MODE = allOf<Input['mode']>()('plain', 'upper')
const T = { type: 'string' } as const

// The full schema compiles, `required` in any order, a number as `number` or `integer`, `unknown` unchecked.
;({ type: 'object', properties: { text: T, mode: { type: 'string', enum: MODE }, on: { type: 'boolean' }, count: { type: 'number' }, tags: { type: 'array', items: T }, body: {} }, required: ['text'] }) satisfies SchemaFor<Input>
;({ type: 'object', properties: { text: T, mode: { type: 'string', enum: MODE }, on: { type: 'boolean' }, count: { type: 'integer' }, tags: { type: 'array', items: T }, body: { description: 'any' } }, required: ['text'] }) satisfies SchemaFor<Input>
;({ type: 'object', properties: { a: T, b: T }, required: ['b', 'a'] }) satisfies SchemaFor<{ a: string; b: string }>

// `allOf` keeps the order it is given, and returns its arguments unchanged.
allOf<'a' | 'b'>()('b', 'a') satisfies readonly ['b', 'a']

// A missing, repeated or foreign member, or an array that is not a tuple, fails.
// @ts-expect-error a missing member
allOf<'a' | 'b'>()('a')
// @ts-expect-error a repeated member
allOf<'a' | 'b'>()('a', 'b', 'a')
// @ts-expect-error a member outside the union
allOf<'a' | 'b'>()('a', 'b', 'c')
// @ts-expect-error a plain array may hide a missing member
allOf<'a' | 'b'>()(...(['a'] as ('a' | 'b')[]))

// The enum slot takes only the `allOf` of exactly the property's union.
// @ts-expect-error a plain literal array instead of allOf
;({ type: 'object', properties: { text: T, mode: { type: 'string', enum: ['plain', 'upper'] } }, required: ['text'] }) satisfies SchemaFor<Pick<Input, 'text' | 'mode'>>
// @ts-expect-error the allOf of a subset of the union
;({ type: 'object', properties: { text: T, mode: { type: 'string', enum: allOf<'plain'>()('plain') } }, required: ['text'] }) satisfies SchemaFor<Pick<Input, 'text' | 'mode'>>
// @ts-expect-error a literal union without an enum
;({ type: 'object', properties: { text: T, mode: T }, required: ['text'] }) satisfies SchemaFor<Pick<Input, 'text' | 'mode'>>

// A wrong `type` fails.
// @ts-expect-error a boolean given as string
;({ type: 'object', properties: { text: T, on: T }, required: ['text'] }) satisfies SchemaFor<Pick<Input, 'text' | 'on'>>
// @ts-expect-error a number given as boolean
;({ type: 'object', properties: { text: T, count: { type: 'boolean' } }, required: ['text'] }) satisfies SchemaFor<Pick<Input, 'text' | 'count'>>
// @ts-expect-error an array of strings whose items are numbers
;({ type: 'object', properties: { text: T, tags: { type: 'array', items: { type: 'number' } } }, required: ['text'] }) satisfies SchemaFor<Pick<Input, 'text' | 'tags'>>

// A missing or extra property fails.
// @ts-expect-error a property the type has is missing
;({ type: 'object', properties: {}, required: ['text'] }) satisfies SchemaFor<Pick<Input, 'text'>>
// @ts-expect-error a property the type lacks
;({ type: 'object', properties: { text: T, other: T }, required: ['text'] }) satisfies SchemaFor<Pick<Input, 'text'>>

// `required` is exactly the required keys.
// @ts-expect-error a missing required key
;({ type: 'object', properties: { a: T, b: T }, required: ['a'] }) satisfies SchemaFor<{ a: string; b: string }>
// @ts-expect-error an extra required key
;({ type: 'object', properties: { text: T, mode: { type: 'string', enum: MODE } }, required: ['text', 'mode'] }) satisfies SchemaFor<Pick<Input, 'text' | 'mode'>>
// @ts-expect-error a repeated required key
;({ type: 'object', properties: { text: T }, required: ['text', 'text'] }) satisfies SchemaFor<Pick<Input, 'text'>>
// @ts-expect-error `required` omitted while a key is required
;({ type: 'object', properties: { text: T } }) satisfies SchemaFor<Pick<Input, 'text'>>

// With no required key, `required` may be omitted or `[]`, and nothing else.
;({ type: 'object', properties: { text: T } }) satisfies SchemaFor<NoneRequired>
;({ type: 'object', properties: { text: T }, required: [] }) satisfies SchemaFor<NoneRequired>
// @ts-expect-error an optional key listed as required
;({ type: 'object', properties: { text: T }, required: ['text'] }) satisfies SchemaFor<NoneRequired>

// A number or boolean literal fails closed: its schema would need a `const` or `enum` the helper does not check.
// @ts-expect-error a number literal union given as number
;({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }) satisfies SchemaFor<{ n: 1 | 2 }>
// @ts-expect-error a boolean literal given as boolean
;({ type: 'object', properties: { b: { type: 'boolean' } }, required: ['b'] }) satisfies SchemaFor<{ b: true }>

// An object-typed property fails closed, whatever its schema.
// @ts-expect-error an object property
;({ type: 'object', properties: { nested: { type: 'object' } }, required: ['nested'] }) satisfies SchemaFor<Nested>
