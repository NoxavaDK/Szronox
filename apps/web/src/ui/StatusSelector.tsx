import type { StatusTabView } from './screen-contracts.js';
import type { ReelStatus } from '@szronox/contracts';
import styles from './StatusSelector.module.css';

/** One compact, explicitly labelled list filter. `Wszystkie` is a view, never a Reel state. */
export function StatusSelector({
  tabs,
  selected,
  onSelect,
}: {
  tabs: StatusTabView[];
  selected: ReelStatus | 'all';
  onSelect: (status: ReelStatus | 'all') => void;
}) {
  return (
    <label className={styles.filter}>
      <span>Status</span>
      <select aria-label="Filtr statusu" value={selected} onChange={(event) => onSelect(event.target.value as ReelStatus | 'all')}>
        {tabs.map((tab) => <option key={tab.status} value={tab.status}>{tab.label}{typeof tab.count === 'number' ? ` · ${tab.count}` : ''}</option>)}
      </select>
    </label>
  );
}
