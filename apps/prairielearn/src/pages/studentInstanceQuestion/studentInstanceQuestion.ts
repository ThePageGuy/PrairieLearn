import { type Request, type Response, Router } from 'express';
import asyncHandler from 'express-async-handler';

import { HttpStatusError } from '@prairielearn/error';
import { loadSqlEquiv, queryOptionalRow } from '@prairielearn/postgres';

import checkPlanGrantsForQuestion from '../../ee/middlewares/checkPlanGrantsForQuestion.js';
import { canDeleteAssessmentInstance, gradeAssessmentInstance } from '../../lib/assessment.js';
import { getQuestionCopyTargets } from '../../lib/copy-content.js';
import { IdSchema } from '../../lib/db-types.js';
import { deleteFile, uploadFile } from '../../lib/file-store.js';
import { getQuestionGroupPermissions } from '../../lib/groups.js';
import { idsEqual } from '../../lib/id.js';
import { reportIssueFromForm } from '../../lib/issues.js';
import { getAndRenderVariant, renderPanelsForSubmission } from '../../lib/question-render.js';
import { processSubmission } from '../../lib/question-submission.js';
import clientFingerprint from '../../middlewares/clientFingerprint.js';
import { enterpriseOnly } from '../../middlewares/enterpriseOnly.js';
import { logPageView } from '../../middlewares/logPageView.js';
import selectAndAuthzInstanceQuestion from '../../middlewares/selectAndAuthzInstanceQuestion.js';
import studentAssessmentAccess from '../../middlewares/studentAssessmentAccess.js';
import { selectUserById } from '../../models/user.js';
import { selectAndAuthzVariant, selectVariantsByInstanceQuestion } from '../../models/variant.js';

import { StudentInstanceQuestion } from './studentInstanceQuestion.html.js';

const sql = loadSqlEquiv(import.meta.url);

const router = Router({ mergeParams: true });

router.use(selectAndAuthzInstanceQuestion);
router.use(studentAssessmentAccess);
router.use(clientFingerprint);
router.use(enterpriseOnly(() => checkPlanGrantsForQuestion));

async function processFileUpload(req: Request, res: Response) {
  if (!res.locals.assessment_instance.open) {
    throw new HttpStatusError(403, 'Assessment is not open');
  }
  if (!res.locals.assessment.allow_personal_notes) {
    throw new HttpStatusError(403, 'This assessment does not allow personal notes.');
  }
  if (!res.locals.authz_result.active) {
    throw new HttpStatusError(403, 'This assessment is not accepting submissions at this time.');
  }
  if (!req.file) {
    throw new HttpStatusError(400, 'No file uploaded');
  }

  const variant = await selectAndAuthzVariant({
    unsafe_variant_id: req.body.__variant_id,
    variant_course: res.locals.course,
    question_id: res.locals.question.id,
    course_instance_id: res.locals.course_instance.id,
    instance_question_id: res.locals.instance_question.id,
    authz_data: res.locals.authz_data,
    authn_user: res.locals.authn_user,
    user: res.locals.user,
    is_administrator: res.locals.is_administrator,
  });

  await uploadFile({
    display_filename: req.file.originalname,
    contents: req.file.buffer,
    type: 'student_upload',
    assessment_id: res.locals.assessment.id,
    assessment_instance_id: res.locals.assessment_instance.id,
    instance_question_id: res.locals.instance_question.id,
    user_id: res.locals.user.user_id,
    authn_user_id: res.locals.authn_user.user_id,
  });

  return variant.id;
}

async function processTextUpload(req: Request, res: Response) {
  if (!res.locals.assessment_instance.open) {
    throw new HttpStatusError(403, 'Assessment is not open');
  }
  if (!res.locals.assessment.allow_personal_notes) {
    throw new HttpStatusError(403, 'This assessment does not allow personal notes.');
  }
  if (!res.locals.authz_result.active) {
    throw new HttpStatusError(403, 'This assessment is not accepting submissions at this time.');
  }

  const variant = await selectAndAuthzVariant({
    unsafe_variant_id: req.body.__variant_id,
    variant_course: res.locals.course,
    question_id: res.locals.question.id,
    course_instance_id: res.locals.course_instance.id,
    instance_question_id: res.locals.instance_question.id,
    authz_data: res.locals.authz_data,
    authn_user: res.locals.authn_user,
    user: res.locals.user,
    is_administrator: res.locals.is_administrator,
  });

  await uploadFile({
    display_filename: req.body.filename,
    contents: Buffer.from(req.body.contents),
    type: 'student_upload',
    assessment_id: res.locals.assessment.id,
    assessment_instance_id: res.locals.assessment_instance.id,
    instance_question_id: res.locals.instance_question.id,
    user_id: res.locals.user.user_id,
    authn_user_id: res.locals.authn_user.user_id,
  });

  return variant.id;
}

