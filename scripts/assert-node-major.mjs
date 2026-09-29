#!/usr/bin/env node
/**
 * Fail fast if Node major < 22 (matches package.json engines.node).
 * Optional env RPCHAT_ASSERT_NODE_VERSION (e.g. 20.11.0) overrides process.versions.node
 * for fence self-check only; unset in normal use.
 */
const raw = process.env.RPCHAT_ASSERT_NODE_VERSION || process.versions.node;
const major = Number.parseInt(String(raw).split(".")[0], 10);
if (!Number.isFinite(major) || major < 22) {
  console.error(
    `rpchat requires Node.js >= 22 (engines.node); got v${raw}`,
  );
  process.exit(1);
}
process.exit(0);
