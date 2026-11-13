import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
assert(!manifest.permissions.includes('messagesDelete'));
let began = 0;
let updated;
let attached = 0;
const original = { type: 'reply', relatedMessageId: 42, isPlainText: true,
  plainTextBody: '> Original message\n> Keep this exactly', to: ['original@example.org'] };
const context = vm.createContext({
  console, TB_ACCESS_CONFIG: {},
  WebSocket: class { constructor() { this.readyState = 0; } },
  setTimeout() {}, clearTimeout() {}, atob, Uint8Array, File,
  messenger: {
    compose: {
      async beginReply(id, type, details) {
        assert.equal(id, 42); assert.equal(type, 'replyToSender');
        assert.equal(details.plainTextBody, undefined); assert.equal(details.body, undefined);
        began++; return { id: 7 };
      },
      async getComposeDetails() { return { ...original, ...updated }; },
      async setComposeDetails(id, update) { assert.equal(id, 7); updated = update; },
      async addAttachment(id, attachment) {
        assert.equal(id, 7); assert.equal(await attachment.file.text(), 'attachment'); attached++;
      },
      async sendMessage() { assert.fail('Never send'); },
    },
  },
});
let insertedHtml, insertedText;
const nativeImage = { src: 'imap://original-logo', complete: true, naturalWidth: 87, naturalHeight: 89, getAttribute(name) { return this[name]; } };
const editor = {
  body: { focus() {} }, images: [nativeImage],
  createRange: () => ({ selectNodeContents(body) { assert.equal(body, editor.body); },
    collapse(start) { assert.equal(start, true); } }),
  execCommand(command, ui, html) {
    assert.equal(ui, false);
    if (command === 'insertHTML') insertedHtml = html;
    else { assert.equal(command, 'insertText'); insertedText = html; }
    return true;
  },
};
context.messenger.tabs = { async executeScript(id, { code }) {
  assert.equal(id, 7);
  return [vm.runInNewContext(code, { document: editor,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) } })];
} };
for (const file of ['access-control.js', 'background.js']) vm.runInContext(readFileSync(new URL('../extension/src/' + file, import.meta.url), 'utf8'), context);
const request = vm.runInContext('handleRequest', context);
const reply = { messageId: 42, body: 'Test reply', open: true, to: ['test@example.org'],
  attachments: [{ name: 'test.txt', data: btoa('attachment') }] };
const result = await request({ method: 'POST', path: '/reply', body: reply });
assert.equal(result.tabId, 7);
assert.equal(insertedText, 'Test reply\n\n');
assert.equal(updated.plainTextBody, undefined);
assert.equal(updated.to[0], 'test@example.org');
assert.equal(updated.cc.length + updated.bcc.length, 0);
assert.equal(attached, 1);
for (const path of ['/reply', '/compose', '/forward', '/messages/delete', '/tags/create']) {
  await assert.rejects(request({ method: 'POST', path, body: { ...reply, send: true } }), /FORBIDDEN/);
}
await assert.rejects(request({ method: 'POST', path: '/messages/delete', body: {} }), /FORBIDDEN/);
await assert.rejects(request({ method: 'POST', path: '/reply', body: { ...reply, messageId: -1 } }), /INVALID_ARGS/);
await assert.rejects(request({ method: 'POST', path: '/reply', body: { ...reply,
  attachments: [{ name: '../bad', data: '' }] } }), /INVALID_ARGS/);
await assert.rejects(request({ method: 'POST', path: '/reply', body: { ...reply, to: ['invalid'] } }), /INVALID_ARGS/);
await assert.rejects(request({ method: 'POST', path: '/reply', body: { ...reply, attachments: [null] } }), /INVALID_ARGS/);
assert.equal(began, 1, 'Rejected requests must not open a composer');
console.log('PASS: native reply, original quote, safe recipient override, attachment, send/mutation rejection');

const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
context.DOMParser = class {
  parseFromString(html) {
    assert.equal(html, '', 'Never parse and replace the native quotation');
    const node = tag => ({ children: [], style: {}, textContent: '',
      append(child) { this.children.push(child); },
      setAttribute(name, value) { assert.equal(name, 'style'); this.style.value = value; },
      get outerHTML() {
        const content = this.innerHTML ?? (this.children.length
          ? this.children.map(p => p.outerHTML).join('') : escape(this.textContent));
        return '<' + tag + '>' + content + '</' + tag + '>';
      },
    });
    return { createElement: node };
  }
};
original.isPlainText = false;
original.body = '<blockquote>Original &amp; unchanged</blockquote>';
updated = undefined;
await request({ method: 'POST', path: '/reply', body: { messageId: 42, body: '<Not HTML>\n\nSecond paragraph', open: true } });
assert.equal(updated, undefined, 'HTML replies must not replace the native body');
assert.equal(insertedHtml, '<div><p>&lt;Not HTML&gt;</p><p>Second paragraph</p></div>');
assert.equal(editor.images[0], nativeImage);
assert.equal(editor.images[0].naturalWidth, 87);
insertedHtml = undefined;
await request({ method: 'POST', path: '/reply', body: { messageId: 42, body: '', open: true } });
assert.equal(insertedHtml, undefined, 'Empty replies must leave the editor untouched');
await request({ method: 'POST', path: '/reply', body: { messageId: 42, body: 'Best regards,\nReinhard', open: true } });
assert.equal(insertedHtml, '<div><p>Best regards,\nReinhard</p></div>');
await request({ method: 'POST', path: '/reply', body: { messageId: 42, body: '<b>HTML</b>', isHTML: true, open: true } });
assert.equal(insertedHtml, '<div><b>HTML</b></div>');
let newDetails;
context.messenger.compose.beginNew = async (_id, details) => { newDetails = details; return { id: 8 }; };
await request({ method: 'POST', path: '/compose', body: { to: 'test@example.invalid', body: '<p>Hello</p>', isHTML: true, open: true, attachments: reply.attachments } });
assert.equal(newDetails.body, '<p>Hello</p>');
assert.equal(await newDetails.attachments[0].file.text(), 'attachment');
console.log('PASS: plain reply text keeps native HTML quote; new HTML draft includes attachment');

