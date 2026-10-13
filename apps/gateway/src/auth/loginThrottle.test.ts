import { describe, expect, it } from 'vitest';
import { LoginThrottle } from './loginThrottle.ts';

describe('LoginThrottle', () => {
  it('allows 5 attempts within the window, refuses the 6th, and frees the key afterwards', () => {
    let now = 0;
    const throttle = new LoginThrottle(5, 1000, () => now);
    for (let i = 0; i < 5; i++) expect(throttle.tryAttempt('a@x')).toBe(true);
    expect(throttle.tryAttempt('a@x')).toBe(false);
    expect(throttle.tryAttempt('b@x')).toBe(true);
    now = 1001;
    expect(throttle.tryAttempt('a@x')).toBe(true);
  });

  it('counts attempts that are still running: a burst of parallel logins gets only 5 tries', () => {
    // No failure is ever recorded between these calls, exactly like 10 requests whose scrypt checks have not finished.
    const throttle = new LoginThrottle(5, 1000, () => 0);
    const allowed = Array.from({ length: 10 }, () => throttle.tryAttempt('a@x')).filter(Boolean);
    expect(allowed).toHaveLength(5);
  });

  it('a successful login resets the counter', () => {
    const throttle = new LoginThrottle(2, 1000, () => 0);
    throttle.tryAttempt('a@x');
    throttle.tryAttempt('a@x');
    throttle.reset('a@x');
    expect(throttle.tryAttempt('a@x')).toBe(true);
  });
});
