// A deliberately wrong component: no-hardcoded-text.test.ts must find its 3 texts.
export function Hardcoded() {
  return (
    <button type="button" aria-label="Close the panel">
      Save changes
      <span>{'Written in the markup'}</span>
    </button>
  );
}
