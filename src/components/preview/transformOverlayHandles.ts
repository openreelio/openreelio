/**
 * Transform overlay handle identity.
 *
 * react-moveable renders its own control box, so the overlay does not own the
 * handle elements any more. The stable `data-testid` contract the integration
 * tests and the Playwright E2E depend on is re-attached to moveable's controls
 * here, keyed off the `data-direction` attribute moveable stamps on each one.
 */

/** Resize directions rendered by moveable, in visual order. */
export const RENDER_DIRECTIONS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

/** moveable resize direction -> the testid the overlay has always exposed. */
export const DIRECTION_TEST_IDS: Record<string, string> = {
  nw: 'transform-handle-top-left',
  n: 'transform-handle-top',
  ne: 'transform-handle-top-right',
  e: 'transform-handle-right',
  se: 'transform-handle-bottom-right',
  s: 'transform-handle-bottom',
  sw: 'transform-handle-bottom-left',
  w: 'transform-handle-left',
};

/** Testid for moveable's rotation control. */
export const ROTATION_TEST_ID = 'transform-handle-rotate';

/**
 * Stamps the overlay's handle testids onto a moveable control box.
 *
 * Safe to call repeatedly; setting an attribute does not trigger the childList
 * observer that drives re-stamping.
 *
 * @param controlBox - moveable's control box element.
 * @returns Number of elements that received a testid.
 */
export function stampControlTestIds(controlBox: Element | null | undefined): number {
  if (!controlBox) {
    return 0;
  }

  let stamped = 0;

  for (const [direction, testId] of Object.entries(DIRECTION_TEST_IDS)) {
    const control = controlBox.querySelector(
      `.moveable-control[data-direction="${direction}"]`,
    );
    if (control) {
      control.setAttribute('data-testid', testId);
      stamped += 1;
    }
  }

  const rotationControl = controlBox.querySelector('.moveable-rotation-control');
  if (rotationControl) {
    rotationControl.setAttribute('data-testid', ROTATION_TEST_ID);
    stamped += 1;
  }

  return stamped;
}
