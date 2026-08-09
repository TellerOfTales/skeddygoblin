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
import { isDay, isWindow, type Day, type Window } from '../../domain/constants.js';
import { fromBase36, type ParsedCustomId } from '../customId.js';
import type { ComponentInteraction } from './index.js';
import { registerComponentHandler } from './index.js';
import type { AppContext } from '../../services/context.js';
import { resolveMemberByDiscordId } from '../../services/membershipService.js';
import { currentWeek, optOut, startOrResumeFlow } from '../../services/responseService.js';
import * as draftService from '../../services/draftService.js';
import type { DraftRecord, GroupRecord } from '../../services/types.js';
import {
  dayPickerView,
  noWindowsChosenView,
  optedOutView,
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

  // One tap, no follow-up questions, components stripped so it is visibly over.
  await interaction.editReply(optedOutView({ groupName: actor.group.name, weekStartDate: week }));
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

  await interaction.editReply(renderDayPicker(draft, actor.group));
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

  await interaction.editReply(renderWindowPage(updated, group, 0));
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

  // Step 4 replaces this with the capacity + vibe screen and the atomic submit.
  await interaction.editReply({
    content: [
      `**Got it — ${draftService.totalSlotCount(draft.state)} windows across ` +
        `${draftService.daysWithWindows(draft.state).length} days.**`,
      '',
      'Capacity and vibe land in the next build step.',
    ].join('\n'),
    components: [],
  });
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
    default:
      ctx.logger.warn('unknown availability action', { action: parsed.action });
  }
}

registerComponentHandler('av', handle);
