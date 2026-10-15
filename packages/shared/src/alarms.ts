/**
 * Alarm categories and the BACnet → category policy.
 * The collector forwards raw BACnet values; classification happens here so
 * that policy lives in one tested place.
 *
 * The mapping is a draft that requires verification against the Siemens
 * panel's BACnet object documentation (PICS / object list).
 */
export const ALARM_CATEGORIES = ['fire', 'prealarm', 'fault', 'supervisory', 'disabled', 'test'] as const;
export type AlarmCategory = (typeof ALARM_CATEGORIES)[number];
export type PointCategory = AlarmCategory | 'normal';

/** Lower number = more urgent. */
export const CATEGORY_PRIORITY: Record<AlarmCategory, number> = {
  fire: 1,
  prealarm: 2,
  fault: 3,
  supervisory: 4,
  disabled: 5,
  test: 6,
};

export const CATEGORY_LABELS_HE: Record<PointCategory, string> = {
  fire: 'אש',
  prealarm: 'קדם-אזעקה',
  fault: 'תקלה',
  supervisory: 'פיקוח',
  disabled: 'מנוטרל',
  test: 'בדיקה',
  normal: 'תקין',
};

/** Synthetic alarm kinds raised by the server itself. */
export const ALARM_KINDS = ['point', 'device_comm', 'collector_comm'] as const;
export type AlarmKind = (typeof ALARM_KINDS)[number];

const LS_FIRE = new Set(['alarm', 'fault-alarm', 'local-alarm', 'general-alarm']);
const LS_PREALARM = new Set(['pre-alarm', 'fault-pre-alarm']);
const LS_FAULT = new Set(['fault', 'tamper', 'tamper-alarm']);
const LS_SUPERVISORY = new Set([
  'supervisory',
  'active',
  'abnormal',
  'not-ready',
  'delayed',
  'blocked',
  'emergency-power',
  'holdup',
  'duress',
]);
const ES_SUPERVISORY = new Set(['offnormal', 'high-limit', 'low-limit', 'change-of-state']);

export interface PointStateInput {
  eventState?: string | null;
  lifeSafetyState?: string | null;
  outOfService?: boolean | null;
  reliability?: string | null;
  mode?: string | null;
}

/**
 * Most-severe-wins classification. Fire always wins, so a fire is never
 * hidden behind a fault, disable or test flag reported by the same object.
 */
export function categorize(s: PointStateInput): PointCategory {
  const ls = s.lifeSafetyState ?? undefined;
  const es = s.eventState ?? undefined;

  if ((ls && LS_FIRE.has(ls)) || es === 'life-safety-alarm') return 'fire';
  if (ls && LS_PREALARM.has(ls)) return 'prealarm';
  if (ls?.startsWith('test-')) return 'test';
  if (s.outOfService || s.mode === 'disabled' || s.mode === 'off') return 'disabled';
  if ((ls && LS_FAULT.has(ls)) || es === 'fault' || (s.reliability && s.reliability !== 'no-fault-detected')) {
    return 'fault';
  }
  if ((ls && LS_SUPERVISORY.has(ls)) || (es && ES_SUPERVISORY.has(es))) return 'supervisory';
  // An event state we do not recognise must not be silently treated as normal.
  if (es && es !== 'normal') return 'supervisory';
  return 'normal';
}
