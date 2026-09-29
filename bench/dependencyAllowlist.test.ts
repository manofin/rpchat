/**
 * npx tsx bench/dependencyAllowlist.test.ts
 * (or: npm run test:benches -- dependencyAllowlist)
 *
 * dependency-allowlist — two contracts, checked with the TypeScript AST (not regex):
 *   1. Every workspace manifest declares exactly the approved package names per section.
 *      Version ranges are free; names are the contract.
 *   2. Product source (apps/server/src, apps/web/src) imports only what its own workspace
 *      declares, never reaches into another workspace by relative path, and the web never
 *      imports Node builtins. Server value imports must be runtime `dependencies`
 *      (dist runs without devDependencies); type-only imports may use devDependencies.
 *
 * Adding or removing a package is a contract change: update ALLOWED in the same approved
 * slice, so the change shows up in review as a diff of this file.
 * Reads package.json files and source only. No DB, network, model, build, or live service.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

type Section = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
const SECTIONS: Section[] = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
type Manifest = Partial<Record<Section, Record<string, string>>>;
type Allowed = Partial<Record<Section, string[]>>;

const ALLOWED: Record<string, Allowed> = {
  '.': {},
  'apps/server': {
    dependencies: ['@fastify/cookie', '@fastify/static', '@rpchat/contracts', 'better-sqlite3', 'fastify', 'zod'],
    devDependencies: [
      '@types/better-sqlite3',
      '@types/node',
      '@xenova/transformers',
      'onnxruntime-node',
      'tsx',
      'typescript',
    ],
  },
  'apps/web': {
    dependencies: ['@rpchat/contracts', 'react', 'react-dom'],
    devDependencies: ['@types/react', '@types/react-dom', '@vitejs/plugin-react', 'typescript', 'vite', 'vite-plugin-pwa'],
  },
  'packages/contracts': {},
};

/** Bundler virtual modules and the devDependency that provides each one. */
const VIRTUAL_PROVIDERS: Record<string, string> = { 'virtual:pwa-register': 'vite-plugin-pwa' };

type SourceRule = { workspace: string; srcDir: string; nodeBuiltins: boolean };
const SOURCE_RULES: SourceRule[] = [
  { workspace: 'apps/server', srcDir: 'apps/server/src', nodeBuiltins: true },
  { workspace: 'apps/web', srcDir: 'apps/web/src', nodeBuiltins: false },
];

function checkManifest(manifest: Manifest, allowed: Allowed): string[] {
  const problems: string[] = [];
  for (const section of SECTIONS) {
    const have = Object.keys(manifest[section] ?? {}).sort();
    const want = [...(allowed[section] ?? [])].sort();
    for (const name of have) if (!want.includes(name)) problems.push(`${section}: unapproved ${name}`);
    for (const name of want) if (!have.includes(name)) problems.push(`${section}: approved but missing ${name}`);
  }
  return problems;
}

type ImportRef = { spec: string; typeOnly: boolean; line: number };

function collectImports(fileName: string, text: string): ImportRef[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const out: ImportRef[] = [];
  const add = (lit: ts.Node, typeOnly: boolean) => {
    if (!ts.isStringLiteralLike(lit)) return;
    out.push({ spec: lit.text, typeOnly, line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1 });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      let typeOnly = false;
      if (clause) {
        const named = clause.namedBindings;
        typeOnly =
          clause.isTypeOnly ||
          (!clause.name &&
            !!named &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every((e) => e.isTypeOnly));
      }
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg)) add(arg.literal, true);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isDynamicImport || isRequire) add(node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const BUILTINS = new Set(builtinModules);
function isBuiltin(spec: string): boolean {
  return spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0]);
}

