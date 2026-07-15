declare const brand: unique symbol;

/** A nominal string type without a runtime wrapper. */
export type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type NamespacedId = Brand<string, 'NamespacedId'>;
export type PluginId = Brand<string, 'PluginId'>;
export type CapabilityId = Brand<string, 'CapabilityId'>;
export type ServiceId = Brand<string, 'ServiceId'>;
export type EventId = Brand<string, 'EventId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type SemanticVersion = Brand<string, 'SemanticVersion'>;

const NAMESPACED_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isNamespacedId(value: string): value is NamespacedId {
  return NAMESPACED_ID.test(value);
}

export function namespacedId(value: string): NamespacedId {
  if (!isNamespacedId(value)) {
    throw new TypeError(
      `Invalid namespaced ID "${value}". Expected lowercase "namespace/name" syntax.`,
    );
  }
  return value;
}

export function pluginId(value: string): PluginId {
  namespacedId(value);
  return value as PluginId;
}

export function capabilityId(value: string): CapabilityId {
  namespacedId(value);
  return value as CapabilityId;
}

export function serviceId(value: string): ServiceId {
  namespacedId(value);
  return value as ServiceId;
}

export function eventId(value: string): EventId {
  namespacedId(value);
  return value as EventId;
}

export function sessionId(value: string): SessionId {
  if (value.trim().length === 0) {
    throw new TypeError('Session ID must be a non-empty string.');
  }
  return value as SessionId;
}

export function isSemanticVersion(value: string): value is SemanticVersion {
  return SEMANTIC_VERSION.test(value);
}

export function semanticVersion(value: string): SemanticVersion {
  if (!isSemanticVersion(value)) {
    throw new TypeError(`Invalid semantic version "${value}".`);
  }
  return value;
}
