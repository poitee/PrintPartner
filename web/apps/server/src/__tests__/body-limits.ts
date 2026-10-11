import { globSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import type { RouteOptions } from "fastify";

type Limits = Record<string, number>;
type MultipartLimits = Record<string, number | { totalBytes: number; enforcement: string }>;

/** Test-only source reader: multipart overrides are inside handlers, not Fastify route options. */
function readMultipartRouteLimits(srcDir: string): Map<string, MultipartLimits> {
  const files = globSync("**/*.ts", { cwd: srcDir })
    .filter((file) => !file.endsWith(".test.ts") && !file.includes("__tests__"))
    .map((file) => resolve(srcDir, file));
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  function declaration(node: ts.Node): ts.Declaration | undefined {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration;
  }
  function number(node: ts.Expression): number {
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isParenthesizedExpression(node)) return number(node.expression);
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return number(decl.initializer);
    }
    if (ts.isBinaryExpression(node)) {
      const left = number(node.left);
      const right = number(node.right);
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.AsteriskToken: return left * right;
        case ts.SyntaxKind.PlusToken: return left + right;
        case ts.SyntaxKind.MinusToken: return left - right;
        case ts.SyntaxKind.SlashToken: return left / right;
      }
    }
    throw new Error(`Unsupported multipart limit: ${node.getText()}`);
  }
  function object(node: ts.Expression): ts.ObjectLiteralExpression {
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isIdentifier(node)) {
      const decl = declaration(node);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return object(decl.initializer);
    }
    throw new Error(`Unsupported multipart options: ${node.getText()}`);
  }
  const attributedCalls = new Set<ts.CallExpression>();
  function isMultipartCall(node: ts.Node): boolean {
    return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ["file", "files", "parts", "saveRequestFiles"].includes(node.expression.name.text) &&
      !!checker.getTypeAtLocation(node.expression.expression).getProperty("isMultipart");
  }
  function multipartIn(handler: ts.Node, visited = new Set<ts.Node>()): MultipartLimits[] {
    if (visited.has(handler)) return [];
    visited.add(handler);
    if (ts.isIdentifier(handler)) {
      const decl = declaration(handler);
      if (decl) return multipartIn(decl, visited);
    }
    const found: MultipartLimits[] = [];
    let aggregate: { totalBytes: number; enforcement: string } | undefined;
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && (declaration(callee) as ts.NamedDeclaration | undefined)?.name?.getText() === "streamSourceUpload") {
          const budget = node.arguments[2];
          if (budget && ts.isBinaryExpression(budget) && budget.operatorToken.kind === ts.SyntaxKind.MinusToken) {
            let statement: ts.Node = node;
            while (statement.parent && !ts.isExpressionStatement(statement)) statement = statement.parent;
            if (!ts.isIdentifier(budget.right) || !ts.isExpressionStatement(statement) ||
                !ts.isBinaryExpression(statement.expression) ||
                statement.expression.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken ||
                statement.expression.left.getText() !== budget.right.text) {
              throw new Error("Unsupported cumulative multipart budget guard");
            }
            const counter = declaration(budget.right);
            if (!counter || !ts.isVariableDeclaration(counter) || !counter.initializer) {
              throw new Error("Unsupported cumulative multipart counter");
            }
            aggregate = {
              totalBytes: number(budget.left) - number(counter.initializer),
              enforcement: statement.getText().replace(/\s+/g, " ").trim(),
            };
          }
        }
        if (isMultipartCall(node)) {
          attributedCalls.add(node);
          const limits: MultipartLimits = {};
          if (node.arguments[0]) {
            const options = object(node.arguments[0]);
            if (options.properties.some(ts.isSpreadAssignment)) {
              throw new Error("Unsupported spread in multipart options");
            }
            const property = options.properties.find((p) => p.name?.getText() === "limits");
            if (property && !ts.isPropertyAssignment(property)) {
              throw new Error("Unsupported multipart limits property");
            }
            if (property && ts.isPropertyAssignment(property)) {
              for (const entry of object(property.initializer).properties) {
                if (!ts.isPropertyAssignment(entry)) throw new Error("Unsupported multipart limit property");
                limits[entry.name.getText()] = number(entry.initializer);
              }
            }
          }
          found.push(limits);
        } else if (ts.isIdentifier(callee) && node.arguments.some(
          (arg) => !!checker.getTypeAtLocation(arg).getProperty("isMultipart"),
        )) {
          const decl = declaration(callee);
          if (decl && decl.getSourceFile().fileName.startsWith(srcDir)) {
            found.push(...multipartIn(decl, visited));
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(handler);
    if (aggregate) {
      if (found.length !== 1) throw new Error("Unattributed aggregate multipart budget");
      found[0].aggregateFiles = aggregate;
    }
    return found;
  }
  const routes = new Map<string, MultipartLimits>();
  for (const file of files) {
    const source = program.getSourceFile(file)!;
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ["get", "post", "put", "patch", "delete", "head", "options"].includes(node.expression.name.text) &&
          node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
        const handler = node.arguments.at(-1)!;
        const limits = multipartIn(handler);
        if (limits.length > 1) throw new Error(`Multiple multipart parsers: ${node.arguments[0].text}`);
        if (limits[0]) {
          const key = `${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`;
          if (routes.has(key)) throw new Error(`Ambiguous multipart source route: ${key}`);
          routes.set(key, limits[0]);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  // Fail closed when an upload parser cannot be attributed (for example app.route or a dynamic path).
  for (const file of files) {
    function check(node: ts.Node): void {
      if (ts.isCallExpression(node) && isMultipartCall(node) && !attributedCalls.has(node)) {
        throw new Error(`Unattributed multipart parser: ${file}: ${node.getText()}`);
      }
      ts.forEachChild(node, check);
    }
    check(program.getSourceFile(file)!);
  }
  return routes;
}

function readBusboyDefaults(): Record<string, number | null> {
  const require = createRequire(import.meta.url);
  const multipartRequire = createRequire(require.resolve("@fastify/multipart"));
  const path = multipartRequire.resolve("@fastify/busboy/lib/types/multipart.js");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
  function value(node: ts.Expression): number {
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isIdentifier(node) && node.text === "Infinity") return Infinity;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
      return value(node.left) * value(node.right);
    }
    throw new Error(`Unsupported Busboy default: ${node.getText()}`);
  }
  const limits: Record<string, number | null> = {};
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "getLimit") {
      const name = node.arguments[1];
      if (!name || !ts.isStringLiteral(name) || !node.arguments[2]) throw new Error("Unsupported Busboy default");
      const limit = value(node.arguments[2]);
      limits[name.text] = Number.isFinite(limit) ? limit : null;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!Object.keys(limits).length) throw new Error("Busboy multipart defaults not found");
  return limits;
}

