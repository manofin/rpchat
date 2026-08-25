/**
 * F3 avatar inspect (helper only). PASS here is not live upload.
 *   npx tsx bench/avatarUpload.test.ts
 */
import assert from 'node:assert/strict';
import {
  AVATAR_MAX_BYTES,
  inspectAvatar,
  sniffAvatar,
  AvatarReject,
  publicAvatarPath,
} from '../apps/server/src/media/avatar.ts';

let passed = 0;
function t(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const webp = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x08, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
]);
const gif = Buffer.from('GIF89a', 'ascii');

t('A sniff jpeg/png/webp', () => {
  assert.equal(sniffAvatar(jpeg), 'jpeg');
  assert.equal(sniffAvatar(png), 'png');
  assert.equal(sniffAvatar(webp), 'webp');
});

t('B gif/empty/short → null', () => {
  assert.equal(sniffAvatar(gif), null);
  assert.equal(sniffAvatar(Buffer.alloc(0)), null);
  assert.equal(sniffAvatar(Buffer.from([0xff])), null);
});

t('C inspect ok', () => {
  assert.equal(inspectAvatar(jpeg), 'jpeg');
  assert.equal(inspectAvatar(png), 'png');
  assert.equal(inspectAvatar(webp), 'webp');
});

t('D empty → 400', () => {
  try {
    inspectAvatar(Buffer.alloc(0));
    assert.fail('expected reject');
  } catch (e) {
    assert.ok(e instanceof AvatarReject);
    assert.equal(e.status, 400);
  }
});

t('E oversize → 413', () => {
  const big = Buffer.alloc(AVATAR_MAX_BYTES + 1, 0xff);
  big[0] = 0xff;
  big[1] = 0xd8;
  big[2] = 0xff;
  try {
    inspectAvatar(big);
    assert.fail('expected reject');
  } catch (e) {
    assert.ok(e instanceof AvatarReject);
    assert.equal(e.status, 413);
  }
});

t('F gif → 415', () => {
  try {
    inspectAvatar(gif);
    assert.fail('expected reject');
  } catch (e) {
    assert.ok(e instanceof AvatarReject);
    assert.equal(e.status, 415);
  }
});

t('G public path', () => {
  assert.equal(publicAvatarPath('abc', 'jpeg'), '/media/avatars/abc.jpg');
  assert.equal(publicAvatarPath('abc', 'png'), '/media/avatars/abc.png');
  assert.equal(publicAvatarPath('abc', 'webp'), '/media/avatars/abc.webp');
});

t('H exactly max bytes jpeg still ok', () => {
  const exact = Buffer.alloc(AVATAR_MAX_BYTES, 0);
  exact[0] = 0xff;
  exact[1] = 0xd8;
  exact[2] = 0xff;
  assert.equal(inspectAvatar(exact), 'jpeg');
});

console.log(`PASS ${passed}/8 avatarUpload.test.ts`);
