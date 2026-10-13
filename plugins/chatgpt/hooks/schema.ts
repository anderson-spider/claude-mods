// Types only (erased at build), so the registry may import it without hiding a `$` call from the engine.

/** Every ordering of the union `U`, so a tuple of this type lists each member exactly once. Factorial: meant for up to ~6 members. */
type Permutations<U, A = U> = [U] extends [never] ? [] : A extends unknown ? [A, ...Permutations<Exclude<U, A>>] : never

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T]

/** The JSON Schema of one property, tied to the type `V` of the same property in `McpToolInputs`. A property type the helper does not know fails closed. */
type PropertySchema<V> = { description?: string } & (unknown extends V
  ? unknown
  : [V] extends [string]
    ? string extends V
      ? { type: 'string' }
      : never
    : [V] extends [number]
      ? { type: 'number' }
      : [V] extends [boolean]
        ? { type: 'boolean' }
        : [V] extends [readonly (infer I)[]]
          ? { type: 'array'; items: PropertySchema<I> }
          : never)

/**
 * Ties a tool's `inputSchema` to its `McpToolInputs` entry in types/index.d.ts: `satisfies SchemaFor<McpToolInputs[...]>`
 * fails tsc when the schema has a property the type lacks or omits one, when a property's `type` or `items` disagrees,
 * or when `required` is not exactly the type's required keys (any order). A type with no required key may omit
 * `required`. Descriptions are not checked.
 */
export type SchemaFor<T> = {
  type: 'object'
  properties: { [K in keyof T]-?: PropertySchema<Required<T>[K]> }
} & ([RequiredKeys<T>] extends [never] ? { required?: [] } : { required: Permutations<RequiredKeys<T>> })
