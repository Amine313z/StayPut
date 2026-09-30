/**
 * Preferences kept on the device. Inside Whop's iframe the browser may block storage (Safari's
 * third-party rules): reading then gives nothing and writing does nothing, never an error.
 */
export function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not kept: the default applies next time.
  }
}
