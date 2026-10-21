import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, makeRole } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { canAuthor, canLearn, listLearnerCourses } from '../src/courses/access.js';
import { syncRolesFromGroups } from '../src/auth/saml-identity.js';

let owner; let learner;
const mkCourse = (status = 'published') => {
  const c = getDb().prepare('INSERT INTO courses (title, owner_id, status) VALUES (?,?,?)').run('C', owner.id, status);
  return getDb().prepare('SELECT * FROM courses WHERE id=?').get(Number(c.lastInsertRowid));
};
const enroll = (course, type, id) => getDb().prepare('INSERT INTO course_enrollments (course_id, subject_type, subject_id) VALUES (?,?,?)').run(course.id, type, String(id));

describe('course access', () => {
  beforeEach(() => {
    freshDb(); const app = createApp();
    owner = login(app, { username: 'inst', roles: ['instructor'] });
    learner = login(app, { username: 'stu', roles: ['developer'] });
  });

  it('instructor role holds author and learn; designating = assigning the role', () => {
    const c = mkCourse();
    expect(canAuthor(owner.id, c)).toBe(true);
    expect(canAuthor(learner.id, c)).toBe(false);
  });
  it('co-instructors can author; admins can author any course', () => {
    const c = mkCourse();
    const other = login(createApp(), { username: 'assistant1', roles: ['instructor'] });
    expect(canAuthor(other.id, c)).toBe(false);
    getDb().prepare('INSERT INTO course_instructors VALUES (?,?)').run(c.id, other.id);
    expect(canAuthor(other.id, c)).toBe(true);
    const admin = login(createApp(), { username: 'root1', roles: ['administrator'] });
    expect(canAuthor(admin.id, c)).toBe(true);
  });
  it('requires enrollment and a published course', () => {
    const c = mkCourse();
    expect(canLearn(learner.id, c)).toBe(false);
    enroll(c, 'user', learner.id);
    expect(canLearn(learner.id, c)).toBe(true);
    expect(canLearn(learner.id, mkCourse('draft'))).toBe(false);
    expect(listLearnerCourses(learner.id).map((x) => x.id)).toEqual([c.id]);
  });
  it('enrolls through a role', () => {
    const c = mkCourse(); enroll(c, 'role', 'developer');
    expect(canLearn(learner.id, c)).toBe(true);
    expect(canLearn(owner.id, c)).toBe(false);
  });
  it('enrolls through a SAML group persisted at login', () => {
    const c = mkCourse(); enroll(c, 'saml_group', 'cs101');
    expect(canLearn(learner.id, c)).toBe(false);
    syncRolesFromGroups(learner.id, ['cs101'], {});
    expect(canLearn(learner.id, c)).toBe(true);
    syncRolesFromGroups(learner.id, ['other'], {});
    expect(canLearn(learner.id, c)).toBe(false);
  });
  it('enrolled users without course.learn cannot take the course', () => {
    makeRole('nolearn', ['project.read']);
    const u = login(createApp(), { username: 'nolrn', roles: ['nolearn'] });
    const c = mkCourse(); enroll(c, 'user', u.id);
    expect(canLearn(u.id, c)).toBe(false);
  });
});
