import { describe, expect, it, vi } from "vitest";
import {
  createDockerAdapterForSpec,
  createEngineDockerAdapter,
  createFakeDockerAdapter,
  parseDockerHostOptions,
  parseEnvJson,
  parsePortsJson,
  parseVolumesJson,
  SLICER_INSTANCE_LABEL,
  specFromInstanceRow,
  type DockerodeLike,
  type SlicerContainerSpec,
} from "./slicer-docker.js";
import type { SlicerInstanceRow } from "../db/repository.js";

const baseSpec: SlicerContainerSpec = {
  instanceId: "slicer-1",
  name: "Orca",
  image: "lscr.io/linuxserver/orcaslicer:latest",
  containerName: "orcaslicer",
  dockerTarget: "local",
  ports: [],
  volumes: [],
  env: {},
};

const composeSpec: SlicerContainerSpec = {
  ...baseSpec,
  dockerTarget: "pp_compose",
  composeService: "orcaslicer",
  ports: [{ host: 3010, container: 3000, protocol: "tcp" }],
};

describe("slicer docker helpers", () => {
  it("exports the ownership label", () => {
    expect(SLICER_INSTANCE_LABEL).toBe("printpartner.slicer_instance_id");
  });

  it("parses ports, volumes, and env JSON safely", () => {
    expect(
      parsePortsJson('[{"host":3010,"container":3000,"protocol":"tcp"}]'),
    ).toEqual([{ host: 3010, container: 3000, protocol: "tcp" }]);
    expect(parsePortsJson("nope")).toEqual([]);
    expect(parseVolumesJson('[{"host":"orca-config","container":"/config"}]')).toEqual([
      { host: "orca-config", container: "/config", mode: "rw" },
    ]);
    expect(parseEnvJson('{"PUID":"1000","n":1}')).toEqual({ PUID: "1000", n: "1" });
  });

  it("builds a container spec from an instance row", () => {
    const row = {
      id: "slicer-abc",
      name: "Orca",
      kind: "orca",
      dialect: "orca_json",
      guiUrl: "http://orca.home",
      watchPath: "/slicer-profiles/orca",
      dockerTarget: "local",
      dockerHost: null,
      composeService: null,
      image: "lscr.io/linuxserver/orcaslicer:latest",
      containerName: "orcaslicer",
      portsJson: '[{"host":3010,"container":3000}]',
      volumesJson: "[]",
      envJson: "{}",
      statusCache: "unknown",
      statusMessage: null,
      enabled: true,
      createdAt: "t",
      updatedAt: "t",
    } satisfies SlicerInstanceRow;
    const spec = specFromInstanceRow(row);
    expect(spec.instanceId).toBe("slicer-abc");
    expect(spec.ports[0]).toMatchObject({ host: 3010, container: 3000 });
  });
});

describe("createFakeDockerAdapter", () => {
  it("creates a labeled container on start and reports running", async () => {
    const docker = createFakeDockerAdapter();
    const status = await docker.start(baseSpec);
    expect(status.state).toBe("running");
    expect(status.containerId).toBeTruthy();
    expect(await docker.refreshStatus(baseSpec)).toMatchObject({ state: "running" });
  });

  it("refuses to start when container name is owned by another instance", async () => {
    const docker = createFakeDockerAdapter([
      {
        id: "c1",
        name: "orcaslicer",
        image: "other",
        labels: { [SLICER_INSTANCE_LABEL]: "someone-else" },
        state: "stopped",
        logs: [],
      },
    ]);
    const status = await docker.start(baseSpec);
    expect(status.state).toBe("error");
    expect(status.message).toMatch(/not labeled/i);
  });

  it("stops and returns logs", async () => {
    const docker = createFakeDockerAdapter();
    await docker.start(baseSpec);
    await docker.stop(baseSpec);
    expect(await docker.refreshStatus(baseSpec)).toMatchObject({ state: "stopped" });
    const { lines } = await docker.logs(baseSpec, { tail: 10 });
    expect(lines.some((l) => l.includes("started"))).toBe(true);
    expect(lines.some((l) => l.includes("stopped"))).toBe(true);
  });

  it("adopts unlabeled containers for pp_compose", async () => {
    const docker = createFakeDockerAdapter([
      {
        id: "c-stock",
        name: "orcaslicer",
        image: "lscr.io/linuxserver/orcaslicer:latest",
        labels: {},
        state: "running",
        logs: [],
      },
    ]);
    const status = await docker.refreshStatus(composeSpec);
    expect(status.state).toBe("running");
    expect(status.containerId).toBe("c-stock");
    const started = await docker.start(composeSpec);
    expect(started.state).toBe("running");
  });
});

