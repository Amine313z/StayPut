/**
 * Saves `data` as a JSON file in the visitor's downloads (« Export my data », a member's data):
 * the browser writes it, nothing leaves StayPut.
 */
export function downloadJson(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}
