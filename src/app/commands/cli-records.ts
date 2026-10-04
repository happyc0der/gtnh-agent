import { readFileSync } from 'node:fs';
import { gtOreByName } from '../../goals/ore-names.ts';
import { describeCommand, isStructured, parseOwnerCommand } from '../../domain/owner-commands.ts';
import { TaskStatusSchema } from '../../domain/tasks.ts';
import { NOT_UNDERSTOOD } from '../play/commands.ts';
import { openDatabase } from '../../persistence/database.ts';
import { createRepositories } from '../../persistence/repositories.ts';
import { systemClock } from '../../util/clock.ts';
import { errorMessage } from '../../util/json.ts';
import { syncConfigToDatabase } from '../loop/agent-memory.ts';
import { observeWithQuestBook } from '../play/live-play.ts';
import { describeQuests, freeSlotsOf, updateQuests } from '../play/quest-progress.ts';
import { parseNeeds, type Cli } from './cli-context.ts';
import { withLiveClient } from './live-commands.ts';
import { approvePlan, rejectPlan, showPlans } from './plan-commands.ts';
import { addTask, completeTask, listTasks } from './task-commands.ts';
import { describeKnownPlaces, parseMapPoint } from './world-memory-commands.ts';

/**
 * The CLI's commands on what the agent keeps in its database (src/app/cli.ts): the action
 * history, tasks and their plans, world memory's places, learned window layouts, and the
 * quest book as the server records it.
 */

/** `places [--at x,z]`: what world memory knows, as the planner gets it. */
export function placesCommand(cli: Cli): number {
  const { values, config, dbPath, print } = cli;
  const at = values.at === undefined ? null : parseMapPoint(values.at);
  if (values.at !== undefined && at === null) {
    process.stderr.write('--at must be x,z (or x,y,z)\n');
    return 1;
  }
  const db = openDatabase(dbPath);
  try {
    const out = describeKnownPlaces(createRepositories(db, systemClock), config, at, new Date());
    if (!out.ok) {
      process.stderr.write(`${out.error}\n`);
      return 1;
    }
    print(out.value);
    return 0;
  } finally {
    db.close();
  }
}

/** `layouts`: window layouts learned from blocks the agent opened. */
export function layoutsCommand(cli: Cli): number {
  const { dbPath, print } = cli;
  const db = openDatabase(dbPath);
  try {
    print(createRepositories(db, systemClock).windowLayouts.list());
    return 0;
  } finally {
    db.close();
  }
}

/** `history [--limit N]`: recent logged actions. */
export function historyCommand(cli: Cli): number {
  const { values, dbPath, print } = cli;
  const db = openDatabase(dbPath);
  const repos = createRepositories(db, systemClock);
  const limit = Math.max(1, Math.min(200, Number(values.limit) || 10));
  print(
    repos.actions.recent(limit).map((a) => ({
      at: a.createdAt,
      actionId: a.actionId,
      taskId: a.taskId,
      type: a.actionType,
      origin: a.origin,
      status: a.status,
      reason: a.reason,
    })),
  );
  db.close();
  return 0;
}

/**
 * `command "<text>"`: queues an owner command as if the first owner (MC_OWNERS) had whispered
 * it; a running `play --live` picks it up between cycles (and a stop at once), else the next
 * play does. The structured form is checked here, so a typo is refused at once; natural
 * language is left for the model (AGENT_COMMANDS=ollama) to translate when play takes it.
 */
export function commandCommand(cli: Cli): number {
  const { args, config, dbPath, print } = cli;
  const text = args.join(' ').trim();
  if (text === '') {
    process.stderr.write('command needs the text, e.g. pnpm cli command "!goto 120 64 -40"\n');
    return 1;
  }
  const owner = config.minecraft.owners[0];
  if (owner === undefined) {
    process.stderr.write('no owner is configured (MC_OWNERS): owner commands are off\n');
    return 1;
  }
  const parsed = parseOwnerCommand(text, { ore: gtOreByName });
  if (!parsed.ok && (parsed.kind === 'usage' || isStructured(text))) {
    process.stderr.write(`${parsed.kind === 'usage' ? parsed.usage : NOT_UNDERSTOOD}\n`);
    return 1;
  }
  if (!parsed.ok && config.commands.translator === 'none') {
    process.stderr.write(
      `${NOT_UNDERSTOOD} (natural language needs a translator: AGENT_COMMANDS=ollama)\n`,
    );
    return 1;
  }
  const db = openDatabase(dbPath);
  try {
    const record = createRepositories(db, systemClock).commands.add({
      source: 'cli',
      sender: owner,
      rawText: text,
      command: parsed.ok ? parsed.command : null,
    });
    print({
      id: record.id,
      sender: owner,
      text,
      command: parsed.ok
        ? describeCommand(parsed.command)
        : 'natural language: the model translates it when play takes it',
      status: record.status,
      note: 'a running `cli play --live` takes it between cycles; otherwise the next play does',
    });
    return 0;
  } finally {
    db.close();
  }
}