async function processDeleteFile(req: Request, res: Response) {
  if (!res.locals.assessment_instance.open) {
    throw new HttpStatusError(403, 'Assessment is not open');
  }
  if (!res.locals.assessment.allow_personal_notes) {
    throw new HttpStatusError(403, 'This assessment does not allow personal notes.');
  }
  if (!res.locals.authz_result.active) {
    throw new HttpStatusError(403, 'This assessment is not accepting submissions at this time.');
  }

  const variant = await selectAndAuthzVariant({
    unsafe_variant_id: req.body.__variant_id,
    variant_course: res.locals.course,
    question_id: res.locals.question.id,
    course_instance_id: res.locals.course_instance.id,
    instance_question_id: res.locals.instance_question.id,
    authz_data: res.locals.authz_data,
    authn_user: res.locals.authn_user,
    user: res.locals.user,
    is_administrator: res.locals.is_administrator,
  });

  // Check the requested file belongs to the current instance question
  const validFiles =
    res.locals.file_list?.filter((file) => idsEqual(file.id, req.body.file_id)) ?? [];
  if (validFiles.length === 0) {
    throw new HttpStatusError(404, `No such file_id: ${req.body.file_id}`);
  }
  const file = validFiles[0];

  if (file.type !== 'student_upload') {
    throw new HttpStatusError(403, `Cannot delete file type ${file.type} for file_id=${file.id}`);
  }

  await deleteFile(file.id, res.locals.authn_user.user_id);

  return variant.id;
}

async function validateAndProcessSubmission(req: Request, res: Response) {
  if (!res.locals.assessment_instance.open) {
    throw new HttpStatusError(400, 'assessment_instance is closed');
  }
  if (!res.locals.instance_question.open) {
    throw new HttpStatusError(400, 'instance_question is closed');
  }
  if (!res.locals.authz_result.active) {
    throw new HttpStatusError(400, 'This assessment is not accepting submissions at this time.');
  }
  if (res.locals.group_config?.has_roles && !res.locals.group_role_permissions.can_submit) {
    throw new HttpStatusError(
      403,
      'Your current group role does not give you permission to submit to this question.',
    );
  }
  return await processSubmission(req, res, { studentSubmission: true });
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!res.locals.authz_result.authorized_edit) {
      throw new HttpStatusError(403, 'Not authorized');
    }

    if (req.body.__action === 'grade' || req.body.__action === 'save') {
      if (res.locals.assessment.type === 'Exam') {
        if (res.locals.authz_result.time_limit_expired) {
          throw new HttpStatusError(
            403,
            'Time limit is expired, please go back and finish your assessment',
          );
        }
        if (req.body.__action === 'grade' && !res.locals.assessment.allow_real_time_grading) {
          throw new HttpStatusError(403, 'Real-time grading is not allowed for this assessment');
        }
      }
      const variant_id = await validateAndProcessSubmission(req, res);
      if (res.locals.assessment.type === 'Exam') {
        res.redirect(req.originalUrl);
      } else {
        res.redirect(
          `${res.locals.urlPrefix}/instance_question/${res.locals.instance_question.id}/?variant_id=${variant_id}`,
        );
      }
    } else if (req.body.__action === 'timeLimitFinish') {
      if (res.locals.assessment.type !== 'Exam') {
        throw new HttpStatusError(400, 'Only exams have a time limit');
      }
      // Only close if the timer expired due to time limit, not for access end
      if (!res.locals.assessment_instance_time_limit_expired) {
        return res.redirect(req.originalUrl);
      }

      const requireOpen = true;
      const closeExam = true;
      const overrideGradeRate = false;
      await gradeAssessmentInstance(
        res.locals.assessment_instance.id,
        res.locals.user.user_id,
        res.locals.authn_user.user_id,
        requireOpen,
        closeExam,
        overrideGradeRate,
        res.locals.client_fingerprint_id,
      );
      res.redirect(
        `${res.locals.urlPrefix}/assessment_instance/${res.locals.assessment_instance.id}?timeLimitExpired=true`,
      );
    } else if (req.body.__action === 'attach_file') {
      const variant_id = await processFileUpload(req, res);
      res.redirect(
        `${res.locals.urlPrefix}/instance_question/${res.locals.instance_question.id}/?variant_id=${variant_id}`,
      );
    } else if (req.body.__action === 'attach_text') {
      const variant_id = await processTextUpload(req, res);
      res.redirect(
        `${res.locals.urlPrefix}/instance_question/${res.locals.instance_question.id}/?variant_id=${variant_id}`,
      );
    } else if (req.body.__action === 'delete_file') {
      const variant_id = await processDeleteFile(req, res);
      res.redirect(
        `${res.locals.urlPrefix}/instance_question/${res.locals.instance_question.id}/?variant_id=${variant_id}`,
      );
    } else if (req.body.__action === 'report_issue') {
      const variant_id = await reportIssueFromForm(req, res, true);
      res.redirect(
        `${res.locals.urlPrefix}/instance_question/${res.locals.instance_question.id}/?variant_id=${variant_id}`,
      );
    } else {
      // The 'regenerate_instance' action is handled in the
      // studentAssessmentAccess middleware, so it doesn't need to be handled
      // here.
      throw new HttpStatusError(400, `unknown __action: ${req.body.__action}`);
    }
  }),
);

