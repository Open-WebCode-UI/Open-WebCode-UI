import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { sessions } from '../src/sessionStore.js';
import { approvals } from '../src/approvalStore.js';
import { layoutStore } from '../src/layoutStore.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); sessions.resetAll(); approvals.clear(); layoutStore.forgetForTests(); });
Element.prototype.scrollIntoView = () => {};

// jsdom has no layout; ProseMirror (the WYSIWYG message editor) measures ranges/elements when scrolling the caret into view.
const emptyRects = () => { const l = []; l.item = () => null; return l; };
const zeroRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} });
for (const proto of [Range.prototype, Element.prototype]) { proto.getClientRects ||= emptyRects; proto.getBoundingClientRect ||= zeroRect; }