/** `commands [--limit N]`: the most recent owner commands, with their status and reply. */
export function commandsCommand(cli: Cli): number {
  const { values, dbPath, print } = cli;
  const db = openDatabase(dbPath);
  try {
    const limit = Math.max(1, Math.min(200, Number(values.limit) || 10));
    print(
      createRepositories(db, systemClock)
        .commands.recent(limit)
        .map((c) => ({
          id: c.id,
          at: c.createdAt,
          source: c.source,
          sender: c.sender,
          text: c.rawText,
          command: c.command === null ? null : describeCommand(c.command),
          status: c.status,
          reply: c.reply,
          finishedAt: c.finishedAt,
        })),
    );
    return 0;
  } finally {
    db.close();
  }
}

/** `task-resume --task <id>`: marks a paused or blocked task active again. */
export function taskResumeCommand(cli: Cli): number {
  const { values, dbPath, print } = cli;
  if (values.task === undefined) {
    process.stderr.write('task-resume requires --task <id>\n');
    return 1;
  }
  const db = openDatabase(dbPath);
  const repos = createRepositories(db, systemClock);
  const task = repos.tasks.get(values.task);
  if (task === null) {
    process.stderr.write(`No task ${values.task}\n`);
    db.close();
    return 1;
  }
  repos.tasks.setStatus(task.id, TaskStatusSchema.parse('active'));
  print({ task: task.id, previousStatus: task.status, status: 'active' });
  db.close();
  return 0;
}

/**
 * `quests [--live]`: the Age 0 quest book as the server records it; --live reads it from the
 * server first (it clicks nothing).
 */
export async function questsCommand(cli: Cli): Promise<number> {
  const { values, config, dbPath, print, log } = cli;
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    if (!values.live) {
      print(describeQuests(repos, repos.snapshots.latest('gtnh1710')));
      return 0;
    }
    const state = await withLiveClient(config, (client) => observeWithQuestBook(client), log);
    if (!state.questBook.known) {
      process.stderr.write(`the server's quest book is unknown: ${state.questBook.reason}\n`);
      print(describeQuests(repos, state));
      return 1;
    }
    // Records the server's completions (the CLI clicks nothing in the quest book).
    const update = updateQuests(repos, state.questBook.value, {
      items: state.inventory.known ? state.inventory.value.items : {},
      freeSlots: freeSlotsOf(state),
    });
    print({
      ...describeQuests(repos, state),
      newlyCompleted: update.added.map((q) => q.name),
    });
    return 0;
  } finally {
    db.close();
  }
}

/** `task-add`, `task-complete` and `task-list`. */
export function taskCommand(cli: Cli): number {
  const { command, values, config, dbPath, print } = cli;
  if (command !== 'task-list' && values.task === undefined) {
    process.stderr.write(`${command} requires --task <id>\n`);
    return 1;
  }
  if (command === 'task-add' && values.goal === undefined) {
    process.stderr.write('task-add requires --goal <text>\n');
    return 1;
  }
  let planJson: unknown = undefined;
  if (command === 'task-add' && values.plan !== undefined) {
    try {
      planJson = JSON.parse(readFileSync(values.plan, 'utf8'));
    } catch (error) {
      process.stderr.write(`cannot read plan ${values.plan}: ${errorMessage(error)}\n`);
      return 1;
    }
  }
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    syncConfigToDatabase(config, repos);
    const taskId = values.task ?? '';
    const result =
      command === 'task-add'
        ? addTask(repos, config, {
            taskId,
            goal: values.goal ?? '',
            plan: planJson,
            now: new Date(),
            machines: (values.machines ?? '')
              .split(',')
              .map((m) => m.trim())
              .filter((m) => m.length > 0),
            ...(values.needs === undefined ? {} : { requirements: parseNeeds(values.needs) }),
          })
        : command === 'task-complete'
          ? completeTask(repos, taskId)
          : listTasks(repos);
    if (!result.ok) {
      process.stderr.write(`${result.error}
`);
      return 1;
    }
    print(result.value);
    return 0;
  } finally {
    db.close();
  }
}

/** `plan-show`, `plan-approve` and `plan-reject`. */
export function planCommand(cli: Cli): number {
  const { command, values, dbPath, print } = cli;
  if (command !== 'plan-show' && values.task === undefined) {
    process.stderr.write(`${command} requires --task <id>\n`);
    return 1;
  }
  const planId = values.plan === undefined ? undefined : Number(values.plan);
  if (planId !== undefined && !Number.isSafeInteger(planId)) {
    process.stderr.write('--plan must be a plan number\n');
    return 1;
  }
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    const taskId = values.task;
    const result =
      taskId === undefined || command === 'plan-show'
        ? showPlans(repos, taskId)
        : command === 'plan-approve'
          ? approvePlan(repos, taskId, planId)
          : rejectPlan(repos, taskId, planId, values.reason);
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`);
      return 1;
    }
    print(result.value);
    return 0;
  } finally {
    db.close();
  }
}
