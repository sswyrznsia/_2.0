/**
 * Wire values used by the sync-import UI and Electron IPC boundary.
 * Keep these values independent from localized labels.
 */
export const MEDIA_IMPORT_ACTIONS = ['keep', 'replace', 'create', 'skip'] as const
export type SyncMediaImportAction = (typeof MEDIA_IMPORT_ACTIONS)[number]

export const EXISTING_FILE_ACTIONS = ['keep', 'trash'] as const
export type SyncExistingFileAction = (typeof EXISTING_FILE_ACTIONS)[number]

export const CONFLICT_IMPORT_ACTIONS = ['local', 'imported'] as const
export type SyncConflictImportAction = (typeof CONFLICT_IMPORT_ACTIONS)[number]

export const LIKED_IMPORT_ACTIONS = ['union', 'replace'] as const
export type SyncLikedImportAction = (typeof LIKED_IMPORT_ACTIONS)[number]

export const PLAYLIST_IMPORT_ACTIONS = ['newer', 'local', 'imported'] as const
export type SyncPlaylistImportAction = (typeof PLAYLIST_IMPORT_ACTIONS)[number]

export type SyncImportMatchKind = 'exact' | 'possible' | 'missing'

/** Defaults are real payload values, not just values rendered in a select. */
export function defaultMediaImportAction(
  matchKind: SyncImportMatchKind,
  mediaAvailable: boolean,
): SyncMediaImportAction {
  if (!mediaAvailable) return 'skip'
  if (matchKind === 'missing') return 'create'
  return matchKind === 'exact' ? 'keep' : 'skip'
}

const mediaActionAliases: Record<string, SyncMediaImportAction> = {
  keep: 'keep',
  current: 'keep',
  local: 'keep',
  'keep-current': 'keep',
  replace: 'replace',
  imported: 'replace',
  incoming: 'replace',
  'use-imported': 'replace',
  create: 'create',
  'create-new': 'create',
  'create-new-track': 'create',
  'import-new': 'create',
  skip: 'skip',
}

const conflictActionAliases: Record<string, SyncConflictImportAction> = {
  local: 'local',
  current: 'local',
  'keep-current': 'local',
  imported: 'imported',
  incoming: 'imported',
  'use-imported': 'imported',
}

const playlistActionAliases: Record<string, SyncPlaylistImportAction> = {
  newer: 'newer',
  latest: 'newer',
  local: 'local',
  current: 'local',
  imported: 'imported',
  incoming: 'imported',
  'use-imported': 'imported',
}

const likedActionAliases: Record<string, SyncLikedImportAction> = {
  union: 'union',
  merge: 'union',
  replace: 'replace',
  imported: 'replace',
  incoming: 'replace',
  'use-imported': 'replace',
}

function normalizeAlias<T extends string>(
  value: unknown,
  aliases: Record<string, T>,
): unknown {
  return typeof value === 'string' ? (aliases[value] ?? value) : value
}

/**
 * Converts only known historic wire values. Unknown values are intentionally
 * left untouched so the strict IPC schema can reject them.
 */
export function normalizeSyncImportPlanInput(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const plan = value as Record<string, unknown>
  return {
    ...plan,
    likesMode: normalizeAlias(plan.likesMode, likedActionAliases),
    playlistMode: normalizeAlias(plan.playlistMode, playlistActionAliases),
    tracks: Array.isArray(plan.tracks)
      ? plan.tracks.map((track) => {
          if (!track || typeof track !== 'object' || Array.isArray(track))
            return track
          const choice = track as Record<string, unknown>
          const conflicts =
            choice.conflicts &&
            typeof choice.conflicts === 'object' &&
            !Array.isArray(choice.conflicts)
              ? Object.fromEntries(
                  Object.entries(choice.conflicts as Record<string, unknown>).map(
                    ([kind, action]) => [
                      kind,
                      normalizeAlias(action, conflictActionAliases),
                    ],
                  ),
                )
              : choice.conflicts
          return {
            ...choice,
            mediaAction: normalizeAlias(choice.mediaAction, mediaActionAliases),
            conflicts,
          }
        })
      : plan.tracks,
  }
}