function checkSourceFile(opts: {
  file: string;
  text: string;
  workspaceDir: string;
  manifest: Manifest;
  nodeBuiltins: boolean;
}): string[] {
  const { file, text, workspaceDir, manifest, nodeBuiltins } = opts;
  const deps = new Set(Object.keys(manifest.dependencies ?? {}));
  const devDeps = new Set(Object.keys(manifest.devDependencies ?? {}));
  const problems: string[] = [];
  for (const ref of collectImports(file, text)) {
    const at = `${file}:${ref.line} '${ref.spec}'`;
    if (ref.spec.startsWith('.') || ref.spec.startsWith('/')) {
      const target = path.resolve(path.dirname(file), ref.spec);
      const rel = path.relative(workspaceDir, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) problems.push(`${at}: relative import leaves its workspace`);
      continue;
    }
    if (ref.spec.startsWith('virtual:')) {
      const provider = VIRTUAL_PROVIDERS[ref.spec];
      if (!provider) problems.push(`${at}: unknown virtual module`);
      else if (!deps.has(provider) && !devDeps.has(provider)) problems.push(`${at}: provider ${provider} not declared`);
      continue;
    }
    if (isBuiltin(ref.spec)) {
      if (!nodeBuiltins) problems.push(`${at}: Node builtin in a browser workspace`);
      continue;
    }
    const pkg = packageName(ref.spec);
    if (deps.has(pkg)) continue;
    if (devDeps.has(pkg)) {
      if (!ref.typeOnly) problems.push(`${at}: value import of devDependency ${pkg}`);
      continue;
    }
    problems.push(`${at}: ${pkg} not declared in ${path.basename(workspaceDir)}/package.json`);
  }
  return problems;
}

function readManifest(workspace: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(appRoot, workspace, 'package.json'), 'utf8')) as Manifest;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(c|m)?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

function workspacesFromRoot(): string[] {
  const root = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { workspaces?: string[] };
  return ['.', ...(root.workspaces ?? [])].sort();
}

// ── Real tree ────────────────────────────────────────────────────────────────

t('every root workspace has an ALLOWED entry and vice versa', () => {
  assert.deepEqual(workspacesFromRoot(), Object.keys(ALLOWED).sort());
});

t('workspace manifests declare exactly the approved package names', () => {
  const problems = Object.entries(ALLOWED).flatMap(([ws, allowed]) =>
    checkManifest(readManifest(ws), allowed).map((p) => `${ws}/package.json ${p}`),
  );
  assert.deepEqual(problems, []);
});

let scannedFiles = 0;
let scannedPackageImports = 0;
t('product source imports only its own declared packages and stays in its workspace', () => {
  const problems: string[] = [];
  for (const rule of SOURCE_RULES) {
    const manifest = readManifest(rule.workspace);
    for (const file of sourceFiles(path.join(appRoot, rule.srcDir))) {
      const text = fs.readFileSync(file, 'utf8');
      scannedFiles++;
      scannedPackageImports += collectImports(file, text).filter((r) => !r.spec.startsWith('.')).length;
      problems.push(
        ...checkSourceFile({
          file: path.relative(appRoot, file),
          text,
          workspaceDir: rule.workspace,
          manifest,
          nodeBuiltins: rule.nodeBuiltins,
        }),
      );
    }
  }
  assert.deepEqual(problems, []);
});

t('scanner actually saw the tree (a tool failure is not zero findings)', () => {
  assert.ok(scannedFiles >= 100, `scanned only ${scannedFiles} files`);
  assert.ok(scannedPackageImports >= 50, `saw only ${scannedPackageImports} package imports`);
});

// ── Negative controls: each must be caught ───────────────────────────────────

const serverManifest: Manifest = {
  dependencies: { fastify: '^5', zod: '^3' },
  devDependencies: { typescript: '^5', '@types/node': '^22' },
};
const webManifest: Manifest = {
  dependencies: { react: '^19' },
  devDependencies: { 'vite-plugin-pwa': '^1' },
};
const server = (text: string) =>
  checkSourceFile({ file: 'apps/server/src/x.ts', text, workspaceDir: 'apps/server', manifest: serverManifest, nodeBuiltins: true });
