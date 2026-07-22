import assert from 'node:assert/strict'
import type { Rectangle } from 'electron'
import {
  calculateTaskbarOverlayGeometry,
  resolveTaskbarPlayerPlacement,
  type TaskbarDisplayGeometry,
} from './taskbarOverlayPositioner'

const display = (
  id: number,
  bounds: Rectangle,
  workArea: Rectangle,
): TaskbarDisplayGeometry => ({ id, bounds, workArea })

export function runTaskbarOverlayPositionerTests() {
  const bottom = calculateTaskbarOverlayGeometry(
    display(1, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1040 }),
  )
  assert.equal(bottom?.edge, 'bottom')
  assert.deepEqual(bottom?.taskbarBounds, { x: 0, y: 1040, width: 1920, height: 40 })
  assert.equal(bottom?.overlayBounds.y, 1043)

  const top = calculateTaskbarOverlayGeometry(
    display(2, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 48, width: 1920, height: 1032 }),
  )
  assert.equal(top?.edge, 'top')
  assert.deepEqual(top?.taskbarBounds, { x: 0, y: 0, width: 1920, height: 48 })

  const left = calculateTaskbarOverlayGeometry(
    display(3, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 52, y: 0, width: 1868, height: 1080 }),
  )
  assert.equal(left, null, 'vertical taskbars must use the above-taskbar fallback')

  const right = calculateTaskbarOverlayGeometry(
    display(4, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1868, height: 1080 }),
  )
  assert.equal(right, null, 'vertical taskbars must use the above-taskbar fallback')

  const scaledDip = calculateTaskbarOverlayGeometry(
    display(5, { x: 0, y: 0, width: 1536, height: 864 }, { x: 0, y: 0, width: 1536, height: 826 }),
    { leftSafeInset: 320, rightSafeInset: 260, minWidth: 400 },
  )
  assert.equal(scaledDip?.thickness, 38)
  assert.equal(scaledDip?.taskbarBounds.width, 1536)

  const negativeX = calculateTaskbarOverlayGeometry(
    display(6, { x: -1920, y: 0, width: 1920, height: 1080 }, { x: -1920, y: 0, width: 1920, height: 1040 }),
  )
  assert.equal(negativeX?.taskbarBounds.x, -1920)
  assert.ok((negativeX?.overlayBounds.x ?? 0) < 0)

  const negativeY = calculateTaskbarOverlayGeometry(
    display(7, { x: 0, y: -1080, width: 1920, height: 1080 }, { x: 0, y: -1040, width: 1920, height: 1040 }),
  )
  assert.equal(negativeY?.edge, 'top')
  assert.equal(negativeY?.taskbarBounds.y, -1080)

  assert.equal(
    calculateTaskbarOverlayGeometry(
      display(8, { x: 0, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }),
    ),
    null,
    'auto-hide/no-gap geometry must not guess an edge',
  )

  assert.equal(
    calculateTaskbarOverlayGeometry(
      display(9, { x: 0, y: 0, width: 800, height: 600 }, { x: 0, y: 0, width: 800, height: 560 }),
      { leftSafeInset: 500, rightSafeInset: 500, minWidth: 100 },
    ),
    null,
    'safe insets larger than the taskbar must fall back',
  )

  assert.equal(
    calculateTaskbarOverlayGeometry(
      display(10, { x: 0, y: 0, width: 1200, height: 800 }, { x: 0, y: 0, width: 1200, height: 760 }),
      { leftSafeInset: 400, rightSafeInset: 400, minWidth: 480 },
    ),
    null,
    'an overlay narrower than the minimum must fall back',
  )

  assert.equal(resolveTaskbarPlayerPlacement('taskbar-overlay', 'darwin'), 'above')
  assert.equal(resolveTaskbarPlayerPlacement('taskbar-overlay', 'linux'), 'above')
  assert.equal(resolveTaskbarPlayerPlacement('taskbar-overlay', 'win32'), 'taskbar-overlay')
}
