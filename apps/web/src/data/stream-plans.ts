/**
 * STREAM-PLAN-01 (web): pure helpers for the stream screen — building a topic from a picked
 * Reel, the editable document sent on autosave, and the client-side checks that keep autosave
 * from sending a half-typed link. Nothing here fetches; `StreamPlansScreen.tsx` owns the calls.
 *
 * No sibling *value* imports, for the same reason as `streams.ts`: the plain Node test runner
 * resolves only `import type` across these modules.
 */
import type {
  StreamPlan, StreamPlanCandidate, StreamPlanTopic, StreamPlanTopicView, UpdateStreamPlanRequest,
} from '../../../../packages/contracts/src/index.js';

/** T00 STREAM-PLAN-01 limits, mirrored from the API. */
export const PLAN_LIMITS = {
  title: 120, topics: 8, topicTitle: 180, extraLinks: 11, linkLabel: 120, link: 2000, points: 12, point: 200,
} as const;

export const SSN_DOCK = 'https://socialstream.ninja/dock.html';

/** The editable part of a plan, as the screen holds it between saves. */
export interface PlanDraft {
  title: string;
  scheduledFor: string;
  commentsSession: string;
  topics: StreamPlanTopicView[];
}

export function draftOf(plan: StreamPlan): PlanDraft {
  return { title: plan.title, scheduledFor: plan.scheduledFor ?? '', commentsSession: plan.commentsSession ?? '', topics: plan.topics };
}

/** The main link a picked Reel brings along: its article link, else the link it was captured from. */
export function mainLinkOf(candidate: Pick<StreamPlanCandidate, 'sourceLink' | 'originalInput'>): string | null {
  const link = candidate.sourceLink ?? candidate.originalInput?.url ?? null;
  return link && /^https?:\/\//i.test(link.trim()) ? link.trim() : null;
}

/** Fit a label into a broadcast title (≤ 180), on a word boundary where possible. */
export function broadcastTitle(label: string): string {
  const collapsed = label.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PLAN_LIMITS.topicTitle) return collapsed;
  const cut = collapsed.slice(0, PLAN_LIMITS.topicTitle - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 120 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function topicFromCandidate(candidate: StreamPlanCandidate, label: string, id: string): StreamPlanTopicView {
  return {
    id, reelId: candidate.id, title: broadcastTitle(label) || 'Temat', mainLink: mainLinkOf(candidate), extraLinks: [], points: [],
    reel: { id: candidate.id, status: candidate.status, deleted: false },
  };
}

export function blankTopic(id: string): StreamPlanTopicView {
  return { id, reelId: null, title: '', mainLink: null, extraLinks: [], points: [], reel: null };
}

export function isLink(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length > PLAN_LIMITS.link) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Accepts a Social Stream Ninja session ID or any SSN link carrying `?session=`, since the app
 * shows the ID inside links. Returns the bare ID, '' for empty input, or null when unusable.
 */
export function sessionFrom(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return '';
  let candidate = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try { candidate = new URL(trimmed).searchParams.get('session') ?? ''; } catch { return null; }
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate) ? candidate : null;
}

export function dockUrl(session: string): string {
  return `${SSN_DOCK}?session=${encodeURIComponent(session)}`;
}

/** Polish messages for what blocks a save; empty when the draft can be sent. */
export function draftProblems(draft: PlanDraft): string[] {
  const problems: string[] = [];
  if (draft.title.trim() === '') problems.push('Wpisz tytuł streamu.');
  if (draft.title.trim().length > PLAN_LIMITS.title) problems.push(`Tytuł streamu może mieć do ${PLAN_LIMITS.title} znaków.`);
  if (sessionFrom(draft.commentsSession) === null) problems.push('ID sesji Social Stream Ninja: tylko litery, cyfry, - i _.');
  draft.topics.forEach((topic, index) => {
    const n = index + 1;
    if (topic.title.trim() === '') problems.push(`Temat ${n}: wpisz tytuł.`);
    if (topic.title.trim().length > PLAN_LIMITS.topicTitle) problems.push(`Temat ${n}: tytuł może mieć do ${PLAN_LIMITS.topicTitle} znaków.`);
    if (topic.mainLink && topic.mainLink.trim() !== '' && !isLink(topic.mainLink)) problems.push(`Temat ${n}: główny link musi zaczynać się od https://.`);
    topic.extraLinks.forEach((link, position) => {
      if (link.url.trim() !== '' && !isLink(link.url)) problems.push(`Temat ${n}: link ${position + 1} musi zaczynać się od https://.`);
    });
    if (topic.points.some((point) => point.trim().length > PLAN_LIMITS.point)) problems.push(`Temat ${n}: punkt może mieć do ${PLAN_LIMITS.point} znaków.`);
  });
  return problems;
}

/**
 * The PUT body for a draft that passed `draftProblems`. Empty extra links (a row just added)
 * are left out; blank points are sent and dropped by the API, so the editor keeps its empty row.
 */
export function requestOf(draft: PlanDraft, operationId: string, expectedVersion: number): UpdateStreamPlanRequest {
  const topics: StreamPlanTopic[] = draft.topics.map(({ id, reelId, title, mainLink, extraLinks, points }) => ({
    id,
    reelId,
    title: title.trim(),
    mainLink: mainLink && mainLink.trim() !== '' ? mainLink.trim() : null,
    extraLinks: extraLinks.filter((link) => link.url.trim() !== '').map((link) => ({ url: link.url.trim(), label: link.label.trim() })),
    points,
  }));
  return {
    operationId, expectedVersion, title: draft.title.trim(), scheduledFor: draft.scheduledFor || null,
    commentsSession: sessionFrom(draft.commentsSession) || null, topics,
  };
}

/** Swap a topic with its neighbour; out-of-range moves return the list unchanged. */
export function moveTopic<T>(topics: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= topics.length || target < 0 || target >= topics.length) return [...topics];
  const next = [...topics];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

const dateFormat = new Intl.DateTimeFormat('pl-PL', { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' });
export function planDateLabel(date: string | null): string {
  if (!date) return 'Bez daty';
  return dateFormat.format(new Date(`${date}T00:00:00Z`));
}
