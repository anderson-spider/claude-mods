// Types only, plus `allOf`, a value-level identity: register.tsx may import this file without hiding a `$` call from the engine.

/** Every ordering of the union `U`, so a tuple of this type lists each member exactly once. Factorial: meant for up to ~6 members. */
type Permutations<U, A = U> = [U] extends [never] ? [] : A extends unknown ? [A, ...Permutations<Exclude<U, A>>] : never

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]

/**
 * The JSON Schema of one property, tied to the type `V` of the same property in `McpToolInputs`. A union of string
 * literals needs an `enum` of those literals: build it with `allOf`, which fails tsc when a member is missing.
 */
type PropertySchema<V> = { description?: string } & (unknown extends V
  ? unknown
  : [V] extends [string]
    ? string extends V
      ? { type: 'string' }
      : { type: 'string'; enum: readonly V[] }
    : [V] extends [number]
      ? { type: 'integer' }
      : [V] extends [boolean]
        ? { type: 'boolean' }
        : [V] extends [readonly (infer I)[]]
          ? { type: 'array'; items: PropertySchema<I> }
          : never)

/**
 * Ties a tool's `inputSchema` to its `McpToolInputs` entry in types/index.d.ts: `satisfies SchemaFor<McpToolInputs[...]>`
 * fails tsc when the schema has a property the type lacks or omits one, when `required` is not exactly the type's
 * required keys (any order), or when a property's `type` or `items` disagrees. Numbers are integers here. A property
 * type the helper does not know (object) fails closed. Descriptions are not checked.
 */
export type SchemaFor<T> = {
  type: 'object'
  properties: { [K in keyof T]-?: PropertySchema<Required<T>[K]> }
  required: Permutations<RequiredKeys<T>>
}

/** The members of the string union `V`, each listed once: tsc fails when one is missing (`allOf<'a' | 'b'>()('a')`). */
export const allOf =
  <V extends string>() =>
  <const A extends readonly V[]>(...values: A & ([Exclude<V, A[number]>] extends [never] ? unknown : never)): A =>
    values
