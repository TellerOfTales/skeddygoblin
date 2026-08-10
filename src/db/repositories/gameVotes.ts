import type { Queryable } from '../pool.js';
import type { UserId } from './types.js';

export interface GameVoteRecord {
  id: number;
  proposalId: number;
  appId: number | null;
  gameName: string;
}

interface VoteRow {
  id: number;
  proposal_id: number;
  app_id: number | null;
  game_name: string;
}

function toRecord(row: VoteRow): GameVoteRecord {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    appId: row.app_id,
    gameName: row.game_name,
  };
}

/** Idempotent per (proposal, game name), so two people nominating the same
 * game produce one option with two votes rather than two identical options. */
export async function createGameVote(
  db: Queryable,
  params: {
    proposalId: number;
    gameName: string;
    appId: number | null;
    nominatedBy: UserId | null;
  },
): Promise<GameVoteRecord> {
  const result = await db.query<VoteRow>(
    `INSERT INTO game_vote (proposal_id, game_name, app_id, nominated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (proposal_id, game_name)
     DO UPDATE SET app_id = COALESCE(game_vote.app_id, EXCLUDED.app_id)
     RETURNING id, proposal_id, app_id, game_name`,
    [params.proposalId, params.gameName, params.appId, params.nominatedBy],
  );
  return toRecord(result.rows[0]!);
}

export async function findGameVoteById(db: Queryable, id: number): Promise<GameVoteRecord | null> {
  const result = await db.query<VoteRow>(
    `SELECT id, proposal_id, app_id, game_name FROM game_vote WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

export async function castVote(db: Queryable, voteId: number, userId: UserId): Promise<void> {
  await db.query(
    `INSERT INTO game_vote_cast (vote_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [voteId, userId],
  );
}

/** Adds or removes the caller's vote. Returns true if it is now cast. */
export async function toggleVote(db: Queryable, voteId: number, userId: UserId): Promise<boolean> {
  const removed = await db.query(`DELETE FROM game_vote_cast WHERE vote_id = $1 AND user_id = $2`, [
    voteId,
    userId,
  ]);
  if ((removed.rowCount ?? 0) > 0) return false;

  await castVote(db, voteId, userId);
  return true;
}

/**
 * Options with vote COUNTS, plus whether the caller has voted.
 *
 * A hybrid, deliberately: the counts are aggregate, and `votedByMe` is
 * self-scoped BY CONSTRUCTION - the SQL compares only against $2, the caller's
 * own id, so there is no argument that would make it report how anyone else
 * voted. The parameter is named selfUserId so that guarantee is greppable.
 */
export async function listOptionsAggregate(
  db: Queryable,
  proposalId: number,
  selfUserId: UserId,
): Promise<
  Array<{
    voteId: number;
    appId: number | null;
    gameName: string;
    votes: number;
    votedByMe: boolean;
    priceCents: number | null;
    priceCentsUsd: number | null;
    currency: string | null;
    storeUrl: string | null;
  }>
> {
  const result = await db.query<{
    id: number;
    app_id: number | null;
    game_name: string;
    votes: number;
    voted_by_me: boolean;
    price_cents: number | null;
    price_cents_usd: number | null;
    currency: string | null;
    store_url: string | null;
  }>(
    `SELECT
       v.id,
       v.app_id,
       v.game_name,
       COUNT(c.user_id)::bigint AS votes,
       bool_or(c.user_id = $2) IS TRUE AS voted_by_me,
       m.price_cents,
       m.price_cents_usd,
       m.currency,
       m.store_url
     FROM game_vote v
     LEFT JOIN game_vote_cast c ON c.vote_id = v.id
     LEFT JOIN steam_app_meta m ON m.app_id = v.app_id
     WHERE v.proposal_id = $1
     GROUP BY v.id, v.app_id, v.game_name, m.price_cents, m.price_cents_usd,
              m.currency, m.store_url
     ORDER BY votes DESC, v.game_name ASC`,
    [proposalId, selfUserId],
  );

  return result.rows.map((row) => ({
    voteId: row.id,
    appId: row.app_id,
    gameName: row.game_name,
    votes: row.votes,
    votedByMe: row.voted_by_me,
    priceCents: row.price_cents,
    priceCentsUsd: row.price_cents_usd,
    currency: row.currency,
    storeUrl: row.store_url,
  }));
}
