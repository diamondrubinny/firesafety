import { CATEGORY_LABELS_HE, type PointCategory } from '@firesafety/shared';

/** Shape + text, so meaning never depends on colour alone. */
const SYMBOL: Record<PointCategory, string> = {
  fire: '▲',
  prealarm: '△',
  fault: '■',
  supervisory: '●',
  disabled: '⊘',
  test: '◆',
  normal: '✓',
};

export function CategoryBadge({ category }: { category: PointCategory }) {
  return (
    <span className={`cat cat-${category}`}>
      <span aria-hidden="true">{SYMBOL[category]} </span>
      {CATEGORY_LABELS_HE[category]}
    </span>
  );
}