const web = (text: string) =>
  checkSourceFile({ file: 'apps/web/src/pages/x.tsx', text, workspaceDir: 'apps/web', manifest: webManifest, nodeBuiltins: false });

t('control: an added or removed manifest package is reported', () => {
  const allowed: Allowed = { dependencies: ['fastify', 'zod'], devDependencies: ['@types/node', 'typescript'] };
  assert.deepEqual(checkManifest(serverManifest, allowed), []);
  assert.deepEqual(checkManifest({ ...serverManifest, dependencies: { ...serverManifest.dependencies, lodash: '^4' } }, allowed), [
    'dependencies: unapproved lodash',
  ]);
  assert.deepEqual(checkManifest({ ...serverManifest, peerDependencies: { react: '^19' } }, allowed), [
    'peerDependencies: unapproved react',
  ]);
  assert.deepEqual(checkManifest({ dependencies: { fastify: '^5' }, devDependencies: serverManifest.devDependencies }, allowed), [
    'dependencies: approved but missing zod',
  ]);
});

t('control: undeclared (hoisted phantom) package import is reported', () => {
  assert.equal(server(`import { z } from 'zod';`).length, 0);
  assert.match(server(`import React from 'react';`)[0], /react not declared/);
  assert.match(web(`import { z } from 'zod/v4';`)[0], /zod not declared/);
  assert.match(server(`const m = await import('lodash-es');`)[0], /lodash-es not declared/);
  assert.match(server(`const m = require('@scope/pkg/deep');`)[0], /@scope\/pkg not declared/);
  assert.match(server(`export { x } from 'left-pad';`)[0], /left-pad not declared/);
});

t('control: server value import of a devDependency is reported, type-only is allowed', () => {
  assert.equal(server(`import type { Node } from 'typescript';`).length, 0);
  assert.equal(server(`import { type Node } from 'typescript';`).length, 0);
  assert.equal(server(`type N = import('typescript').Node;`).length, 0);
  assert.match(server(`import ts from 'typescript';`)[0], /value import of devDependency typescript/);
  assert.match(server(`import { type Node, sys } from 'typescript';`)[0], /value import of devDependency/);
});

t('control: web may not import Node builtins, server may', () => {
  assert.equal(server(`import fs from 'node:fs'; import path from 'path';`).length, 0);
  assert.match(web(`import fs from 'node:fs';`)[0], /Node builtin in a browser workspace/);
  assert.match(web(`import { join } from 'path';`)[0], /Node builtin/);
});

t('control: relative import into another workspace is reported', () => {
  assert.equal(web(`import { a } from '../lib/a';`).length, 0);
  assert.match(web(`import { chat } from '../../../server/src/routes/chat';`)[0], /leaves its workspace/);
  assert.match(server(`import { x } from '../../web/src/lib/api';`)[0], /leaves its workspace/);
});

t('control: virtual modules need a known, declared provider', () => {
  assert.equal(web(`import { registerSW } from 'virtual:pwa-register';`).length, 0);
  assert.match(web(`import x from 'virtual:unknown';`)[0], /unknown virtual module/);
  const noProvider = checkSourceFile({
    file: 'apps/web/src/x.ts',
    text: `import { registerSW } from 'virtual:pwa-register';`,
    workspaceDir: 'apps/web',
    manifest: { dependencies: { react: '^19' } },
    nodeBuiltins: false,
  });
  assert.match(noProvider[0], /provider vite-plugin-pwa not declared/);
});

t('control: import-looking text in strings and comments is not an import', () => {
  const text = [
    `// import x from 'lodash';`,
    `const msg = "from 'traversal blocked'";`,
    'const tpl = `import y from "left-pad"`;',
  ].join('\n');
  assert.deepEqual(collectImports('apps/server/src/x.ts', text), []);
});

console.log(`passed ${passed}`);
