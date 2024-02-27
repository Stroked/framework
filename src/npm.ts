import {existsSync} from "node:fs";
import {mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {Parser} from "acorn";
import {simple} from "acorn-walk";
import {rsort, satisfies} from "semver";
import {isEnoent} from "./error.js";
import type {ExportNode, ImportNode, ImportReference} from "./javascript/imports.js";
import {findImports} from "./javascript/imports.js";
import {getStringLiteralValue, isStringLiteral} from "./javascript/node.js";
import {parseOptions} from "./javascript/parse.js";
import {relativePath} from "./path.js";
import {Sourcemap} from "./sourcemap.js";
import {faint} from "./tty.js";

export interface NpmSpecifier {
  name: string;
  range?: string;
  path?: string;
}

export function parseNpmSpecifier(specifier: string): NpmSpecifier {
  const parts = specifier.split("/");
  const namerange = specifier.startsWith("@") ? [parts.shift()!, parts.shift()!].join("/") : parts.shift()!;
  const ranged = namerange.indexOf("@", 1);
  return {
    name: ranged > 0 ? namerange.slice(0, ranged) : namerange,
    range: ranged > 0 ? namerange.slice(ranged + 1) : undefined,
    path: parts.length > 0 ? parts.join("/") : undefined
  };
}

export function formatNpmSpecifier({name, range, path}: NpmSpecifier): string {
  return `${name}${range ? `@${range}` : ""}${path ? `/${path}` : ""}`;
}

/** Rewrites /npm/ import specifiers to be relative paths to /_npm/. */
export function rewriteNpmImports(input: string, path: string): string {
  const body = Parser.parse(input, parseOptions);
  const output = new Sourcemap(input);

  simple(body, {
    ImportDeclaration: rewriteImport,
    ImportExpression: rewriteImport,
    ExportAllDeclaration: rewriteImport,
    ExportNamedDeclaration: rewriteImport
  });

  function rewriteImport(node: ImportNode | ExportNode) {
    if (node.source && isStringLiteral(node.source)) {
      let value = getStringLiteralValue(node.source);
      if (value.startsWith("/npm/")) {
        value = `/_npm/${value.slice("/npm/".length)}`;
        if (value.endsWith("/+esm")) value += ".js";
        value = relativePath(path, value);
        output.replaceLeft(node.source.start, node.source.end, JSON.stringify(value));
      }
    }
  }

  // TODO Preserve the source map, but download it too.
  return String(output).replace(/^\/\/# sourceMappingURL=.*$\n?/m, "");
}

const npmRequests = new Map<string, Promise<string>>();

/** Note: path must start with "/_npm/". */
export async function populateNpmCache(root: string, path: string): Promise<string> {
  if (!path.startsWith("/_npm/")) throw new Error(`invalid npm path: ${path}`);
  const filePath = join(root, ".observablehq", "cache", path);
  if (existsSync(filePath)) return filePath;
  let promise = npmRequests.get(path);
  if (promise) return promise; // coalesce concurrent requests
  promise = (async function () {
    const specifier = path.slice("/_npm/".length).replace(/\/\+esm\.js$/, "/+esm");
    const href = `https://cdn.jsdelivr.net/npm/${specifier}`;
    process.stdout.write(`npm:${specifier} ${faint("→")} `);
    const response = await fetch(href);
    if (!response.ok) throw new Error(`unable to fetch: ${href}`);
    process.stdout.write(`${filePath}\n`);
    await mkdir(dirname(filePath), {recursive: true});
    if (/^application\/javascript(;|$)/i.test(response.headers.get("content-type")!)) {
      await writeFile(filePath, rewriteNpmImports(await response.text(), path), "utf-8");
    } else {
      await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
    }
    return filePath;
  })();
  promise.catch(() => {}).then(() => npmRequests.delete(path));
  npmRequests.set(path, promise);
  return promise;
}

let npmVersionCache: Promise<Map<string, string[]>>;

async function initializeNpmVersionCache(root: string): typeof npmVersionCache {
  const cache = new Map<string, string[]>();
  const cacheDir = join(root, ".observablehq", "cache", "_npm");
  try {
    for (const entry of await readdir(cacheDir)) {
      if (entry.startsWith("@")) {
        for (const subentry of await readdir(join(cacheDir, entry))) {
          const {name, range} = parseNpmSpecifier(`${entry}/${subentry}`);
          const versions = cache.get(name);
          if (versions) versions.push(range!);
          else cache.set(name, [range!]);
        }
      } else {
        const {name, range} = parseNpmSpecifier(entry);
        const versions = cache.get(name);
        if (versions) versions.push(range!);
        else cache.set(name, [range!]);
      }
    }
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  for (const [key, value] of cache) {
    cache.set(key, rsort(value));
  }
  return cache;
}

async function resolveNpmVersion(root: string, specifier: NpmSpecifier): Promise<string> {
  const {name, range} = specifier;
  if (range && /^\d+\.\d+\.\d+([-+].*)?$/.test(range)) return range; // exact version specified
  const cache = await (npmVersionCache ??= initializeNpmVersionCache(root));
  const versions = cache.get(specifier.name);
  if (versions) for (const version of versions) if (!range || satisfies(version, range)) return version;
  const search = range ? `?specifier=${range}` : "";
  const href = `https://data.jsdelivr.com/v1/packages/npm/${name}/resolved${search}`;
  const response = await fetch(href);
  if (!response.ok) throw new Error(`unable to fetch: ${href}`);
  const {version} = await response.json();
  if (!version) throw new Error(`unable to resolve version: ${formatNpmSpecifier({name, range})}`);
  cache.set(specifier.name, versions ? rsort(versions.concat(version)) : [version]);
  return version;
}

export async function resolveNpmImport(root: string, specifier: string): Promise<string> {
  let {name, range, path = "+esm"} = parseNpmSpecifier(specifier); // eslint-disable-line prefer-const
  if (name === "@duckdb/duckdb-wasm" && !range) range = "1.28.0"; // https://github.com/duckdb/duckdb-wasm/issues/1561
  if (name === "apache-arrow" && !range) range = "13.0.0"; // https://github.com/observablehq/framework/issues/750
  if (name === "parquet-wasm" && !range) range = "0.5.0"; // https://github.com/observablehq/framework/issues/733
  if (name === "echarts" && !range) range = "5.4.3"; // https://github.com/observablehq/framework/pull/811
  // try {
  return `/_npm/${name}@${await resolveNpmVersion(root, {name, range})}/${path.replace(/\+esm$/, "+esm.js")}`; // TODO use / instead of @
  // } catch {
  //   return `https://cdn.jsdelivr.net/npm/${name}${range ? `@${range}` : ""}/${path}`;
  // }
}

const npmImportsCache = new Map<string, Promise<ImportReference[]>>();

/**
 * Resolves the direct dependencies of the specified npm path, such as
 * "/_npm/d3@7.8.5/+esm.js", returning the corresponding set of npm paths.
 */
export async function resolveNpmImports(root: string, path: string): Promise<ImportReference[]> {
  if (!path.startsWith("/_npm/")) throw new Error(`invalid npm path: ${path}`);
  let promise = npmImportsCache.get(path);
  if (promise) return promise;
  promise = (async function () {
    try {
      const filePath = await populateNpmCache(root, path);
      const source = await readFile(filePath, "utf-8");
      const body = Parser.parse(source, parseOptions);
      return findImports(body, path, source);
    } catch (error) {
      console.warn(`unable to fetch or parse: ${path}`);
      return [];
    }
  })();
  npmImportsCache.set(path, promise);
  return promise;
}
