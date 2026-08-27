import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, vi } from "vitest";

export type EndpointTestRequest = Readonly<{
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null;
}>;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

type EndpointTestMethod =
  "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

function isHttpMethod(value: string): value is EndpointTestMethod {
  return ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].includes(
    value,
  );
}

function responseHeaders(
  headers: Record<string, string | string[] | number | undefined>,
): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, String(value));
    }
  }
  return result;
}

export function createEndpointTestHttp() {
  let app: FastifyInstance | null = null;
  const queuedResponses: Response[] = [];
  const requests: EndpointTestRequest[] = [];
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];

  beforeEach(async () => {
    app = Fastify();
    app.addContentTypeParser(
      /^multipart\/form-data(?:;.*)?$/i,
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    app.all("/*", async (_request, reply) => {
      const response = queuedResponses.shift();
      if (!response) {
        return reply
          .status(500)
          .send({ detail: "Endpoint test response was not queued" });
      }
      const headers = Object.fromEntries(response.headers.entries());
      const body = Buffer.from(await response.arrayBuffer());
      return reply.status(response.status).headers(headers).send(body);
    });
    await app.ready();

    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!app) throw new Error("Endpoint test server is not running");
        const rawUrl = requestUrl(input);
        const absoluteUrl = new URL(rawUrl, "http://endpoint.test");
        const request = new Request(absoluteUrl, init);
        const body = init?.body ?? null;
        calls.push([input, init]);
        requests.push({
          url: `${absoluteUrl.pathname}${absoluteUrl.search}`,
          method: request.method,
          headers: request.headers,
          body,
        });

        const payload =
          request.body === null
            ? undefined
            : Buffer.from(await request.arrayBuffer());
        const method = request.method;
        if (!isHttpMethod(method)) {
          throw new Error(`Unsupported endpoint test method: ${method}`);
        }
        const response = await app.inject({
          method,
          url: `${absoluteUrl.pathname}${absoluteUrl.search}`,
          headers: Object.fromEntries(request.headers.entries()),
          payload,
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: responseHeaders(response.headers),
        });
      },
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    queuedResponses.length = 0;
    requests.length = 0;
    calls.length = 0;
    await app?.close();
    app = null;
  });

  type ResponseQueue = { respond(response: Response): ResponseQueue };
  const responseQueue: ResponseQueue = {
    respond(response) {
      queuedResponses.push(response);
      return responseQueue;
    },
  };

  function request(index = 0): EndpointTestRequest {
    const value = requests[index];
    if (!value) throw new Error(`Endpoint test request ${index} was not made`);
    return value;
  }

  function requestJson(index = 0): unknown {
    const body = request(index).body;
    if (typeof body !== "string") {
      throw new Error(
        `Endpoint test request ${index} did not have a JSON string body`,
      );
    }
    const value: unknown = JSON.parse(body);
    return value;
  }

  function requestForm(index = 0): FormData {
    const body = request(index).body;
    if (!(body instanceof FormData)) {
      throw new Error(
        `Endpoint test request ${index} did not have a FormData body`,
      );
    }
    return body;
  }

  return {
    calls,
    requests,
    request,
    requestForm,
    requestJson,
    respond: responseQueue.respond,
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