describe("parseDockerHostOptions", () => {
  it("uses the unix socket by default", () => {
    expect(parseDockerHostOptions(null).socketPath).toMatch(/docker\.sock$/);
  });

  it("parses unix:// socket URLs", () => {
    expect(parseDockerHostOptions("unix:///custom/docker.sock")).toEqual({
      socketPath: "/custom/docker.sock",
    });
  });

  it("parses tcp:// and bare host:port into host/port/protocol", () => {
    expect(parseDockerHostOptions("tcp://192.168.1.10:2375")).toEqual({
      protocol: "http",
      host: "192.168.1.10",
      port: 2375,
    });
    expect(parseDockerHostOptions("10.0.0.2:2376")).toEqual({
      protocol: "https",
      host: "10.0.0.2",
      port: 2376,
    });
    expect(parseDockerHostOptions("https://docker.example:2376")).toEqual({
      protocol: "https",
      host: "docker.example",
      port: 2376,
    });
  });
});

function mockEngine(seed: Array<{
  Id: string;
  Names: string[];
  Labels: Record<string, string>;
  State: string;
}>): { docker: DockerodeLike; created: Array<Record<string, unknown>> } {
  const containers = [...seed];
  const created: Array<Record<string, unknown>> = [];
  const docker: DockerodeLike = {
    async listContainers(opts) {
      if (opts?.filters) {
        const parsed = JSON.parse(opts.filters) as { label?: string[] };
        const want = parsed.label?.[0];
        if (want) {
          const [key, value] = want.split("=");
          return containers.filter((c) => c.Labels[key!] === value);
        }
      }
      return containers;
    },
    getContainer(id: string) {
      return {
        async inspect() {
          const c = containers.find((x) => x.Id === id)!;
          return {
            Id: c.Id,
            Name: c.Names[0],
            State: { Running: c.State === "running", Status: c.State },
            Config: { Labels: c.Labels },
          };
        },
        async start() {
          const c = containers.find((x) => x.Id === id);
          if (c) c.State = "running";
        },
        async stop() {
          const c = containers.find((x) => x.Id === id);
          if (c) c.State = "exited";
        },
        async logs() {
          return Buffer.from("log line\n");
        },
      };
    },
    async createContainer(opts) {
      created.push(opts);
      const id = `created-${created.length}`;
      containers.push({
        Id: id,
        Names: [`/${String(opts.name)}`],
        Labels: (opts.Labels as Record<string, string>) ?? {},
        State: "created",
      });
      return {
        id,
        async start() {
          const c = containers.find((x) => x.Id === id);
          if (c) c.State = "running";
        },
      };
    },
    pull(_image, cb) {
      cb(null, { on() {}, pipe() {} } as unknown as NodeJS.ReadableStream);
    },
    modem: {
      followProgress(_stream, onFinished) {
        onFinished(null);
      },
    },
  };
  return { docker, created };
}

describe("createEngineDockerAdapter", () => {
  it("adopts unlabeled stock compose containers instead of conflict", async () => {
    const { docker } = mockEngine([
      {
        Id: "stock-1",
        Names: ["/orcaslicer"],
        Labels: {},
        State: "running",
      },
    ]);
    const adapter = createEngineDockerAdapter(null, () => docker);
    const status = await adapter.refreshStatus(composeSpec);
    expect(status).toMatchObject({ state: "running", containerId: "stock-1" });
    const started = await adapter.start(composeSpec);
    expect(started.state).toBe("running");
  });

  it("still refuses containers labeled for another instance", async () => {
    const { docker } = mockEngine([
      {
        Id: "other-1",
        Names: ["/orcaslicer"],
        Labels: { [SLICER_INSTANCE_LABEL]: "someone-else" },
        State: "running",
      },
    ]);
    const adapter = createEngineDockerAdapter(null, () => docker);
    const status = await adapter.start(composeSpec);
    expect(status.state).toBe("error");
    expect(status.message).toMatch(/not labeled/i);
  });

  it("sets ExposedPorts alongside PortBindings on create", async () => {
    const { docker, created } = mockEngine([]);
    const adapter = createEngineDockerAdapter(null, () => docker);
    await adapter.start({
      ...baseSpec,
      ports: [{ host: 3010, container: 3000, protocol: "tcp" }],
    });
    expect(created[0]).toMatchObject({
      ExposedPorts: { "3000/tcp": {} },
      HostConfig: {
        PortBindings: { "3000/tcp": [{ HostPort: "3010" }] },
      },
    });
  });
});

describe("createDockerAdapterForSpec pp_compose", () => {
  it("runs compose up for start when targeting pp_compose", async () => {
    const { docker } = mockEngine([]);
    const composeExec = vi.fn(async (args: string[]) => {
      expect(args[0]).toBe("up");
      // Simulate compose creating the unlabeled stock container
      const listed = await docker.listContainers({ all: true });
      if (listed.length === 0) {
        await docker.createContainer({
          Image: composeSpec.image,
          name: composeSpec.containerName,
          Labels: {},
        });
        const created = (await docker.listContainers({ all: true }))[0]!;
        created.State = "running";
      }
      return { stdout: "", stderr: "" };
    });
    const adapter = createDockerAdapterForSpec(composeSpec, {
      engineFactory: () => docker,
      composeExec,
    });
    const status = await adapter.start(composeSpec);
    expect(composeExec).toHaveBeenCalled();
    expect(status.state).toBe("running");
  });
});
