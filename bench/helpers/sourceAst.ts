import fs from 'node:fs';
import ts from 'typescript';

export function parseSourceAst(source: string, fileName = 'fixture.tsx'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

export function readSourceAst(fileName: string): ts.SourceFile {
  return parseSourceAst(fs.readFileSync(fileName, 'utf8'), fileName);
}

export function astNodes<T extends ts.Node>(root: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(node: ts.Node) {
    if (matches(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return result;
}

export function callsNamed(root: ts.Node, name: string, argumentCount: number): ts.CallExpression[] {
  return astNodes(root, ts.isCallExpression).filter((call) => ts.isIdentifier(call.expression)
    && call.expression.text === name && call.arguments.length === argumentCount);
}

export function rawConditionsPassThroughs(root: ts.Node): ts.PropertyAssignment[] {
  return astNodes(root, ts.isPropertyAssignment).filter((property) =>
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'conditions'
    && ts.isPropertyAccessExpression(property.initializer) && ts.isIdentifier(property.initializer.expression)
    && property.initializer.expression.text === 'e' && property.initializer.name.text === 'conditions');
}
