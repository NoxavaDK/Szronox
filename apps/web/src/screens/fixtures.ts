/**
 * Fixture data for local development/visual inspection of the T06 screens.
 * Not consumed by any production entry point; T08 supplies real props from
 * wire data. Shapes are deliberately realistic (multi-word titles, missing
 * optional fields, long text) to stress the same layout edge cases real data
 * will hit.
 */
import type {
  EditorView,
  HookView,
  PublicationLinkView,
  ReelDetailMetadataView,
  ReelListItemView,
  StatusTabView,
} from '../ui/screen-contracts.js';

export const fixtureCurrentUser: EditorView = { id: 'u-noxava', name: 'NOXAVA', avatarUrl: null };
export const fixtureOtherUser: EditorView = { id: 'u-szron', name: 'SZRON', avatarUrl: null };

export const fixtureStatusTabs: StatusTabView[] = [
  { status: 'idea', label: 'Pomysły', count: 12 },
  { status: 'to_record', label: 'Do nagrania', count: 5 },
  { status: 'editing', label: 'Montaż', count: 3 },
  { status: 'ready', label: 'Gotowe' },
  { status: 'published', label: 'Opublikowane' },
];

export const fixtureListItems: ReelListItemView[] = [
  {
    id: 'r-1',
    title: 'Maszyniści zwalniają tempo przed protestem',
    priority: 'urgent',
    editor: fixtureOtherUser,
    isOverdue: true,
    elapsedLabel: null,
    verificationState: null,
    programmeState: 'matched',
    memeName: 'Pociąg jedzie',
    feedCoverDone: false,
  },
  {
    id: 'r-2',
    title: 'Podsumowanie tygodnia w Sejmie',
    priority: 'normal',
    editor: fixtureCurrentUser,
    isOverdue: false,
    elapsedLabel: '26 godz. w montażu',
    verificationState: 'outdated',
    programmeState: 'unchecked',
    memeName: null,
    feedCoverDone: true,
  },
  {
    id: 'r-3',
    title: 'Rozmowa z rolnikami o dopłatach',
    priority: 'evergreen',
    editor: null,
    isOverdue: false,
    elapsedLabel: null,
    verificationState: 'verified',
    programmeState: 'no_match',
    memeName: null,
    feedCoverDone: false,
  },
];

export const fixtureHooks: HookView[] = [
  { id: 'h-1', text: 'Ten pociąg nie zwalnia dla nikogo', source: 'user', position: 0 },
  { id: 'h-2', text: 'Co się stanie, gdy maszyniści powiedzą dość?', source: 'ai', position: 1 },
];

export const fixtureDetailMetadata: ReelDetailMetadataView = {
  status: 'editing',
  statusLabel: 'Montaż',
  priority: 'urgent',
  editor: fixtureOtherUser,
  programmeState: 'matched',
  memeName: 'Pociąg jedzie',
  feedCoverDone: false,
  verificationState: null,
};

export const fixturePublicationLinks: PublicationLinkView[] = [
  { id: 'pl-1', url: 'https://instagram.com/p/abc123' },
];
