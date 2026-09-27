import type { PlannerProvider } from './planner-provider.ts';
import {
  PlannerRequestSchema,
  PlannerResponseSchema,
  type PlannerRequest,
  type PlannerResponse,
} from './plan-schema.ts';

export interface PlannerFixture {
  name: string;
  /** Matches when every provided condition holds. An empty `when` matches everything. */
  when: { taskId?: string; goalIncludes?: string };
  /** Raw response; validated with the same schema a real planner's output would be. */
  response: unknown;
}

const NO_FIXTURE: PlannerResponse = {
  kind: 'escalation',
  escalation: {
    reason: 'OUT_OF_SCOPE',
    message: 'MockPlannerProvider has no fixture for this task.',
    questionForUser: 'No plan is available for the current task. What should the agent do?',
  },
};

/**
 * Deterministic, fixture-driven planner. The first matching fixture wins. Fixture
 * responses pass through PlannerResponseSchema, so a malformed fixture behaves like
 * malformed model output (it becomes an INVALID_OUTPUT escalation).
 */
export class MockPlannerProvider implements PlannerProvider {
  readonly name = 'mock-planner';
  readonly #fixtures: readonly PlannerFixture[];
  readonly requests: PlannerRequest[] = [];

  constructor(fixtures: readonly PlannerFixture[] = []) {
    this.#fixtures = fixtures;
  }

  plan(request: PlannerRequest): Promise<PlannerResponse> {
    this.requests.push(PlannerRequestSchema.parse(request));
    const fixture = this.#fixtures.find((f) => matches(f, request));
    if (fixture === undefined) return Promise.resolve(NO_FIXTURE);

    const parsed = PlannerResponseSchema.safeParse(fixture.response);
    if (parsed.success) return Promise.resolve(parsed.data);
    return Promise.resolve({
      kind: 'escalation',
      escalation: {
        reason: 'INVALID_OUTPUT',
        message: `Fixture "${fixture.name}" failed schema validation`,
        questionForUser: 'The planner produced invalid output. How should the agent proceed?',
      },
    });
  }
}

function matches(fixture: PlannerFixture, request: PlannerRequest): boolean {
  const { taskId, goalIncludes } = fixture.when;
  if (taskId !== undefined && request.task?.taskId !== taskId) return false;
  if (goalIncludes !== undefined && !(request.task?.goal ?? '').includes(goalIncludes))
    return false;
  return true;
}
