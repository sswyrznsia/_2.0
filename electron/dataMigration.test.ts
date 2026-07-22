import assert from 'node:assert/strict'
import { createDefaultData, migratePublicData } from './data'

function legacyData(enabled: boolean) {
  const data = createDefaultData() as unknown as Record<string, unknown>
  const settings: Record<string, unknown> = {
    ...(data.settings as Record<string, unknown>),
    taskbarModeEnabled: enabled,
  }
  delete settings.taskbarPlayerPlacement
  delete settings.taskbarLyricsPosition
  delete settings.taskbarLyricsAlignment
  delete settings.taskbarLyricsBackgroundMode
  delete settings.taskbarLyricsCustomOffset
  return { ...data, settings }
}

export function runTaskbarPlacementMigrationTests() {
  const enabled = migratePublicData(legacyData(true)) as ReturnType<
    typeof createDefaultData
  >
  const disabled = migratePublicData(legacyData(false)) as ReturnType<
    typeof createDefaultData
  >
  assert.equal(enabled.settings.taskbarPlayerPlacement, 'above')
  assert.equal(disabled.settings.taskbarPlayerPlacement, 'disabled')
  assert.equal(enabled.settings.taskbarLyricsPosition, 'auto')
  assert.equal(enabled.settings.taskbarLyricsAlignment, 'center')
  assert.equal(enabled.settings.taskbarLyricsBackgroundMode, 'panel')
  assert.equal(enabled.settings.taskbarLyricsCustomOffset, null)
  assert.equal(
    'taskbarModeEnabled' in enabled.settings,
    false,
    'the retired boolean must not survive migration',
  )

  const configured = legacyData(true)
  const configuredSettings = configured.settings as Record<string, unknown>
  configuredSettings.taskbarLyricsPosition = 'below-player'
  configuredSettings.taskbarLyricsAlignment = 'right'
  configuredSettings.taskbarLyricsBackgroundMode = 'transparent'
  configuredSettings.taskbarLyricsCustomOffset = { x: 24, y: -18 }
  const preserved = migratePublicData(configured) as ReturnType<
    typeof createDefaultData
  >
  assert.equal(preserved.settings.taskbarLyricsPosition, 'below-player')
  assert.equal(preserved.settings.taskbarLyricsAlignment, 'right')
  assert.equal(preserved.settings.taskbarLyricsBackgroundMode, 'transparent')
  assert.deepEqual(preserved.settings.taskbarLyricsCustomOffset, {
    x: 24,
    y: -18,
  })
}
