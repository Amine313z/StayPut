import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_MARK, inlineBootMark } from '../boot-mark';
import type * as Boot from '../src/boot';

/**
 * StayPut's loading screen (index.html #boot, src/boot.tsx): drawn before any JavaScript, kept
 * while the screen opened waits for its first answer, gone once it shows; never for good.
 */

/** A fresh copy of the module (it keeps its state for the page's life) and the page's #boot. */
async function freshBoot(): Promise<typeof Boot> {
  vi.resetModules();
  const boot = document.createElement('div');
  boot.id = 'boot';
  document.body.prepend(boot);
  return import('../src/boot');
}

const frames = async (count = 3) => {
  for (let i = 0; i < count; i += 1) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
};

const bootOn = () => {
  const boot = document.getElementById('boot');
  return boot !== null && !boot.classList.contains('boot-out');
};

beforeEach(() => {
  document.getElementById('boot')?.remove();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StayPut’s loading screen', () => {
  it('is in the page before any JavaScript, its mark written in, no inline style', () => {
    const web = path.resolve(import.meta.dirname, '..');
    const html = inlineBootMark(readFileSync(path.join(web, 'index.html'), 'utf8'));
    const boot = /<div id="boot"[\s\S]*?<\/div>/.exec(html)?.[0] ?? '';
    // The mark needs no request of its own (the policy allows data: images, no inline style).
    expect(boot).toMatch(/src="data:image\/webp;base64,[A-Za-z0-9+/=]+"/);
    expect(boot).not.toMatch(/style=/);
    expect(html.indexOf('id="boot"')).toBeLessThan(html.indexOf('id="root"'));
    expect(readFileSync(BOOT_MARK).length).toBeLessThan(4_000);
    const headers = readFileSync(path.join(web, 'public/_headers'), 'utf8');
    expect(headers).toMatch(/img-src 'self' data:/);
  });

  it('stays while the screen waits for its answer, and goes once it shows', async () => {
    const { BootHold, startBoot, useBootReady } = await freshBoot();
    function Frame({ waiting }: { waiting: boolean }) {
      useBootReady();
      return waiting ? <BootHold fallback={<p>skeleton</p>} /> : <p>dashboard</p>;
    }
    startBoot();
    const { rerender } = render(<Frame waiting />);
    await frames();
    // Nothing drawn under it: no skeleton flashing before the content.
    expect(bootOn()).toBe(true);
    expect(screen.queryByText('skeleton')).toBeNull();
    rerender(<Frame waiting={false} />);
    await frames();
    expect(bootOn()).toBe(false);
    expect(screen.getByText('dashboard')).toBeTruthy();
  });

  it('waits for a frame to draw: the page’s code still loading keeps it', async () => {
    const { startBoot, useBootReady } = await freshBoot();
    startBoot();
    render(<p>router still loading the screen</p>);
    await frames();
    expect(bootOn()).toBe(true);
    function Frame() {
      useBootReady();
      return <p>frame</p>;
    }
    render(<Frame />);
    await frames();
    expect(bootOn()).toBe(false);
  });

  it('goes after 8 seconds all the same, and the screen still waiting shows its own wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { BOOT_GIVE_UP_MS, BootHold, startBoot } = await freshBoot();
    startBoot();
    render(<BootHold fallback={<p>Loading…</p>} />);
    expect(screen.queryByText('Loading…')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(BOOT_GIVE_UP_MS);
    });
    expect(bootOn()).toBe(false);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('is never in the way of a screen opened after it has gone', async () => {
    const { BootHold } = await freshBoot();
    document.getElementById('boot')?.remove();
    render(<BootHold fallback={<p>Loading…</p>} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });
});
