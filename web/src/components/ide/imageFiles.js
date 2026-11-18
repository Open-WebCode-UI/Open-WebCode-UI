// Raster images the editor shows read only. SVG stays a text file (it is markup); the server accepts the same extensions (projects.js, GET /image).
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
export const isImagePath = (p) => IMAGE_FILE.test(p || '');
export const projectImageUrl = (projectId, path) => `/api/projects/${projectId}/image?path=${encodeURIComponent(path)}`;
