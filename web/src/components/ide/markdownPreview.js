// A Markdown preview is a read-only editor tab that renders another file. Its path is namespaced so it can never collide with a project file.
export const PREVIEW_PREFIX = 'preview:';
export const previewPath = (source) => `${PREVIEW_PREFIX}${source}`;
export const isMarkdownPath = (p) => /\.(md|markdown|mdx)$/i.test(p || '');
// The file a tab stands for: a preview points at its source, any other tab is the file itself.
export const sourceOf = (t) => (t.preview ? t.source : t.path);
