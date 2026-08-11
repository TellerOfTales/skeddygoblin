/**
 * Every component in the weekly questionnaire, routed by action.
 *
 * Each handler defers immediately, reloads the draft from Postgres, mutates it,
 * and re-renders. Nothing is held between interactions - which is what makes
 * the flow survive a restart: the buttons already sitting in someone's DM still
 * work, because clicking one produces a fresh interaction and the state was
 * never in this process to begin with.
 */

import { DomainError } from '../../domain/errors.js';
import {
  isCapacity,
  isDay,
  isWindow,
  type Day,
  type VibeTag,
  type Window,
} from '../../domain/constants.js';
import { fromBase36, type ParsedCustomId } from '../customId.js';
import type { ComponentInteraction } from './index.js';
import { registerComponentHandler } from './index.js';
import type { AppContext } from '../../services/context.js';
import { resolveMemberByDiscordId } from '../../services/membershipService.js';
import { currentWeek, optOut, startOrResumeFlow, submit } from '../../services/responseService.js';
import * as draftService from '../../services/draftService.js';
import type { DraftRecord, GroupRecord } from '../../services/types.js';
import {
  singlePromptView,
  dayPickerView,
  noWindowsChosenView,
  optedOutView,
  submittedView,
  windowPickerView,
} from '../views/availability.view.js';

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

function renderWindowPage(
  draft: DraftRecord,
  group: GroupRecord,
  page: number,
): ReturnType<typeof windowPickerView> {
  return windowPickerView({
    draftId: draft.id,
    groupName: group.name,
    timezone: group.timezone,
    weekStartDate: draft.weekStartDate,
    days: draftService.selectedDays(draft.state),
    windowsByDay: draft.state.windows ?? {},
    page,
  });
}

/**
 * The default screen: everything on one message, Submit at the bottom.
 *
 * The staged day-picker still exists and is still reachable, but it is no
 * longer where the flow starts - it is what the "Different times per day"
 * button opens for people who need per-day precision.
 */
function renderSinglePrompt(
  draft: DraftRecord,
  group: GroupRecord,
): ReturnType<typeof singlePromptView> {
  return singlePromptView({
    draftId: draft.id,
    groupId: group.id,
    groupName: group.name,
    timezone: group.timezone,
    weekStartDate: draft.weekStartDate,
    selectedDays: draftService.selectedDays(draft.state),
    simpleWindows: draftService.simpleWindows(draft.state),
    windowsByDay: draft.state.windows ?? {},
    capacity: draftService.chosenCapacity(draft.state),
    vibes: draftService.chosenVibes(draft.state),
  });
}

function renderDayPicker(draft: DraftRecord, group: GroupRecord): ReturnType<typeof dayPickerView> {
  return dayPickerView({
    draftId: draft.id,
    groupId: group.id,
    groupName: group.name,
    timezone: group.timezone,
    weekStartDate: draft.weekStartDate,
    selectedDays: draftService.selectedDays(draft.state),
  });
}

/**
 * Resolves the acting member plus their draft, for any action carrying a draft
 * id. The ownership check lives in the service - a custom_id is not an
 * authorization.
 */
async function loadContext(
  ctx: AppContext,
  interaction: ComponentInteraction,
  draftIdArg: string | undefined,
): Promise<{ draft: DraftRecord; group: GroupRecord }> {
  if (draftIdArg === undefined) throw new DomainError('INVALID_INPUT');
  return draftService.loadDraftContext(ctx, fromBase36(draftIdArg), interaction.user.id);
}

// ---------------------------------------------------------------------------
// Stage 0 - the quick-out DM buttons (group id, not draft id, in the args)
// ---------------------------------------------------------------------------

async function handleOptOut(
  interaction: ComponentInteraction,
  ctx: AppContext,
  groupIdArg: string | undefined,
): Promise<void> {
  if (groupIdArg === undefined) throw new DomainError('INVALID_INPUT');
  const groupId = fromBase36(groupIdArg);

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId,
  });
  const week = currentWeek(ctx, actor.group.timezone);

  await interaction.deferUpdate();
  await optOut(ctx, { userId: actor.user.id, groupId, weekStartDate: week });

  // One tap, no follow-up questions. The single remaining button is the way
  // back in - without it, opting out in a DM is a dead end.
  await interaction.editReply(
    optedOutView({ groupId, groupName: actor.group.name, weekStartDate: week }),
  );
}

async function handleOptIn(
  interaction: ComponentInteraction,
  ctx: AppContext,
  groupIdArg: string | undefined,
): Promise<void> {
  if (groupIdArg === undefined) throw new DomainError('INVALID_INPUT');
  const groupId = fromBase36(groupIdArg);

  const actor = await resolveMemberByDiscordId(ctx, {
    discordUserId: interaction.user.id,
    groupId,
  });
  const week = currentWeek(ctx, actor.group.timezone);

  await interaction.deferUpdate();
  const { draft } = await startOrResumeFlow(ctx, {
    userId: actor.user.id,
    groupId,
    weekStartDate: week,
  });

  await interaction.editReply(renderSinglePrompt(draft, actor.group));
}

// ---------------------------------------------------------------------------
// Stage A / B
// ---------------------------------------------------------------------------

async function handleDaysSelected(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  if (!interaction.isStringSelectMenu()) throw new DomainError('INVALID_INPUT');

  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);

  const days = interaction.values.map(Number).filter(isDay) as Day[];
  const updated = await draftService.setDays(ctx, draft, days);

  await interaction.editReply(renderSinglePrompt(updated, group));
}

