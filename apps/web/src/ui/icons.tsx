/**
 * Compact production-quality SVG icons. Frozen visual language: thin strokes,
 * currentColor, no gradients/glow. Kept intentionally small in number — only
 * what sections 2/3/4/6 of frozen-visual-spec.md actually need.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base(size: number, props: IconProps) {
  const { size: _size, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 18, props)}>
      <path d="M7.5 4.5 13 10l-5.5 5.5" />
    </svg>
  );
}

export function BackArrowIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 20, props)}>
      <path d="M12.5 4.5 6 10l6.5 5.5" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 20, props)}>
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  );
}

export function OverflowIcon(props: IconProps) {
  const size = props.size ?? 18;
  return (
    <svg {...base(size, props)} strokeWidth={0} fill="currentColor">
      <circle cx="4.5" cy="10" r="1.4" />
      <circle cx="10" cy="10" r="1.4" />
      <circle cx="15.5" cy="10" r="1.4" />
    </svg>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 16, props)}>
      <path d="M8 5h7v7" />
      <path d="M15 5 5.5 14.5" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 14, props)}>
      <path d="M4 10.5 8 14l8-9" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 14, props)}>
      <path d="M5 5l10 10M15 5 5 15" />
    </svg>
  );
}

/** Compact outline landscape/image pictogram used for the feed-cover state. */
export function CoverPictogramIcon(props: IconProps & { done?: boolean }) {
  const { done, ...rest } = props;
  return (
    <svg {...base(rest.size ?? 20, rest)}>
      <rect x="3" y="4.5" width="14" height="11" rx="1.5" />
      <circle cx="7.3" cy="8.5" r="1.15" fill="currentColor" stroke="none" />
      <path d="M4 13.5 8 10l3 2.3 2-1.8L17 13" />
      {done ? (
        <g>
          <circle cx="15.5" cy="5.5" r="3.4" fill="var(--sz-color-success)" stroke="none" />
          <path d="M14 5.6l1 1 1.7-1.9" stroke="#fff" strokeWidth={1.4} />
        </g>
      ) : null}
    </svg>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 15, props)}>
      <path d="M10 3.5 17.3 16H2.7L10 3.5Z" />
      <path d="M10 8.3v3.3" />
      <circle cx="10" cy="13.6" r="0.15" fill="currentColor" />
    </svg>
  );
}

/** Publication plan (CONTENT-PLANNER-01): a plain outline calendar sheet. */
export function CalendarIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 16, props)}>
      <rect x="3.5" y="4.5" width="13" height="12" rx="1.5" />
      <path d="M3.5 8.5h13M7 3v3M13 3v3" />
    </svg>
  );
}

/**
 * STREAM-01 (D1): the stream marker — a plain outline "broadcast" pictogram (a dot with two
 * concentric signal arcs), stroke matching the feed-cover pictogram style. Always paired with
 * the word "Stream" wherever it appears; never shown alone as the only signal.
 */
export function BroadcastIcon(props: IconProps) {
  return (
    <svg {...base(props.size ?? 16, props)}>
      <circle cx="10" cy="13.6" r="1.25" fill="currentColor" stroke="none" />
      <path d="M7 11.4a4.3 4.3 0 0 1 6 0" />
      <path d="M4.4 8.9a7.9 7.9 0 0 1 11.2 0" />
    </svg>
  );
}
