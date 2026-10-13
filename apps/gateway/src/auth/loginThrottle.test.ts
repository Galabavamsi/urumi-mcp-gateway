import { describe, expect, it } from 'vitest';
import { LoginThrottle } from './loginThrottle.ts';

describe('LoginThrottle', () => {
  it('blocks after 5 failures within the window and frees the key afterwards', () => {
    let now = 0;
    const throttle = new LoginThrottle(5, 1000, () => now);
    for (let i = 0; i < 4; i++) throttle.recordFailure('a@x');
    expect(throttle.isBlocked('a@x')).toBe(false);
    throttle.recordFailure('a@x');
    expect(throttle.isBlocked('a@x')).toBe(true);
    expect(throttle.isBlocked('b@x')).toBe(false);
    now = 1001;
    expect(throttle.isBlocked('a@x')).toBe(false);
  });

  it('a successful login resets the counter', () => {
    const throttle = new LoginThrottle(2, 1000, () => 0);
    throttle.recordFailure('a@x');
    throttle.reset('a@x');
    throttle.recordFailure('a@x');
    expect(throttle.isBlocked('a@x')).toBe(false);
  });
});
