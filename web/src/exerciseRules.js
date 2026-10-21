import { useEffect, useState } from 'react';
import { get } from './api.js';

// The rules a course exercise sets for a workspace (null for an ordinary project). The server enforces them; this is for showing them.
export function useExerciseRules(projectId) {
  const [rules, setRules] = useState(null);
  useEffect(() => {
    setRules(null);
    if (!projectId) return undefined;
    let live = true;
    get(`/api/projects/${projectId}/exercise-policy`).then((r) => live && setRules(r)).catch(() => {});
    return () => { live = false; };
  }, [projectId]);
  return rules;
}