/** Export the effective TS limits for every method/path, including versioned aliases. */
export function exportHttpBodyLimits(
  registrations: RouteOptions[],
  defaults: {
    jsonBodyBytes: number;
    multipart: Limits;
    rateLimitedRoutes: WeakSet<RouteOptions>;
    rateLimit: {
      max: number;
      timeWindow: string;
      allowList: (request: { url: string }) => boolean;
      keyGenerator: (request: { url: string; ip: string }) => string;
    };
  },
  srcDir: string,
) {
  const multipartRoutes = readMultipartRouteLimits(srcDir);
  const seenMultipart = new Set<string>();
  const busboyDefaults = readBusboyDefaults();
  const entries = registrations.flatMap((route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    return methods.map((method) => {
      const path = route.url.replace(/^\/api\/v[12](?=\/)/, "");
      const key = `${method} ${path}`;
      const multipart = multipartRoutes.get(key);
      if (multipart) seenMultipart.add(key);
      const request = { url: route.url.replace(/:[^/]+/g, "1"), ip: "127.0.0.1" };
      const rate = route.config?.rateLimit;
      const rateValues = {
        max: typeof rate === "object" ? rate.max ?? defaults.rateLimit.max : defaults.rateLimit.max,
        timeWindow: typeof rate === "object" ? rate.timeWindow ?? defaults.rateLimit.timeWindow : defaults.rateLimit.timeWindow,
      };
      const enforced = defaults.rateLimitedRoutes.has(route);
      const customKeyGenerator = typeof rate === "object" ? rate.keyGenerator : undefined;
      const customKeys = customKeyGenerator ? {
        source: customKeyGenerator.toString().replace(/\s+/g, " ").trim(),
        examples: [
          { ip: "127.0.0.1", parameter: "1" },
          { ip: "127.0.0.1", parameter: "2" },
          { ip: "127.0.0.2", parameter: "1" },
        ].map(({ ip, parameter }) => {
          const params = Object.fromEntries([...route.url.matchAll(/:([^/]+)/g)].map((match) => [match[1], parameter]));
          const sample = { ...request, ip, params, url: route.url.replace(/:[^/]+/g, parameter) };
          return { ip, params, key: customKeyGenerator(sample as Parameters<typeof customKeyGenerator>[0]) };
        }),
      } : undefined;
      return {
        method, path: route.url.startsWith("/assets/") ? "/assets/*" : route.url,
        jsonBodyBytes: route.bodyLimit ?? defaults.jsonBodyBytes,
        // Unspecified parser limits inherit the app registration and Busboy defaults.
        multipart: multipart ? {
          ...busboyDefaults, ...defaults.multipart, ...multipart,
        } : null,
        rateLimit: !enforced || rate === false || defaults.rateLimit.allowList(request) ? null : {
          ...rateValues,
          ...(customKeys ? { keyGenerator: customKeys } : {}),
          bucket: typeof rate === "object" ? "route" : defaults.rateLimit.keyGenerator(request).replace("127.0.0.1:", ""),
        },
        ...(!enforced && typeof rate === "object" ? { unenforcedRateLimit: rateValues } : {}),
      };
    });
  }).sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`, "en"));
  if ([...multipartRoutes.keys()].some((key) => !seenMultipart.has(key))) {
    throw new Error("Multipart route missing from registered HTTP routes");
  }
  const unique = new Map<string, typeof entries[number]>();
  for (const route of entries) {
    const key = `${route.method} ${route.path}`;
    const previous = unique.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(route)) {
      throw new Error(`Conflicting limits across app profiles: ${key}`);
    }
    unique.set(key, route);
  }
  const routes = [...unique.values()];
  return {
    semantics: {
      routeSurface: "Union of self-host/saas production/static and development/docs registrations",
      staticAssetPaths: "Vite content-hashed bundle filenames are represented by /assets/*; public paths are enumerated",
      aggregateFiles: "Handler-enforced combined file-byte budget and enforcement expression",
      multipartNull: "Route has no multipart parser",
      multipartLimitNull: "Unlimited",
      rateLimitNull: "No enforced rate limit (uninstalled or allow-listed)",
      unenforcedRateLimit: "Declared route config with no installed limiter",
      rateBucket: "app/media share an IP budget; route uses a separate route counter",
    },
    routes,
  };
}
