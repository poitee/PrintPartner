import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
const boundaryPath = join(directory, "status-execution.ts");
const adapterPaths = readdirSync(join(directory, "adapters"))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => join(directory, "adapters", name));

type BodyFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction;
function isBodyFunction(node: ts.Node): node is BodyFunction {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

function violations(extraSource = ""): string[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile;
  host.readFile = (path) => {
    const content = originalRead(path);
    return content !== undefined && path === adapterPaths.find((file) => file.endsWith("/moonraker.ts"))
      ? content + extraSource : content;
  };
  const program = ts.createProgram([boundaryPath, ...adapterPaths], options, host);
  const checker = program.getTypeChecker();
  const boundary = program.getSourceFile(boundaryPath);
  if (!boundary) throw new Error("Missing execution boundary");
  const permitDeclaration = boundary.statements.find((statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === "StatusPermit");
  if (!permitDeclaration || !ts.isTypeAliasDeclaration(permitDeclaration)) throw new Error("Missing permit type");
  const permitType = checker.getTypeAtLocation(permitDeclaration);
  const hasPermit = (fn: ts.SignatureDeclaration) => fn.parameters.some((parameter) =>
    !parameter.questionToken && checker.getTypeAtLocation(parameter) === permitType);
  const functions: BodyFunction[] = [];
  for (const path of adapterPaths) {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`Missing adapter ${path}`);
    const visit = (node: ts.Node) => {
      if (isBodyFunction(node) && node.body) functions.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  function acquires(fn: BodyFunction, visited = new Set<ts.Node>()): boolean {
    if (visited.has(fn) || !fn.body) return false;
    visited.add(fn);
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol && ["safeConnectorFetch", "fetch", "mqttConnect"].includes(symbol.name)) found = true;
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && isBodyFunction(declaration) && acquires(declaration, visited)) found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return found;
  }
  const errors: string[] = [];
  for (const fn of functions) {
    const signature = checker.getSignatureFromDeclaration(fn);
    if (!signature) continue;
    const result = checker.getAwaitedType(signature.getReturnType());
    if (result?.getProperty("state") && acquires(fn) && !hasPermit(fn)) {
      errors.push(`${fn.name?.getText() ?? "anonymous"} acquires status without StatusPermit`);
    }
    const visit = (node: ts.Node) => {
      if (node !== fn.body && isBodyFunction(node)) return;
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && !ts.isJSDocSignature(declaration) && hasPermit(declaration) && !hasPermit(fn)) {
          errors.push(`${fn.name?.getText() ?? "anonymous"} calls a permitted producer without StatusPermit`);
        }
      }
      ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
  }
  return [...new Set(errors)].sort();
}

it("requires the boundary's real permit type along every adapter status acquisition", () => {
  expect(violations()).toEqual([]);
});

it("rejects a new low-level status producer and a forged-permit caller", () => {
  expect(violations(`
async function bypass() {
  const response = await moonrakerFetch("http://127.0.0.1/printer/objects/query", {});
  await response.json();
  return { state: "idle" };
}
async function forged() {
  return queryStatus({}, null!);
}
`)).toEqual([
    "bypass acquires status without StatusPermit",
    "forged acquires status without StatusPermit",
    "forged calls a permitted producer without StatusPermit",
  ]);
});

it("constructs runtime authority only at the application and stdio roots", () => {
  const root = dirname(directory);
  const constructors: string[] = [];
  for (const relative of readdirSync(root, { recursive: true, encoding: "utf8" })) {
    if (!relative.endsWith(".ts") || relative.endsWith(".test.ts")) continue;
    const path = join(root, relative);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const names = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === "StatusExecution") names.add(binding.name.text);
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
        constructors.push(relative);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(constructors.sort()).toEqual(["app.ts", "mcp/stdio-server.ts"]);
});
