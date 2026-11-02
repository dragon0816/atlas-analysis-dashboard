const resourceOwners = new WeakMap<object, number>();
/** Disposes a resource once its last owner has gone, surviving StrictMode's effect replay. */
export function retain(resource: { dispose: () => void } | null) {
  if (!resource) return () => {};
  resourceOwners.set(resource, (resourceOwners.get(resource) ?? 0) + 1);
  return () => {
    resourceOwners.set(resource, Math.max(0, (resourceOwners.get(resource) ?? 1) - 1));
    queueMicrotask(() => { if (resourceOwners.get(resource) === 0) resource.dispose(); });
  };
}
