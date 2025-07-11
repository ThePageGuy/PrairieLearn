import { Fragment } from 'preact/jsx-runtime';
import { z } from 'zod';

import { PageLayout } from '../../components/PageLayout.html.js';
import { Scorebar } from '../../components/Scorebar.js';
import {
  AssessmentAccessRuleSchema,
  AssessmentInstanceSchema,
  AssessmentSchema,
  AssessmentSetSchema,
} from '../../lib/db-types.js';

export const StudentGradebookRowSchema = z.object({
  assessment_id: AssessmentSchema.shape.id,
  assessment_group_work: AssessmentSchema.shape.group_work,
  title: z.string(),
  assessment_set_heading: AssessmentSetSchema.shape.heading,
  assessment_set_color: AssessmentSetSchema.shape.color,
  label: z.string(),
  assessment_instance_id: AssessmentInstanceSchema.shape.id,
  assessment_instance_score_perc: AssessmentInstanceSchema.shape.score_perc,
  show_closed_assessment_score: AssessmentAccessRuleSchema.shape.show_closed_assessment_score,
  start_new_set: z.boolean(),
});
export type StudentGradebookRow = z.infer<typeof StudentGradebookRowSchema>;

export function StudentGradebook({
  resLocals,
  rows,
  csvFilename,
}: {
  resLocals: Record<string, any>;
  rows: StudentGradebookRow[];
  csvFilename: string;
}) {
  return PageLayout({
    resLocals,
    pageTitle: 'Gradebook',
    navContext: {
      type: 'student',
      page: 'gradebook',
    },
    content: (
      <div class="card mb-4">
        <div class="card-header bg-primary text-white d-flex align-items-center">
          <h1>Gradebook</h1>
          <a
            href={`/pl/course_instance/${resLocals.course_instance.id}/gradebook/${csvFilename}`}
            class="btn btn-light btn-sm ms-auto"
            aria-label="Download gradebook CSV"
          >
            <i class="fas fa-download" aria-hidden="true"></i>
            <span class="d-none d-sm-inline">Download</span>
          </a>
        </div>

        <table class="table table-sm table-hover" aria-label="Gradebook">
          <thead>
            <tr>
              <th style="width: 1%">
                <span class="visually-hidden">Label</span>
              </th>
              <th>
                <span class="visually-hidden">Title</span>
              </th>
              <th class="text-center">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={`${row.assessment_id}-${row.assessment_instance_id}`}>
                {row.start_new_set && (
                  <tr>
                    <th colspan={3}>{row.assessment_set_heading}</th>
                  </tr>
                )}
                <tr>
                  <td class="align-middle" style="width: 1%">
                    <span class={`badge color-${row.assessment_set_color}`}>{row.label}</span>
                  </td>
                  <td class="align-middle">
                    {row.title}{' '}
                    {row.assessment_group_work && <i class="fas fa-users" aria-hidden="true"></i>}
                  </td>
                  <td class="text-center align-middle">
                    {row.show_closed_assessment_score ? (
                      <Scorebar score={row.assessment_instance_score_perc} className="mx-auto" />
                    ) : (
                      'Score not shown'
                    )}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    ),
  });
}
