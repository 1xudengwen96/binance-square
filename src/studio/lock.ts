import type { Material } from '../material/types.ts';
import type { Store } from '../db/index.ts';
import type { Track } from './tracks.ts';
import { findRefusals, trackById } from './tracks.ts';
import { CONCEPTS } from './concepts.ts';

/**
 * The persona lock.
 *
 * The source guide's warning about this lane is specific: the failure is not a bad post, it
 * is a *mixed* timeline — "今天严肃喊单，明天整活，后天又变老师。读者不知道该信哪一个你。"
 * Nothing in a per-post quality check catches that, because each individual post passes.
 * Only the account-level invariant does, so it is enforced here rather than left to the
 * operator's restraint.
 *
 * Two invariants, both checked before anything reaches the network:
 *   1. an account bound to a track can only produce content from that track's concept list;
 *   2. while the studio owns an account, the main mixed-style matrix does not post through it.
 *
 * The second is the one that would otherwise be missed. A teaching account that also picks
 * up three 段子手 posts a day from the general queue is not a teaching account, and nothing
 * in either module's own logic would notice.
 */

export interface LockVerdict {
  ok: boolean;
  reasons: string[];
}

export function assertCategoryAllowed(track: Track, material: Material): LockVerdict {
  if (track.allowedCategories.includes(material.category)) return { ok: true, reasons: [] };
  return { ok: false, reasons: [`赛道「${track.label}」不发「${material.category}」类内容（不在白名单）`] };
}

export function assertConceptInTrack(track: Track, conceptId: string): LockVerdict {
  const concept = CONCEPTS.find(c => c.id === conceptId);
  if (!concept) return { ok: false, reasons: [`概念 ${conceptId} 未定义`] };
  if (concept.trackId !== track.id) return { ok: false, reasons: [`概念「${concept.title}」属于 ${concept.trackId}，不属于本账号赛道`] };
  return { ok: true, reasons: [] };
}

/**
 * Refusals are checked twice: on the composed draft and again after LLM polish.
 *
 * The second pass is the one that matters. The polish layer is licensed to reword freely,
 * and rewording is precisely how "这个费率说明空头在付代价" drifts into "所以别做空" — a
 * change of speech act, not of vocabulary, that no word list on the template catches.
 */
export function assertTextOnTrack(track: Track, text: string, stage: 'compose' | 'polish'): LockVerdict {
  const hits = findRefusals(text, track);
  if (!hits.length) return { ok: true, reasons: [] };
  return { ok: false, reasons: hits.map(h => `[${stage}] ${h}`) };
}

/** Every gate in one call, so no caller can forget one by accident. */
export function checkPublication(track: Track, material: Material, conceptId: string, text: string): LockVerdict {
  const parts = [assertCategoryAllowed(track, material), assertConceptInTrack(track, conceptId), assertTextOnTrack(track, text, 'compose')];
  const reasons = parts.flatMap(p => p.reasons);
  return { ok: reasons.length === 0, reasons };
}

/* ---------------------------------------------------------------- ownership --- */

export function studioAccountIds(store: Store): Set<number> {
  return new Set(store.studioAccounts().filter(a => a.enabled && a.pause_matrix).map(a => a.account_id));
}

/**
 * Accounts the mixed-style matrix may use.
 *
 * This is the whole of the isolation between the two systems on the publishing side: one
 * predicate, applied where the matrix picks its owners. Without it a bound account would
 * keep drawing short-form posts in a second voice, and the track would be undone by the
 * module that was never supposed to touch it.
 */
export function matrixEligibleAccounts(store: Store) {
  const owned = studioAccountIds(store);
  return store.activeAccounts().filter(a => !owned.has(a.id));
}

export function trackForAccount(store: Store, accountId: number): Track | undefined {
  const binding = store.studioBinding(accountId);
  return binding ? trackById(binding.track_id) : undefined;
}
