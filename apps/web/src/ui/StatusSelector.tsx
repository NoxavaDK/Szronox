import type { StatusTabView } from './screen-contracts.js';
import type { ReelStatus } from '@szronox/contracts';
import styles from './StatusSelector.module.css';

/** Horizontal status selector with a cobalt underline; scrolls on narrow screens. */
export function StatusSelector({
  tabs,
  selected,
  onSelect,
}: {
  tabs: StatusTabView[];
  selected: ReelStatus;
  onSelect: (status: ReelStatus) => void;
}) {
  return (
    <div className={styles.selector} role="tablist" aria-label="Filtr statusu">
      {tabs.map((tab) => (
        <button
          key={tab.status}
          type="button"
          role="tab"
          aria-selected={tab.status === selected}
          className={styles.tab}
          onClick={() => onSelect(tab.status)}
        >
          {tab.label}
          {typeof tab.count === 'number' ? <span className={styles.count}>{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
