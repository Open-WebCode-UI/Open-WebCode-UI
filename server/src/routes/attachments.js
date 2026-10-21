import express from 'express';
import { defineRoutes, fail } from '../http.js';
import { getSettings } from '../settings.js';
import { audit } from '../audit.js';
import { saveUpload, discard, getOwned, readBytes, MEDIA_KINDS, ID_RE } from '../attachments.js';

export function attachmentsRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  // One file as the raw request body: PUT /api/attachments?name=report.csv. It is stored unattached until a turn uses it.
  const raw = (req, res, next) => express.raw({ type: () => true, limit: `${getSettings('general').maxAttachmentMb}mb` })(req, res, next);
  route.put('/attachments', 'provider.use', raw, (req, res) => {
    const a = saveUpload(req.user.id, String(req.query.name || 'file'), req.body, { maxBytes: getSettings('general').maxAttachmentMb * 1024 * 1024 });
    audit(req.user.id, 'attachment.upload', a.kind, { bytes: a.size });
    res.status(201).json(a);
  });
  // Read a stored file back (the owner only). Only images, audio and video are shown inline; they are served under their sniffed type,
  // sandboxed and never sniffed again by the browser. Anything else downloads.
  route.get('/attachments/:id', 'provider.use', (req, res) => {
    const a = getOwned(req.user.id, req.params.id), data = a && readBytes(req.user.id, a.id);
    if (!data) fail(404, 'not_found');
    const inline = MEDIA_KINDS.has(a.kind);
    res.set({ 'Content-Type': inline ? a.mime : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Content-Disposition': `${inline && !req.query.download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}` });
    res.send(data);
  });
  route.delete('/attachments/:id', 'provider.use', (req, res) => {
    if (!ID_RE.test(req.params.id) || !discard(req.user.id, req.params.id)) fail(404, 'not_found');
    res.json({ ok: true });
  });
  return r;
}
