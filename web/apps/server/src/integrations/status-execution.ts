import type { IntegrationConfig } from "@print-partner/contracts";
import type { IntegrationAdapter } from "./store.js";

const permitBrand = Symbol("status execution");

export type StatusPermit = {
  readonly [permitBrand]: true;
  readonly signal: AbortSignal;
  readonly joinTransport: (closed: Promise<void>) => void;
};

type StatusWork = {
  id: number;
  provider: IntegrationAdapter["type"];
  operation: "probe" | "test" | "devices";
  controller: AbortController;
  joined: Promise<void>;
};

type Lifecycle =
  { kind: "running" } | { kind: "stopping"; joined: Promise<void> } | { kind: "stopped" };

export function statusRequest(permit: StatusPermit, timeoutMs: number) {
  permit.signal.throwIfAborted();
  return {
    signal: AbortSignal.any([permit.signal, AbortSignal.timeout(timeoutMs)]),
    joinTransport: permit.joinTransport,
  };
}

export class StatusExecution {
  private lifecycle: Lifecycle = { kind: "running" };
  private readonly work = new Map<number, StatusWork>();
  private nextId = 0;

  constructor(private readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid status capacity");
  }

  snapshot() {
    return {
      state: this.lifecycle.kind,
      tasks: [...this.work.values()].map(({ id, provider, operation }) => ({
        id,
        provider,
        operation,
      })),
    };
  }

  stop(): Promise<void> {
    if (this.lifecycle.kind === "stopped") return Promise.resolve();
    if (this.lifecycle.kind === "stopping") return this.lifecycle.joined;
    const pending = [...this.work.values()];
    const joined = Promise.all(pending.map((task) => task.joined)).then(() => {
      this.lifecycle = { kind: "stopped" };
    });
    this.lifecycle = { kind: "stopping", joined };
    for (const task of pending)
      task.controller.abort(new Error("Printer status execution stopped"));
    return joined;
  }

  probe(adapter: IntegrationAdapter, config: IntegrationConfig) {
    return this.run(adapter, "probe", (permit) => {
      if (!adapter.getStatus) throw new Error(`Status not supported for ${adapter.type}`);
      return adapter.getStatus(config, permit);
    });
  }

  test(adapter: IntegrationAdapter, config: IntegrationConfig) {
    if (!adapter.getStatus) return adapter.testConnection(config);
    return this.run(adapter, "test", (permit) => adapter.testConnection(config, permit));
  }

  devices(adapter: IntegrationAdapter, config: IntegrationConfig) {
    if (!adapter.getStatus) return adapter.listDevices?.(config) ?? Promise.resolve([]);
    return this.run(
      adapter,
      "devices",
      (permit) => adapter.listDevices?.(config, permit) ?? Promise.resolve([]),
    );
  }

  private async run<T>(
    adapter: IntegrationAdapter,
    operation: StatusWork["operation"],
    acquire: (permit: StatusPermit) => Promise<T>,
  ): Promise<T> {
    if (this.lifecycle.kind !== "running") throw new Error("Printer status execution stopped");
    if (this.work.size >= this.capacity)
      throw new Error("Printer status execution capacity reached");
    const id = ++this.nextId;
    const controller = new AbortController();
    let complete!: () => void;
    const joined = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.work.set(id, { id, provider: adapter.type, operation, controller, joined });
    const transports: Promise<void>[] = [];
    try {
      let result: T;
      try {
        result = await acquire({
          [permitBrand]: true,
          signal: controller.signal,
          joinTransport: (closed) => {
            transports.push(closed);
          },
        });
      } finally {
        await Promise.allSettled(transports);
      }
      controller.signal.throwIfAborted();
      return result;
    } finally {
      this.work.delete(id);
      complete();
    }
  }
}