router.get(
  '/variant/:unsafe_variant_id(\\d+)/submission/:unsafe_submission_id(\\d+)',
  asyncHandler(async (req, res) => {
    const variant = await selectAndAuthzVariant({
      unsafe_variant_id: req.params.unsafe_variant_id,
      variant_course: res.locals.course,
      question_id: res.locals.question.id,
      course_instance_id: res.locals.course_instance.id,
      instance_question_id: res.locals.instance_question.id,
      authz_data: res.locals.authz_data,
      authn_user: res.locals.authn_user,
      user: res.locals.user,
      is_administrator: res.locals.is_administrator,
    });

    const panels = await renderPanelsForSubmission({
      unsafe_submission_id: req.params.unsafe_submission_id,
      question: res.locals.question,
      instance_question: res.locals.instance_question,
      variant,
      user: res.locals.user,
      urlPrefix: res.locals.urlPrefix,
      questionContext: res.locals.question.type === 'Exam' ? 'student_exam' : 'student_homework',
      authorizedEdit: res.locals.authz_result.authorized_edit,
      renderScorePanels: req.query.render_score_panels === 'true',
      groupRolePermissions: res.locals.group_role_permissions,
    });
    res.json(panels);
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    let variant_id =
      res.locals.assessment.type === 'Exam' || typeof req.query.variant_id !== 'string'
        ? null
        : req.query.variant_id;

    const isAssessmentAvailable =
      res.locals.assessment_instance.open && res.locals.authz_result.active;

    if (variant_id === null && !isAssessmentAvailable) {
      // We can't generate a new variant in this case, so we
      // fetch and display the most recent non-broken variant.
      // If no such variant exists, we tell the user that a new variant
      // cannot be generated.
      const last_variant_id = await queryOptionalRow(
        sql.select_last_variant_id,
        { instance_question_id: res.locals.instance_question.id },
        IdSchema,
      );
      if (last_variant_id == null) {
        res.status(403).send(
          StudentInstanceQuestion({
            resLocals: res.locals,
            userCanDeleteAssessmentInstance: canDeleteAssessmentInstance(res.locals),
          }),
        );
        return;
      }

      // For exams, we leave variant_id as null; getAndRenderVariant will handle it.
      if (res.locals.assessment.type === 'Homework') {
        variant_id = last_variant_id;
      }
    }
    await getAndRenderVariant(variant_id, null, res.locals as any);

    await logPageView('studentInstanceQuestion', req, res);
    const questionCopyTargets = await getQuestionCopyTargets({
      course: res.locals.course,
      is_administrator: res.locals.is_administrator,
      user: res.locals.user,
      authn_user: res.locals.authn_user,
      question: res.locals.question,
    });

    res.locals.instance_question_info.previous_variants = await selectVariantsByInstanceQuestion({
      assessment_instance_id: res.locals.assessment_instance.id,
      instance_question_id: res.locals.instance_question.id,
    });

    if (
      res.locals.group_config?.has_roles &&
      !res.locals.authz_data.has_course_instance_permission_view
    ) {
      if (res.locals.instance_question_info.prev_instance_question.id != null) {
        res.locals.prev_instance_question_role_permissions = await getQuestionGroupPermissions(
          res.locals.instance_question_info.prev_instance_question.id,
          res.locals.assessment_instance.group_id,
          res.locals.authz_data.user.user_id,
        );
      }
      if (res.locals.instance_question_info.next_instance_question.id) {
        res.locals.next_instance_question_role_permissions = await getQuestionGroupPermissions(
          res.locals.instance_question_info.next_instance_question.id,
          res.locals.assessment_instance.group_id,
          res.locals.authz_data.user.user_id,
        );
      }
    }
    const assignedGrader = res.locals.instance_question.assigned_grader
      ? await selectUserById(res.locals.instance_question.assigned_grader)
      : null;
    const lastGrader = res.locals.instance_question.last_grader
      ? await selectUserById(res.locals.instance_question.last_grader)
      : null;
    res.send(
      StudentInstanceQuestion({
        resLocals: res.locals,
        userCanDeleteAssessmentInstance: canDeleteAssessmentInstance(res.locals),
        assignedGrader,
        lastGrader,
        questionCopyTargets,
      }),
    );
  }),
);

export default router;
