import type { Priority } from '@szronox/contracts';

/**
 * TypeScript mirror of tokens.css for values components need in JS (not just CSS),
 * e.g. choosing an icon variant or a semantic colour by domain value. Keep this in
 * sync with tokens.css by hand; there are few enough tokens that generating one
 * from the other is not worth the build-time coupling.
 */
export const colors = {
  background: '#F7F7F5',
  surface: '#FFFFFF',
  textPrimary: '#171717',
  textSecondary: '#636360',
  cobalt: '#315BD8',
  divider: '#E4E4E1',
  urgent: '#B42332',
  evergreen: '#216B58',
  programme: '#2E633D',
  warning: '#8A570C',
  success: '#2F6B50',
} as const;

/** Priority row markers: "Normalne may use a small cobalt marker. Pilne red. Evergreen teal." */
export const priorityColor: Record<Priority, string> = {
  urgent: colors.urgent,
  normal: colors.cobalt,
  evergreen: colors.evergreen,
};

export const priorityLabel: Record<Priority, string> = {
  urgent: 'Pilne',
  normal: 'Normalne',
  evergreen: 'Evergreen',
};

export const touchTargetPx = 44;
