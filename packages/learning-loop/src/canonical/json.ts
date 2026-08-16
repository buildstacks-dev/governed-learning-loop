// JSON value domain (docs/contract/api-contract.md §JSON values).
// Types only; the runtime guard lives in ./to-json-value.ts.

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
