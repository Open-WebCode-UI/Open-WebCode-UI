import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, makeRole } from './helpers.js';

import { canAuthor, canLearn, listLearnerCourses } from '../src/courses/access.js';
import { syncRolesFromGroups } from '../src/auth/saml-identity.js';

let owner; let learner;
const mkCourse = async (status = 'published') => {
  const c = (await sqlDb().prepare('INSERT INTO courses (title, owner_id, status) VALUES (?,?,?)').run('C', owner.id, status));
  return (await sqlDb().prepare('SELECT * FROM courses WHERE id=?').get(Number(c.lastInsertRowid)));
};
const enroll = async (course, type, id) => (await sqlDb().prepare('INSERT INTO course_enrollments (course_id, subject_type, subject_id) VALUES (?,?,?)').run(course.id, type, String(id)));

describe('course access', () => {
  beforeEach(async () => {
    await freshDb(); const app = createApp();
    owner = await login(app, { username: 'inst', roles: ['instructor'] });
    learner = await login(app, { username: 'stu', roles: ['developer'] });
  });

  it('instructor role holds author and learn; designating = assigning the role', async () => {
    const c = await mkCourse();
    expect(await canAuthor(owner.id, c)).toBe(true);
    expect(await canAuthor(learner.id, c)).toBe(false);
  });
  it('co-instructors can author; admins can author any course', async () => {
    const c = await mkCourse();
    const other = await login(createApp(), { username: 'assistant1', roles: ['instructor'] });
    expect(await canAuthor(other.id, c)).toBe(false);
    (await sqlDb().prepare('INSERT INTO course_instructors VALUES (?,?)').run(c.id, other.id));
    expect(await canAuthor(other.id, c)).toBe(true);
    const admin = await login(createApp(), { username: 'root1', roles: ['administrator'] });
    expect(await canAuthor(admin.id, c)).toBe(true);
  });
  it('requires enrollment and a published course', async () => {
    const c = await mkCourse();
    expect(await canLearn(learner.id, c)).toBe(false);
    await enroll(c, 'user', learner.id);
    expect(await canLearn(learner.id, c)).toBe(true);
    expect(await canLearn(learner.id, await mkCourse('draft'))).toBe(false);
    expect((await listLearnerCourses(learner.id)).map((x) => x.id)).toEqual([c.id]);
  });
  it('enrolls through a role', async () => {
    const c = await mkCourse(); await enroll(c, 'role', 'developer');
    expect(await canLearn(learner.id, c)).toBe(true);
    expect(await canLearn(owner.id, c)).toBe(false);
  });
  it('enrolls through a SAML group persisted at login', async () => {
    const c = await mkCourse(); await enroll(c, 'saml_group', 'cs101');
    expect(await canLearn(learner.id, c)).toBe(false);
    await syncRolesFromGroups(learner.id, ['cs101'], {});
    expect(await canLearn(learner.id, c)).toBe(true);
    await syncRolesFromGroups(learner.id, ['other'], {});
    expect(await canLearn(learner.id, c)).toBe(false);
  });
  it('enrolled users without course.learn cannot take the course', async () => {
    await makeRole('nolearn', ['project.read']);
    const u = await login(createApp(), { username: 'nolrn', roles: ['nolearn'] });
    const c = await mkCourse(); await enroll(c, 'user', u.id);
    expect(await canLearn(u.id, c)).toBe(false);
  });
});
