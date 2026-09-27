import { z } from 'zod';
import { EntityIdSchema, TimestampSchema } from './common.ts';

export const TASK_STATUSES = [
  'pending',
  'active',
  'blocked',
  'paused',
  'completed',
  'failed',
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.strictObject({
  id: EntityIdSchema,
  goal: z.string().min(1).max(300),
  subgoal: z.string().min(1).max(300).nullable(),
  status: TaskStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskCheckpointSchema = z.strictObject({
  id: z.int().positive(),
  taskId: EntityIdSchema,
  seq: z.int().min(1),
  label: z.string().min(1).max(100),
  data: z.record(z.string(), z.unknown()),
  stateSnapshotId: z.int().positive().nullable(),
  createdAt: TimestampSchema,
});
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>;