async function handleWindowsSelected(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  if (!interaction.isStringSelectMenu()) throw new DomainError('INVALID_INPUT');

  const dayArg = Number(parsed.args[1]);
  if (!isDay(dayArg)) throw new DomainError('INVALID_INPUT');

  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);

  const windows = interaction.values.filter(isWindow) as Window[];
  const updated = await draftService.setWindowsForDay(ctx, draft, dayArg, windows);

  // Stay on the page the member is looking at.
  await interaction.editReply(
    renderWindowPage(updated, group, draftService.pageForDay(updated.state, dayArg)),
  );
}

async function handlePage(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);
  const page = draftService.clampPage(draft.state, Number(parsed.args[1] ?? 0));
  await interaction.editReply(renderWindowPage(draft, group, page));
}

async function handleBackToDays(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);
  await interaction.editReply(renderDayPicker(draft, group));
}

async function handleCopyToAll(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  const sourceDay = Number(parsed.args[1]);
  if (!isDay(sourceDay)) throw new DomainError('INVALID_INPUT');

  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);
  const updated = await draftService.copyWindowsToAllDays(ctx, draft, sourceDay);

  await interaction.editReply(
    renderWindowPage(updated, group, draftService.pageForDay(updated.state, sourceDay)),
  );
}

async function handleDone(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);

  if (draftService.totalSlotCount(draft.state) === 0) {
    await interaction.editReply(
      noWindowsChosenView({
        draftId: draft.id,
        groupName: group.name,
        timezone: group.timezone,
        weekStartDate: draft.weekStartDate,
        days: draftService.selectedDays(draft.state),
        windowsByDay: draft.state.windows ?? {},
      }),
    );
    return;
  }

  await interaction.editReply(renderSinglePrompt(draft, group));
}

/** Opens the per-day picker, seeded so nothing the member already said is lost. */
async function handlePerDay(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);
  const seeded = await draftService.seedPerDayWindows(ctx, draft);

  await interaction.editReply(renderWindowPage(seeded, group, 0));
}

/** Row 2 of the single prompt: windows that apply to every chosen day. */
async function handleSimpleWindows(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  if (!interaction.isStringSelectMenu()) throw new DomainError('INVALID_INPUT');

  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);

  const windows = interaction.values.filter(isWindow) as Window[];
  const updated = await draftService.setSimpleWindows(ctx, draft, windows);

  await interaction.editReply(renderSinglePrompt(updated, group));
}

// ---------------------------------------------------------------------------
// Capacity, vibe, submit
// ---------------------------------------------------------------------------

async function handleCapacity(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  // A select in the single prompt, a button in the older staged view: accept
  // both so a message already sitting in someone's DM keeps working.
  const capacity = interaction.isStringSelectMenu()
    ? Number(interaction.values[0])
    : Number(parsed.args[1]);
  if (!isCapacity(capacity)) throw new DomainError('INVALID_INPUT');

  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);
  const updated = await draftService.setCapacity(ctx, draft, capacity);

  await interaction.editReply(renderSinglePrompt(updated, group));
}

async function handleVibe(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  if (!interaction.isStringSelectMenu()) throw new DomainError('INVALID_INPUT');

  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);
  const updated = await draftService.setVibes(ctx, draft, interaction.values as VibeTag[]);

  await interaction.editReply(renderSinglePrompt(updated, group));
}

async function handleSubmit(
  interaction: ComponentInteraction,
  ctx: AppContext,
  parsed: ParsedCustomId,
): Promise<void> {
  await interaction.deferUpdate();
  const { draft, group } = await loadContext(ctx, interaction, parsed.args[0]);

  const capacity = draftService.chosenCapacity(draft.state);
  if (capacity === undefined) {
    // Should be unreachable - Submit renders disabled without availability -
    // but the service is the authority, not the button state.
    await interaction.editReply(renderSinglePrompt(draft, group));
    return;
  }

  const slots = draftService.toSlotRows(draft.state);
  const vibes = draftService.chosenVibes(draft.state);

  await submit(ctx, {
    userId: draft.userId,
    groupId: draft.groupId,
    weekStartDate: draft.weekStartDate,
    sessionsCommitted: capacity,
    slots,
    vibes,
    draftId: draft.id,
  });

  await interaction.editReply(
    submittedView({
      groupName: group.name,
      weekStartDate: draft.weekStartDate,
      capacity,
      slotCount: slots.length,
      dayCount: draftService.daysWithWindows(draft.state).length,
      vibes,
    }),
  );
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handle(
  interaction: ComponentInteraction,
  parsed: ParsedCustomId,
  ctx: AppContext,
): Promise<void> {
  switch (parsed.action) {
    case 'optout':
      return handleOptOut(interaction, ctx, parsed.args[0]);
    case 'in':
      return handleOptIn(interaction, ctx, parsed.args[0]);
    case 'perday':
      return handlePerDay(interaction, ctx, parsed);
    case 'simplewin':
      return handleSimpleWindows(interaction, ctx, parsed);
    case 'days':
      return handleDaysSelected(interaction, ctx, parsed);
    case 'win':
      return handleWindowsSelected(interaction, ctx, parsed);
    case 'page':
      return handlePage(interaction, ctx, parsed);
    case 'daypick':
      return handleBackToDays(interaction, ctx, parsed);
    case 'copy':
      return handleCopyToAll(interaction, ctx, parsed);
    case 'done':
      return handleDone(interaction, ctx, parsed);
    case 'cap':
      return handleCapacity(interaction, ctx, parsed);
    case 'vibe':
      return handleVibe(interaction, ctx, parsed);
    case 'submit':
      return handleSubmit(interaction, ctx, parsed);
    default:
      ctx.logger.warn('unknown availability action', { action: parsed.action });
  }
}

registerComponentHandler('av', handle);
