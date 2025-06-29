import { z } from 'zod';

import { loadSqlEquiv, queryOptionalRow, queryRow, queryRows } from '@prairielearn/postgres';

import {
  type CourseInstance,
  type CourseInstancePermission,
  CourseInstanceSchema,
  UserSchema,
} from '../lib/db-types.js';
import { idsEqual } from '../lib/id.js';

const sql = loadSqlEquiv(import.meta.url);

const CourseInstanceAuthzSchema = CourseInstanceSchema.extend({
  formatted_start_date: z.string(),
  formatted_end_date: z.string(),
  has_course_instance_permission_view: z.boolean(),
  has_course_instance_permission_edit: z.boolean(),
});
export type CourseInstanceAuthz = z.infer<typeof CourseInstanceAuthzSchema>;

export async function selectOptionalCourseInstanceById(
  course_instance_id: string,
): Promise<CourseInstance | null> {
  return queryOptionalRow(
    sql.select_course_instance_by_id,
    { course_instance_id },
    CourseInstanceSchema,
  );
}

export async function selectCourseInstanceByShortName({
  course_id,
  short_name,
}: {
  course_id: string;
  short_name: string;
}): Promise<CourseInstance> {
  return queryRow(
    sql.select_course_instance_by_short_name,
    { course_id, short_name },
    CourseInstanceSchema,
  );
}

/**
 * Returns all course instances to which the given user has staff access.
 *
 * If the user is emulating another user, the results will be filtered to only
 * include course instances to which both the authenticated user and the
 * emulated user have access.
 */
export async function selectCourseInstancesWithStaffAccess({
  course_id,
  user_id,
  authn_user_id,
  is_administrator,
  authn_is_administrator,
}: {
  course_id: string;
  user_id: string;
  authn_user_id: string;
  is_administrator: boolean;
  authn_is_administrator: boolean;
}) {
  const authnCourseInstances = await queryRows(
    sql.select_course_instances_with_staff_access,
    { user_id: authn_user_id, is_administrator: authn_is_administrator, course_id },
    CourseInstanceAuthzSchema,
  );

  if (idsEqual(user_id, authn_user_id)) {
    return authnCourseInstances;
  }

  const authzCourseInstances = await queryRows(
    sql.select_course_instances_with_staff_access,
    { user_id, is_administrator, course_id },
    CourseInstanceAuthzSchema,
  );

  // Retain only the course instances for which the authn user also has access.
  const authnCourseIds = new Set(authnCourseInstances.map((c) => c.id));
  return authzCourseInstances.filter((authzCourseInstance) => {
    return authnCourseIds.has(authzCourseInstance.id);
  });
}

export async function selectUsersWithCourseInstanceAccess({
  course_instance_id,
  minimal_role,
}: {
  course_instance_id: string;
  minimal_role: Exclude<CourseInstancePermission['course_instance_role'], null>;
}) {
  return await queryRows(
    sql.select_users_with_course_instance_access,
    { course_instance_id, minimal_role },
    UserSchema,
  );
}

export async function selectCourseInstanceGraderStaff({
  course_instance_id,
}: {
  course_instance_id: string;
}) {
  return await selectUsersWithCourseInstanceAccess({
    course_instance_id,
    minimal_role: 'Student Data Editor',
  });
}

/**
 * Returns if the course has any non-deleted course instances.
 */
export async function selectCourseHasCourseInstances({
  course_id,
}: {
  course_id: string;
}): Promise<boolean> {
  return await queryRow(sql.select_course_has_course_instances, { course_id }, z.boolean());
}

export async function selectCourseInstanceIsPublic(course_instance_id: string): Promise<boolean> {
  const isPublic = await queryRow(
    sql.check_course_instance_is_public,
    { course_instance_id },
    z.boolean(),
  );
  return isPublic;
}

export async function selectCourseInstanceByUuid({
  course_id,
  uuid,
}: {
  course_id: string;
  uuid: string;
}): Promise<CourseInstance> {
  return await queryRow(
    sql.select_course_instance_by_uuid,
    { uuid, course_id },
    CourseInstanceSchema,
  );
}
