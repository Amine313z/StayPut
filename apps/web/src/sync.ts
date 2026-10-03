import type { SyncRun, SyncStatus } from '@stayput/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SLOW_MS, getJson, postJson } from './api';

/** While the history is being imported, the status is read again this often. */
export const SYNC_POLL_MS = 10_000;

export type SyncNotice = 'tooSoon' | 'failed' | null;

export interface SyncState {
  status: SyncStatus | null;
  /** No status yet after 5 seconds: the screen says so, with « Retry » (brief v4 §9.6). */
  slow: boolean;
  /** Reads the status again. */
  retry: () => void;
  /** "Sync now" is under way. */
  running: boolean;
  notice: SyncNotice;
  syncNow: () => void;
}

/**
 * Where the reading of the company's Whop data stands, read again every few seconds while the
 * history is being imported; `onChange` runs when new data may have arrived.
 */
export function useSync(companyId: string, onChange: () => void): SyncState {
  const base = `/api/creator/${encodeURIComponent(companyId)}/sync`;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [waited, setWaited] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<SyncNotice>(null);
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  }, [onChange]);
  // The last synchronization seen: a newer one means new data (undefined: nothing read yet).
  const lastSync = useRef<string | null | undefined>(undefined);

  const read = useCallback(
    (signal: AbortSignal) => {
      getJson<SyncStatus>(base, signal).then(
        (next) => {
          const seen = lastSync.current;
          lastSync.current = next.lastSyncAt;
          setStatus(next);
          if (seen !== undefined && next.lastSyncAt !== seen) change.current();
        },
        () => {
          // The status is a convenience: the screen keeps the last one it read.
        },
      );
    },
    [base],
  );

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    read(controller.signal);
    // Five seconds without a status: said, with « Retry »; one that comes later still shows.
    const timer = setTimeout(() => setWaited(true), SLOW_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [read, attempt]);

  // While the history is being imported, read again every few seconds.
  const backfillDone = status?.backfillDone ?? false;
  useEffect(() => {
    if (backfillDone) return undefined;
    const controller = new AbortController();
    const timer = setInterval(() => read(controller.signal), SYNC_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [read, backfillDone]);

  const syncNow = useCallback(() => {
    setRunning(true);
    setNotice(null);
    postJson<SyncRun>(base).then(
      (run) => {
        lastSync.current = run.lastSyncAt;
        setStatus(run);
        setNotice(run.ran ? null : 'tooSoon');
        setRunning(false);
        if (run.ran) change.current();
      },
      () => {
        setNotice('failed');
        setRunning(false);
      },
    );
  }, [base]);

  return {
    status,
    slow: status === null && waited,
    retry: () => {
      setWaited(false);
      setAttempt((n) => n + 1);
    },
    running,
    notice,
    syncNow,
  };
}
