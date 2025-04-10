import { type NextFunction, type Request, type Response } from 'express';

import { HttpStatusError } from '@prairielearn/error';

export default function (req: Request, res: Response, next: NextFunction) {
  if (
    // Effective user is course instructor.
    res.locals.authz_data.has_course_permission_preview ||
    // Effective user is course instance instructor.
    res.locals.authz_data.has_course_instance_permission_view ||
    // Effective user is enrolled in the course instance.
    res.locals.authz_data.has_student_access_with_enrollment
  ) {
    return next();
  } else {
    return next(new HttpStatusError(403, 'Access denied'));
  }
}
