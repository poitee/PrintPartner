import { globSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import type { RouteOptions } from "fastify";

type Limits = Record<string, number>;

/** Test-only source reader: multipart overrides are inside handlers, not Fastify route options. */
export function readMultipartRouteLimits(srcDir: string): Map<string, Limits> {
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
  function multipartIn(handler: ts.Node, visited = new Set<ts.Node>()): Limits[] {
    if (visited.has(handler)) return [];
    visited.add(handler);
    const found: Limits[] = [];
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) && callee.expression.text === "request" &&
            ["file", "files", "parts"].includes(callee.name.text)) {
          const limits: Limits = {};
          if (node.arguments[0]) {
            const options = object(node.arguments[0]);
            const property = options.properties.find((p) => p.name?.getText() === "limits");
            if (property && ts.isPropertyAssignment(property)) {
              for (const entry of object(property.initializer).properties) {
                if (!ts.isPropertyAssignment(entry)) throw new Error("Unsupported multipart limit property");
                limits[entry.name.getText()] = number(entry.initializer);
              }
            }
          }
          found.push(limits);
        } else if (ts.isIdentifier(callee) && node.arguments.some(
          (arg) => ts.isIdentifier(arg) && arg.text === "request",
        )) {
          const decl = declaration(callee);
          if (decl && ts.isFunctionDeclaration(decl) && decl.body &&
              decl.getSourceFile().fileName.startsWith(srcDir)) {
            found.push(...multipartIn(decl.body, visited));
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(handler);
    return found;
  }
  const routes = new Map<string, Limits>();
  for (const file of files) {
    const source = program.getSourceFile(file)!;
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ["get", "post", "put", "patch", "delete", "head", "options"].includes(node.expression.name.text) &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const handler = node.arguments.at(-1)!;
        const limits = multipartIn(handler);
        if (limits.length > 1) throw new Error(`Multiple multipart parsers: ${node.arguments[0].text}`);
        if (limits[0]) routes.set(`${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`, limits[0]);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return routes;
}

/** Export the effective TS limits for every method/path, including versioned aliases. */
export function exportHttpBodyLimits(
  registrations: RouteOptions[],
  defaults: {
    jsonBodyBytes: number;
    multipart: Limits;
    rateLimit: {
      max: number;
      timeWindow: string;
      allowList: (request: { url: string }) => boolean;
    };
  },
  srcDir: string,
) {
  const multipartRoutes = readMultipartRouteLimits(srcDir);
  const seenMultipart = new Set<string>();
  const entries = registrations.flatMap((route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    return methods.map((method) => {
      const path = route.url.replace(/^\/api\/v[12](?=\/)/, "");
      const key = `${method} ${path}`;
      const multipart = multipartRoutes.get(key);
      if (multipart) seenMultipart.add(key);
      const request = { url: route.url, ip: "127.0.0.1" };
      const rate = route.config?.rateLimit;
      return {
        method, path: route.url,
        jsonBodyBytes: route.bodyLimit ?? defaults.jsonBodyBytes,
        // Unspecified parser limits inherit the app registration and Busboy defaults.
        multipart: multipart ? {
          fieldSize: 1024 * 1024, fields: null,
          headerPairs: 2000, ...defaults.multipart, ...multipart,
        } : null,
        rateLimit: rate === false || defaults.rateLimit.allowList(request) ? null : {
          max: defaults.rateLimit.max, timeWindow: defaults.rateLimit.timeWindow,
          ...(typeof rate === "object" ? {
            max: rate.max ?? defaults.rateLimit.max,
            timeWindow: rate.timeWindow ?? defaults.rateLimit.timeWindow,
          } : {}),
        },
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
  return { routes };
}
