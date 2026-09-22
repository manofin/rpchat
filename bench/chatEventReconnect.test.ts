import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the production reload and polling callbacks with deterministic latency.
// A real 900ms GET overlapping a 700ms interval used to discard every response.
const source = ts.createSourceFile('useChat.ts', readFileSync('apps/web/src/pages/useChat.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let reloadSource = '';
let pollingSource = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'reload' && node.initializer && ts.isCallExpression(node.initializer)) {
    reloadSource = node.initializer.arguments[0].getText(source);
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
    const callback = node.arguments[0]?.getText(source) ?? '';
    if (callback.includes('streamConnected') && callback.includes('reload')) pollingSource = callback;
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(reloadSource && pollingSource, 'production reload and reconnect polling callbacks must be executable');

function compile(sourceText: string, context: Record<string, unknown>): (...args: unknown[]) => unknown {
  const compiled = ts.transpileModule(`exports.callback = ${sourceText}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported: { callback?: (...args: unknown[]) => unknown } = {};
  new Function(...Object.keys(context), 'exports', compiled)(...Object.values(context), exported);
  return exported.callback!;
}

class Clock {
  now = 0;
  nextId = 0;
  tasks = new Map<number, { at: number; callback: () => void; interval?: number }>();
  setTimeout = (callback: () => void, delay = 0) => this.schedule(callback, delay);
  clearTimeout = (id: number) => { this.tasks.delete(id); };
  setInterval = (callback: () => void, delay = 0) => this.schedule(callback, delay, delay);
  clearInterval = this.clearTimeout;
  private schedule(callback: () => void, delay: number, interval?: number) {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.now + delay, callback, interval });
    return id;
  }
  async advance(until: number) {
    for (;;) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      this.now = next[1].at;
      if (next[1].interval !== undefined) next[1].at += next[1].interval;
      else this.tasks.delete(next[0]);
      next[1].callback();
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    this.now = until;
  }
}

function harness(failFirst = false) {
  const clock = new Clock();
  const scope = { conversationId: 'room', revision: 0, reloadSequence: 0 };
  const scopeRef: { current: typeof scope | null } = { current: scope };
  let state: Record<string, unknown> = { generating: true, loading: false, error: null };
  let requests = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let applied = 0;
  const get = () => new Promise((resolve, reject) => {
    const number = ++requests;
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    clock.setTimeout(() => {
      inFlight--;
      if (failFirst && number === 1) reject(new Error('temporary reconnect failure'));
      else resolve({ conversation: { id: 'room' }, messages: [], activeGeneration: null });
    }, 900);
  });
  const reload = compile(reloadSource, {
    get, scope, scopeRef, conversationId: 'room', genIdRef: { current: 'generation' }, abortRef: { current: null },
    setState: (update: (value: Record<string, unknown>) => Record<string, unknown>) => { state = update(state); applied++; },
    patchState: (patch: Record<string, unknown>) => { if (scopeRef.current === scope) state = { ...state, ...patch }; },
  });
  const effect = compile(pollingSource, {
    state, streamConnected: false, reload, scope, scopeRef,
    window: clock, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const cleanup = effect() as (() => void) | undefined;
  return { clock, scopeRef, cleanup, result: () => ({ state, requests, maxInFlight, applied }) };
}

async function main() {
  const slow = harness();
  await slow.clock.advance(5000);
  slow.cleanup?.();
  assert.ok(slow.result().applied > 0, 'slow polling GETs must apply a completed response instead of starving behind newer requests');
  assert.equal(slow.result().state.generating, false, 'a finished generation must become available after reconnect');
  assert.equal(slow.result().maxInFlight, 1, 'reconnect polling must wait for its current GET before starting another');
  console.log('ok 1 900ms reconnect responses settle generation despite a 700ms polling cadence');

  const retry = harness(true);
  await retry.clock.advance(5000);
  retry.cleanup?.();
  assert.ok(retry.result().applied > 0, 'one failed reconnect GET must not stop future polling');
  assert.equal(retry.result().state.generating, false);
  console.log('ok 2 a failed reconnect GET allows the next successful response to settle');

  const changedRoom = harness();
  await changedRoom.clock.advance(750);
  changedRoom.scopeRef.current = { conversationId: 'other', revision: 0, reloadSequence: 0 };
  changedRoom.cleanup?.();
  await changedRoom.clock.advance(5000);
  assert.equal(changedRoom.result().applied, 0, 'a pending old-room GET cannot update the next room');
  assert.equal(changedRoom.result().requests, 1, 'cleanup must stop later reconnect requests');
  console.log('ok 3 room change cancels polling and rejects the old pending response');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
