import { describe, expect, it } from 'vitest';
import { categorize } from '@firesafety/shared';

describe('categorize', () => {
  it.each([
    [{ lifeSafetyState: 'quiet', eventState: 'normal' }, 'normal'],
    [{ lifeSafetyState: 'alarm' }, 'fire'],
    [{ lifeSafetyState: 'general-alarm' }, 'fire'],
    [{ eventState: 'life-safety-alarm' }, 'fire'],
    [{ lifeSafetyState: 'pre-alarm' }, 'prealarm'],
    [{ lifeSafetyState: 'fault' }, 'fault'],
    [{ eventState: 'fault' }, 'fault'],
    [{ eventState: 'normal', reliability: 'communication-failure' }, 'fault'],
    [{ lifeSafetyState: 'supervisory' }, 'supervisory'],
    [{ eventState: 'offnormal' }, 'supervisory'],
    [{ lifeSafetyState: 'quiet', outOfService: true }, 'disabled'],
    [{ lifeSafetyState: 'quiet', mode: 'disabled' }, 'disabled'],
    [{ lifeSafetyState: 'test-alarm' }, 'test'],
    [{}, 'normal'],
  ])('%j -> %s', (input, expected) => {
    expect(categorize(input)).toBe(expected);
  });

  it('fire always wins over disabled, fault or contradictory flags', () => {
    expect(categorize({ lifeSafetyState: 'alarm', outOfService: true })).toBe('fire');
    expect(categorize({ lifeSafetyState: 'quiet', eventState: 'life-safety-alarm', outOfService: true })).toBe('fire');
    expect(categorize({ lifeSafetyState: 'fault-alarm', reliability: 'open-loop' })).toBe('fire');
  });

  it('never treats an unknown abnormal event state as normal', () => {
    expect(categorize({ eventState: 'some-future-state' })).toBe('supervisory');
  });
});
