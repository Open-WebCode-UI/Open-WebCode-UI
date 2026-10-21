import { getSettings } from '../settings.js';

// The administrator can limit which models an instructor may pick for a course (a tutor/chat page's model, an exercise's model).
// null means no limit. This only narrows instructor choices; a learner's own model choice is governed by their role as before.
export const allowedCourseModelIds = () => getSettings('courses').allowedModelIds ?? null;
export const courseModelAllowed = (id) => { const a = allowedCourseModelIds(); return id == null || a == null || a.includes(id); };
// A stored choice that is no longer allowed is ignored at run time, so learners fall back to the platform default instead of hitting an error.
export const effectiveCourseModelId = (id) => (courseModelAllowed(id) ? id ?? null : null);
