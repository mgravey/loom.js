import type { Awaitable, ServiceId } from '@loom/types';
import { serviceId } from '@loom/types';

export type ServiceLifetime = 'runtime' | 'session' | 'transient';

/** A structural token. Resolution identity is its namespaced ID. */
export interface ServiceToken<Service> {
  readonly id: ServiceId;
  readonly __service?: (value: Service) => Service;
}

export function createServiceToken<Service>(id: string | ServiceId): ServiceToken<Service> {
  return Object.freeze({ id: serviceId(id) });
}

export interface ServiceResolver {
  get<Service>(token: ServiceToken<Service>): Promise<Service>;
  tryGet<Service>(token: ServiceToken<Service>): Promise<Service | undefined>;
}

export type ServiceFactory<Service> = (resolver: ServiceResolver) => Awaitable<Service>;

/** Available only to a plugin while its initialize hook is executing. */
export interface ServiceRegistrar {
  registerValue<Service>(token: ServiceToken<Service>, value: Service): void;
  registerFactory<Service>(
    token: ServiceToken<Service>,
    factory: ServiceFactory<Service>,
    options?: { readonly lifetime?: ServiceLifetime },
  ): void;
}

export interface ServiceScope extends ServiceResolver {
  dispose(): Promise<void>;
}
