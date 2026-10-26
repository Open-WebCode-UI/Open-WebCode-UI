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

  it('instructor role holds author and learn; designating = assigning the role', async () => {
    const c = mkCourse();
    expect(await canAuthor(owner.id, c)).toBe(true);
    expect(await canAuthor(learner.id, c)).toBe(false);
  });
  it('co-instructors can author; admins can author any course', async () => {
    const c = mkCourse();
    const other = login(createApp(), { username: 'assistant1', roles: ['instructor'] });
    expect(await canAuthor(other.id, c)).toBe(false);
    getDb().prepare('INSERT INTO course_instructors VALUES (?,?)').run(c.id, other.id);
    expect(await canAuthor(other.id, c)).toBe(true);
    const admin = login(createApp(), { username: 'root1', roles: ['administrator'] });
    expect(await canAuthor(admin.id, c)).toBe(true);
  });
  it('requires enrollment and a published course', async () => {
    const c = mkCourse();
    expect(await canLearn(learner.id, c)).toBe(false);
    enroll(c, 'user', learner.id);
    expect(await canLearn(learner.id, c)).toBe(true);
    expect(await canLearn(learner.id, mkCourse('draft'))).toBe(false);
    expect((await listLearnerCourses(learner.id)).map((x) => x.id)).toEqual([c.id]);
  });
  it('enrolls through a role', async () => {
    const c = mkCourse(); enroll(c, 'role', 'developer');
    expect(await canLearn(learner.id, c)).toBe(true);
    expect(await canLearn(owner.id, c)).toBe(false);
  });
  it('enrolls through a SAML group persisted at login', async () => {
    const c = mkCourse(); enroll(c, 'saml_group', 'cs101');
    expect(await canLearn(learner.id, c)).toBe(false);
    await syncRolesFromGroups(learner.id, ['cs101'], {});
    expect(await canLearn(learner.id, c)).toBe(true);
    await syncRolesFromGroups(learner.id, ['other'], {});
    expect(await canLearn(learner.id, c)).toBe(false);
  });
  it('enrolled users without course.learn cannot take the course', async () => {
    makeRole('nolearn', ['project.read']);
    const u = login(createApp(), { username: 'nolrn', roles: ['nolearn'] });
    const c = mkCourse(); enroll(c, 'user', u.id);
    expect(await canLearn(u.id, c)).toBe(false);
  });
});
