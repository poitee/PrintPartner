import { AsyncLocalStorage } from "node:async_hooks";

const tenantStorage = new AsyncLocalStorage<string>();

export function setRequestTenantId(tenantId: string): void {
  tenantStorage.enterWith(tenantId);
}

export function getRequestTenantId(fallback = "default"): string {
  return tenantStorage.getStore() ?? fallback;
}

export { tenantStorage };
