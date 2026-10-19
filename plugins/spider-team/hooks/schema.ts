// Types plus `allOf`, a value-level identity: register.tsx may import this file without hiding a `$` call from the engine.
// Every plugin's hooks/schema.ts is a byte-for-byte copy of scripts/plugin-template/hooks/schema.ts.tmpl
// (scripts/check-consistency.mjs fails on a divergent copy).

/** Every ordering of the union `U`, so a tuple of this type lists each member exactly once. Factorial: used for `required` only, meant for up to ~6 required keys. */
type Permutations<U, A = U> = [U] extends [never] ? [] : A extends unknown ? [A, ...Permutations<Exclude<U, A>>] : never

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]

declare const ALL_OF: unique symbol

/** An `enum` built by `allOf` for exactly the union `V`: the brand keeps a hand-written array, a subset or a superset out of the slot. */
export type AllOf<V extends string> = readonly V[] & { readonly [ALL_OF]: (value: V) => V }

/** True when a member of the tuple `A` appears twice. */
type HasDuplicate<A extends readonly unknown[]> = A extends readonly [infer H, ...infer R] ? (H extends R[number] ? true : HasDuplicate<R>) : false

/**
 * The JSON Schema of one property, tied to the type `V` of the same property in `McpToolInputs`. A union of string
 * literals needs an `enum` built with `allOf`; a number may be `number` or `integer`; a number or boolean literal and
 * an object fail closed.
 */
type PropertySchema<V> = { description?: string } & (unknown extends V
  ? unknown
  : [V] extends [boolean]
    ? boolean extends V
      ? { type: 'boolean' }
      : never
    : [V] extends [number]
      ? number extends V
        ? { type: 'number' } | { type: 'integer' }
        : never
      : [V] extends [string]
        ? string extends V
          ? { type: 'string' }
          : { type: 'string'; enum: AllOf<V> }
        : [V] extends [readonly (infer I)[]]
          ? { type: 'array'; items: PropertySchema<I> }
          : never)

/**
 * Ties a tool's `inputSchema` to its `McpToolInputs` entry in types/index.d.ts: `satisfies SchemaFor<McpToolInputs[...]>`
 * fails tsc when the schema has a property the type lacks or omits one, when `required` is not exactly the type's
 * required keys (any order; it may be omitted or `[]` when the type has none), when a property's `type` or `items`
 * disagrees, or when a literal union's `enum` is not the `allOf` of exactly its members. A property type the helper
 * does not know (a number or boolean literal, an object) fails closed. Descriptions are not checked.
 */
export type SchemaFor<T> = {
  type: 'object'
  properties: { [K in keyof T]-?: PropertySchema<Required<T>[K]> }
} & ([RequiredKeys<T>] extends [never] ? { required?: [] } : { required: Permutations<RequiredKeys<T>> })

/**
 * The members of the string union `V` (an optional property's type may be passed as is), each listed once and kept in
 * the given order: tsc fails when one is missing or repeated (`allOf<'a' | 'b'>()('a')`). At runtime it returns its
 * arguments unchanged, so the emitted schema is the plain array.
 */
export const allOf =
  <V extends string | undefined>() =>
  <const A extends readonly Exclude<V, undefined>[]>(
    ...values: A &
      (number extends A['length']
        ? never
        : [Exclude<V, undefined | A[number]>] extends [never]
          ? HasDuplicate<A> extends true
            ? never
            : unknown
          : never)
  ): A & AllOf<Exclude<V, undefined>> =>
    // The brand exists only in the type: the value is the argument array itself.
    values as unknown as A & AllOf<Exclude<V, undefined>>
