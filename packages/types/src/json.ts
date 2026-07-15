export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonArray = readonly JsonValue[];

export type DeepReadonly<Value> = Value extends JsonPrimitive
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

/** Clones and recursively freezes a JSON value, rejecting non-JSON input. */
export function immutableJson(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError('Expected a finite, JSON-compatible value.');
  }
  return cloneAndFreeze(value);
}

function cloneAndFreeze(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    const array = value as JsonArray;
    return Object.freeze(array.map((item) => cloneAndFreeze(item)));
  }
  if (value !== null && typeof value === 'object') {
    const clone: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) {
      clone[key] = cloneAndFreeze(item);
    }
    return Object.freeze(clone);
  }
  return value;
}
