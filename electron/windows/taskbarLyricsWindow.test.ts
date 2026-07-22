import assert from 'node:assert/strict'
import { calculateTaskbarLyricsBounds } from './taskbarLyricsWindow'

export function runTaskbarLyricsBoundsTests() {
  const displayBounds = { x: 0, y: 0, width: 1920, height: 1080 }
  const middlePlayer = { x: 560, y: 500, width: 960, height: 40 }

  assert.deepEqual(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: 560, y: 1043, width: 960, height: 34 },
      displayBounds,
      edge: 'bottom',
    }),
    { x: 660, y: 939, width: 760, height: 104 },
  )
  assert.deepEqual(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: 560, y: 3, width: 960, height: 42 },
      displayBounds,
      edge: 'top',
    }),
    { x: 660, y: 45, width: 760, height: 104 },
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: middlePlayer,
      displayBounds,
      edge: 'top',
      position: 'above-player',
    }).y,
    396,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: middlePlayer,
      displayBounds,
      edge: 'bottom',
      position: 'below-player',
    }).y,
    540,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: middlePlayer,
      displayBounds,
      edge: 'bottom',
      alignment: 'left',
    }).x,
    560,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: middlePlayer,
      displayBounds,
      edge: 'bottom',
      alignment: 'center',
    }).x,
    660,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: middlePlayer,
      displayBounds,
      edge: 'bottom',
      alignment: 'right',
    }).x,
    760,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: -1360, y: 860, width: 800, height: 40 },
      displayBounds: { x: -1600, y: 0, width: 1600, height: 900 },
      edge: 'bottom',
    }).x,
    -1340,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: 100, y: -1080, width: 800, height: 40 },
      displayBounds: { x: 0, y: -1080, width: 1920, height: 1080 },
      edge: 'top',
    }).y,
    -1040,
  )
  assert.deepEqual(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: -80, y: 10, width: 300, height: 30 },
      displayBounds: { x: 0, y: 0, width: 400, height: 180 },
      edge: 'bottom',
    }),
    { x: 0, y: 0, width: 400, height: 104 },
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: 700, y: 700, width: 300, height: 40 },
      displayBounds: { x: 0, y: 0, width: 1200, height: 800 },
      edge: 'bottom',
    }).width,
    480,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: 1100, y: 700, width: 300, height: 40 },
      displayBounds: { x: 0, y: 0, width: 1200, height: 800 },
      edge: 'bottom',
    }).x,
    720,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: -100, y: 500, width: 960, height: 40 },
      displayBounds,
      edge: 'bottom',
      alignment: 'left',
    }).x,
    0,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: 1500, y: 500, width: 960, height: 40 },
      displayBounds,
      edge: 'bottom',
      alignment: 'right',
    }).x,
    1160,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: 560, y: 3, width: 960, height: 42 },
      displayBounds,
      edge: 'top',
      position: 'above-player',
    }).y,
    45,
    'an infeasible forced position falls back to the usable automatic side',
  )
  assert.deepEqual(
    calculateTaskbarLyricsBounds({
      playerBounds: middlePlayer,
      displayBounds,
      edge: 'bottom',
      customOffset: { x: 30, y: -20 },
    }),
    { x: 690, y: 376, width: 760, height: 104 },
  )
  assert.deepEqual(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: -1360, y: 860, width: 800, height: 40 },
      displayBounds: { x: -1600, y: 0, width: 1600, height: 900 },
      edge: 'bottom',
      customOffset: { x: -500, y: 200 },
    }),
    { x: -1600, y: 796, width: 760, height: 104 },
  )
  assert.deepEqual(
    calculateTaskbarLyricsBounds({
      playerBounds: { x: 100, y: -1080, width: 800, height: 40 },
      displayBounds: { x: 0, y: -1080, width: 1920, height: 1080 },
      edge: 'top',
      customOffset: { x: -500, y: -200 },
    }),
    { x: 0, y: -1080, width: 760, height: 104 },
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: middlePlayer,
      displayBounds,
      edge: 'bottom',
      alignment: 'left',
      customOffset: { x: 40, y: 0 },
    }).x,
    600,
  )
  assert.equal(
    calculateTaskbarLyricsBounds({
      playerBounds: middlePlayer,
      displayBounds,
      edge: 'bottom',
      alignment: 'right',
      customOffset: { x: 40, y: 0 },
    }).x,
    800,
  )
}
