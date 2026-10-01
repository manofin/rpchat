/** node --import tsx bench/authConnectionState.test.ts
 * LOCK-AuthConnectionState: network/5xx/403 are not logout; 401 is.
 */
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError, isAuthRejection, isConnectionFailure } from '../apps/web/src/lib/api.ts';
import { ConnectionFailureView } from '../apps/web/src/components/ConnectionFailureView.tsx';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

t('isAuthRejection is HTTP 401 only', () => {
  assert.equal(isAuthRejection(new ApiError(401, 'unauthorized')), true);
  assert.equal(isAuthRejection(new ApiError(403, 'forbidden')), false);
  assert.equal(isAuthRejection(new ApiError(502, 'bad gateway')), false);
  assert.equal(isAuthRejection(new TypeError('Failed to fetch')), false);
  assert.equal(isAuthRejection(new Error('timeout')), false);
});

t('isConnectionFailure is network or non-401, not 401', () => {
  assert.equal(isConnectionFailure(new TypeError('Failed to fetch')), true);
  assert.equal(isConnectionFailure(new ApiError(502, 'bad gateway')), true);
  assert.equal(isConnectionFailure(new ApiError(403, 'forbidden')), true);
  assert.equal(isConnectionFailure(new ApiError(500, 'server')), true);
  assert.equal(isConnectionFailure(new Error('timeout')), true);
  assert.equal(isConnectionFailure(new ApiError(401, 'unauthorized')), false);
});

t('ConnectionFailureView shows retry copy and no token field', () => {
  const html = renderToStaticMarkup(createElement(ConnectionFailureView, { onRetry() {} }));
  assert.match(html, /서버에 연결할 수 없습니다/);
  assert.match(html, /다시 시도/);
  assert.equal(html.includes('APP_TOKEN'), false);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, /<input/);
});

console.log(`passed ${passed}`);