const decode = vm.runInContext('decodeAttachments', context);
const max = 25 * 1024 * 1024;
assert.equal(decode([{ name: 'large.bin', data: Buffer.alloc(max).toString('base64') }])[0].file.size, max);
assert.throws(() => decode([{ name: 'too-large.bin', data: Buffer.alloc(max + 1).toString('base64') }]), /25 MiB/);
assert.throws(() => decode([{ name: 'bad.bin', data: 'a===' }]), /INVALID_ARGS/);
console.log('PASS: 25 MiB attachment limit works without regex stack overflow');

// Native inline forwarding must retain Thunderbird's body and attachments.
let forwarded = 0;
const nativeAttachments = [{ id: 1, name: 'bill.jpeg', size: 123 }];
context.messenger.compose.beginForward = async (id, type, details) => {
  assert.equal(id, 42);
  assert.equal(type, 'forwardInline');
  assert.equal(details.body, undefined);
  assert.equal(details.plainTextBody, undefined);
  assert.equal(details.attachments, undefined);
  assert.equal(details.to[0], 'test@example.org');
  assert.equal(details.cc.length + details.bcc.length, 0);
  forwarded++;
  return { id: 7 };
};
context.messenger.compose.setComposeDetails = async (id, details) => {
  assert.equal(id, 7);
  assert.equal(details.attachments, undefined, 'Keep native attachments');
  updated = details;
};
context.messenger.compose.listAttachments = async () => nativeAttachments;
original.type = 'forward';
original.isPlainText = true;
updated = undefined;
const forward = { messageId: 42, to: 'test@example.org', body: 'New note\nSignature', open: true };
assert.equal((await request({ method: 'POST', path: '/forward', body: forward })).tabId, 7);
assert.equal(insertedText, 'New note\nSignature\n\n');
assert.equal(updated, undefined);
assert.equal((await request({ method: 'GET', path: '/compose/7' })).attachments, nativeAttachments);
updated = undefined;
await request({ method: 'POST', path: '/forward', body: { ...forward, body: '' } });
assert.equal(updated, undefined, 'An empty note must not rewrite the native body');
original.isPlainText = false;
original.body = '<div class="moz-forward-container">Original <b>HTML</b><img src="cid:bill"></div>';
await request({ method: 'POST', path: '/forward', body: { ...forward, body: '<Not HTML>\n\nSignature' } });
assert.equal(updated, undefined, 'HTML forwards must not replace the native body');
assert.equal(insertedHtml, '<div>&lt;Not HTML&gt;\n\nSignature</div>');
const inspected = await request({ method: 'GET', path: '/compose/7' });
assert.equal(inspected.inlineImages[0].naturalWidth, 87);
const beforeRejected = forwarded;
for (const invalid of [{ body: {} }, { messageId: undefined }, { to: [] }, { to: 'invalid' }, { to: 'test@example.org\nBcc: other@example.org' }]) {
  await assert.rejects(request({ method: 'POST', path: '/forward', body: { ...forward, ...invalid } }), /INVALID_ARGS/);
}
await assert.rejects(request({ method: 'POST', path: '/forward', body: { ...forward, send: true } }), /FORBIDDEN/);
assert.equal(forwarded, beforeRejected, 'Rejected forwards must not open a composer');
context.messenger.tabs.executeScript = async () => { throw new Error('Native update failed'); };
await assert.rejects(request({ method: 'POST', path: '/forward', body: forward }), /Forward tab 7.*inspect it.*Native update failed/);
console.log('PASS: native inline forward retains plain/HTML quotation and attachments, escapes note, validates input and reports partial failures');

original.type = 'reply';
await assert.rejects(request({ method: 'POST', path: '/reply', body: { messageId: 42, body: 'Reply', open: true } }), /Reply tab 7.*inspect it.*Native update failed/);
console.log('PASS: reply/forward insert only new HTML, retain native image nodes, preserve line breaks and surface insertion failures');
