/**
 * DOM utility functions shared across keyboard/input handling hooks.
 */

/**
 * Check whether an event target is an input-like element where
 * keyboard shortcuts should be suppressed.
 */
export function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable ||
    target.contentEditable === 'true'
  );
}
