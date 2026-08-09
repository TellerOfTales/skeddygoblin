/**
 * Domain errors carry a stable machine-readable code so the Discord layer can
 * map them to user-facing copy without string-matching messages.
 */

export const DOMAIN_ERROR_CODES = [
  // membership / setup
  'GROUP_NOT_FOUND',
  'GROUP_NOT_CONFIGURED',
  'USER_NOT_FOUND',
  'ACTOR_NOT_MEMBER',
  'TARGET_NOT_MEMBER',
  'NOT_ORGANIZER',

  // weekly flow
  'DRAFT_NOT_FOUND',
  'DRAFT_NOT_OWNED',
  'ALREADY_SUBMITTED',
  'NO_DAYS_SELECTED',
  'NO_CAPACITY_SELECTED',

  // buzz
  'SELF_BUZZ',
  'ALREADY_RESPONDED',
  'RATE_LIMITED',
  'DELIVERY_FAILED',

  // sessions
  'PROPOSAL_NOT_FOUND',
  'PROPOSAL_CLOSED',

  // stage 2
  'STEAM_NOT_LINKED',
  'STEAM_PROFILE_PRIVATE',

  // generic
  'INVALID_INPUT',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: DomainErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/** Thrown by scaffolded-but-unbuilt implementations (e.g. TwilioSMSNotifier). */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}
