import { Download, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { usePlayerStore } from '../../stores/playerStore'
import type {
  SyncConflictKind,
  SyncImportTrackChoice,
  SyncPackageExportOptions,
  SyncPackageInspection,
  SyncPackageEstimate,
  SyncPackageOperationResult,
} from '../../types/models'
import './SyncPackageSettings.css'

const DEFAULT_OPTIONS: SyncPackageExportOptions = {
  lyrics: true,
  playlists: true,
  likes: true,
  metadataOverrides: true,
  mediaFiles: false,
}

export function SyncPackageSettings() {
  const [options, setOptions] = useState(DEFAULT_OPTIONS)
  const [inspection, setInspection] = useState<SyncPackageInspection | null>(
    null,
  )
  const [choices, setChoices] = useState<Record<string, SyncImportTrackChoice>>(
    {},
  )
  const [likesMode, setLikesMode] = useState<'union' | 'replace'>('union')
  const [playlistMode, setPlaylistMode] = useState<
    'newer' | 'local' | 'imported'
  >('newer')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [estimate, setEstimate] = useState<SyncPackageEstimate | null>(null)
  const [lastSummary, setLastSummary] =
    useState<SyncPackageOperationResult['summary']>()

  useEffect(() => {
    let active = true
    void window.electronAPI
      .estimateSyncPackage(options)
      .then((value) => {
        if (active) setEstimate(value)
      })
      .catch(() => {
        if (active) setEstimate(null)
      })
    return () => {
      active = false
    }
  }, [options])

  const selectedMatches = useMemo(
    () =>
      inspection?.tracks.filter((track) =>
        track.matchKind === 'exact'
          ? Boolean(track.localTrackId)
          : Boolean(
              choices[track.recordId]?.localTrackId ||
              choices[track.recordId]?.mediaAction === 'create',
            ),
      ).length ?? 0,
    [choices, inspection],
  )

  const changeOption = (
    key: keyof SyncPackageExportOptions,
    checked: boolean,
  ) => setOptions((current) => ({ ...current, [key]: checked }))

  const exportPackage = async () => {
    setBusy(true)
    setMessage('')
    try {
      const result = await window.electronAPI.exportSyncPackage(options)
      if (!result.cancelled) setMessage(result.message)
      if (result.success) setLastSummary(result.summary)
    } catch {
      setMessage('동기화 패키지를 내보내지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const inspectPackage = async () => {
    setBusy(true)
    setMessage('')
    try {
      const result = await window.electronAPI.inspectSyncPackage()
      if (result.inspection) {
        setInspection(result.inspection)
        setChoices(
          Object.fromEntries(
            result.inspection.tracks.map((track) => [
              track.recordId,
              {
                recordId: track.recordId,
                localTrackId: track.localTrackId,
                mediaAction: track.mediaAvailable
                  ? track.matchKind === 'exact'
                    ? 'keep'
                    : track.matchKind === 'missing'
                      ? 'create'
                      : 'skip'
                  : 'skip',
                existingFileAction: 'keep',
                conflicts: Object.fromEntries(
                  track.conflicts.map((conflict) => [
                    conflict.kind,
                    conflict.recommended,
                  ]),
                ),
              } satisfies SyncImportTrackChoice,
            ]),
          ),
        )
      }
      if (!result.cancelled) setMessage(result.message)
    } catch {
      setMessage('동기화 패키지를 검사하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const applyPackage = async () => {
    if (!inspection) return
    setBusy(true)
    setMessage('')
    try {
      const result = await window.electronAPI.importSyncPackage({
        token: inspection.token,
        tracks: Object.values(choices),
        likesMode,
        playlistMode,
      })
      setMessage(result.message)
      setLastSummary(result.summary)
      if (result.success) {
        await useAppStore.getState().refreshData()
        const imported = useAppStore.getState().data
        if (imported) usePlayerStore.getState().hydrate(imported)
        setInspection(null)
        setChoices({})
      }
    } catch {
      setMessage(
        '동기화 패키지를 적용하지 못했습니다. 기존 데이터는 유지되었습니다.',
      )
    } finally {
      setBusy(false)
    }
  }

  const chooseTrack = (recordId: string, localTrackId: string) =>
    setChoices((current) => ({
      ...current,
      [recordId]: {
        ...(current[recordId] ?? { recordId }),
        localTrackId: localTrackId || undefined,
        mediaAction: localTrackId
          ? current[recordId]?.mediaAction === 'replace'
            ? 'replace'
            : 'keep'
          : current[recordId]?.mediaAction,
        conflicts: Object.fromEntries(
          (
            inspection?.tracks
              .find((track) => track.recordId === recordId)
              ?.candidates.find(
                (candidate) => candidate.trackId === localTrackId,
              )?.conflicts ?? []
          ).map((conflict) => [conflict.kind, conflict.recommended]),
        ),
      },
    }))

  const chooseMediaAction = (
    recordId: string,
    mediaAction: NonNullable<SyncImportTrackChoice['mediaAction']>,
  ) =>
    setChoices((current) => ({
      ...current,
      [recordId]: {
        ...(current[recordId] ?? { recordId }),
        mediaAction,
        localTrackId:
          mediaAction === 'create'
            ? undefined
            : current[recordId]?.localTrackId,
      },
    }))

  const chooseConflict = (
    recordId: string,
    kind: SyncConflictKind,
    value: 'local' | 'imported',
  ) =>
    setChoices((current) => ({
      ...current,
      [recordId]: {
        ...(current[recordId] ?? { recordId }),
        conflicts: { ...current[recordId]?.conflicts, [kind]: value },
      },
    }))

  return (
    <section className="settings-section sync-package-settings">
      <div className="sync-package-settings__heading">
        <span>
          <h2>기기 간 동기화</h2>
          <small>
            음악 파일과 로컬 경로를 제외하고 가사, 좋아요, 플레이리스트를 안전한
            .pssync 파일로 옮깁니다.
          </small>
        </span>
        <div className="page-actions">
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void exportPackage()}
          >
            <Download /> 패키지 내보내기
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={busy}
            onClick={() => void inspectPackage()}
          >
            <Upload /> 패키지 가져오기
          </button>
        </div>
      </div>

      <fieldset className="sync-package-options" disabled={busy}>
        <legend>내보낼 항목</legend>
        <Option
          label="가사와 줄별 싱크"
          checked={options.lyrics}
          onChange={(value) => changeOption('lyrics', value)}
        />
        <Option
          label="플레이리스트"
          checked={options.playlists}
          onChange={(value) => changeOption('playlists', value)}
        />
        <Option
          label="좋아요"
          checked={options.likes}
          onChange={(value) => changeOption('likes', value)}
        />
        <Option
          label="제목·아티스트·앨범 수정값"
          checked={options.metadataOverrides}
          onChange={(value) => changeOption('metadataOverrides', value)}
        />
        <Option
          label="음악 파일 포함"
          checked={options.mediaFiles}
          onChange={(value) => changeOption('mediaFiles', value)}
        />
      </fieldset>

      {options.mediaFiles && (
        <div className="sync-package-media-estimate">
          <strong>음악 파일을 포함하면 패키지 크기가 크게 증가합니다.</strong>
          <span>
            전체 {estimate?.totalTracks ?? 0}곡 · 포함 가능{' '}
            {estimate?.mediaFiles ?? 0}개 · 예상 크기{' '}
            {formatBytes(estimate?.mediaBytes ?? 0)}
          </span>
          {(estimate?.excludedMedia ?? 0) > 0 && (
            <small>
              경로 없음·지원하지 않는 형식·4GB 초과 파일{' '}
              {estimate?.excludedMedia}개는 제외됩니다.
            </small>
          )}
          {estimate?.exceedsLimit && (
            <small className="is-error">20GB 최대 용량을 초과합니다.</small>
          )}
        </div>
      )}

      {message && (
        <p className="settings-status" role="status">
          {message}
        </p>
      )}
      {lastSummary && (
        <div className="sync-package-result" role="status">
          <span>새 곡 {lastSummary.createdTracks ?? 0}개</span>
          <span>미디어 교체 {lastSummary.replacedMedia ?? 0}개</span>
          <span>가사 {lastSummary.lyrics}개</span>
          <span>플레이리스트 {lastSummary.playlists}개</span>
          <span>변경 없음 {lastSummary.unchangedItems ?? 0}개</span>
          {lastSummary.warnings?.map((warning) => (
            <small key={warning}>{warning}</small>
          ))}
        </div>
      )}

      {inspection && (
        <div className="sync-package-preview">
          <header>
            <div>
              <strong>가져오기 미리보기</strong>
              <small>
                {inspection.fileName} · 앱 {inspection.appVersion}
              </small>
            </div>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setInspection(null)}
            >
              닫기
            </button>
          </header>
          <dl className="sync-package-summary">
            <div>
              <dt>정확히 일치</dt>
              <dd>{inspection.exactMatches}</dd>
            </div>
            <div>
              <dt>확인 필요</dt>
              <dd>{inspection.possibleMatches}</dd>
            </div>
            <div>
              <dt>로컬 곡 없음</dt>
              <dd>{inspection.missingTracks}</dd>
            </div>
            <div>
              <dt>충돌</dt>
              <dd>{inspection.conflictCount}</dd>
            </div>
            <div>
              <dt>플레이리스트</dt>
              <dd>{inspection.playlistCount}</dd>
            </div>
            <div>
              <dt>포함 미디어</dt>
              <dd>{inspection.mediaFiles}</dd>
            </div>
            <div>
              <dt>새로 가져올 곡</dt>
              <dd>{inspection.creatableTracks}</dd>
            </div>
            <div>
              <dt>미디어 용량</dt>
              <dd>{formatBytes(inspection.totalMediaBytes)}</dd>
            </div>
          </dl>

          <div className="sync-package-policies">
            <label>
              좋아요
              <select
                value={likesMode}
                onChange={(event) =>
                  setLikesMode(event.target.value as 'union' | 'replace')
                }
              >
                <option value="union">현재 + 가져온 좋아요 합치기</option>
                <option value="replace">가져온 값으로 바꾸기</option>
              </select>
            </label>
            <label>
              같은 플레이리스트
              <select
                value={playlistMode}
                onChange={(event) =>
                  setPlaylistMode(event.target.value as typeof playlistMode)
                }
              >
                <option value="newer">더 최근 수정본</option>
                <option value="local">현재 기기 유지</option>
                <option value="imported">가져온 목록 사용</option>
              </select>
            </label>
          </div>

          <div className="sync-package-track-list">
            {inspection.tracks.map((track) => (
              <article
                key={track.recordId}
                className={`sync-package-track sync-package-track--${track.matchKind}`}
              >
                <header>
                  <span>
                    <strong>{track.title}</strong>
                    <small>{track.artist}</small>
                  </span>
                  <em>{matchLabel(track.matchKind)}</em>
                </header>
                <small>
                  포함: {track.importedData.join(', ') || '식별 정보만'}
                </small>
                {track.mediaAvailable && (
                  <div className="sync-package-media-choice">
                    <label>
                      음악 파일 처리
                      <select
                        value={choices[track.recordId]?.mediaAction ?? 'skip'}
                        onChange={(event) =>
                          chooseMediaAction(
                            track.recordId,
                            event.target.value as NonNullable<
                              SyncImportTrackChoice['mediaAction']
                            >,
                          )
                        }
                      >
                        {track.matchKind !== 'missing' && (
                          <option value="keep">현재 로컬 파일 유지</option>
                        )}
                        {(track.matchKind === 'exact' ||
                          Boolean(choices[track.recordId]?.localTrackId)) && (
                          <option value="replace">패키지 파일로 교체</option>
                        )}
                        <option value="create">새 곡으로 가져오기</option>
                        <option value="skip">미디어 건너뛰기</option>
                      </select>
                    </label>
                    {choices[track.recordId]?.mediaAction === 'replace' && (
                      <label>
                        기존 파일
                        <select
                          value={
                            choices[track.recordId]?.existingFileAction ??
                            'keep'
                          }
                          onChange={(event) =>
                            setChoices((current) => ({
                              ...current,
                              [track.recordId]: {
                                ...(current[track.recordId] ?? {
                                  recordId: track.recordId,
                                }),
                                existingFileAction: event.target.value as
                                  'keep' | 'trash',
                              },
                            }))
                          }
                        >
                          <option value="keep">기존 파일 그대로 유지</option>
                          <option value="trash">성공 후 휴지통으로 이동</option>
                        </select>
                      </label>
                    )}
                    <small>
                      {formatBytes(track.mediaSize)} · 검증 후 가져옵니다.
                    </small>
                  </div>
                )}
                {!track.mediaAvailable && track.matchKind === 'missing' && (
                  <p>패키지에 음악 파일이 없어 새 Track을 만들 수 없습니다.</p>
                )}
                {track.matchKind === 'possible' && (
                  <label>
                    로컬 곡 연결 (자동 적용되지 않음)
                    <select
                      value={choices[track.recordId]?.localTrackId ?? ''}
                      onChange={(event) =>
                        chooseTrack(track.recordId, event.target.value)
                      }
                    >
                      <option value="">건너뛰기</option>
                      {track.candidates.map((candidate) => (
                        <option
                          key={candidate.trackId}
                          value={candidate.trackId}
                        >
                          {candidate.title} · {candidate.artist} ·{' '}
                          {formatDuration(candidate.durationMs)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {track.matchKind === 'missing' && (
                  <p>음악 파일을 만들지 않고 이 곡의 데이터는 건너뜁니다.</p>
                )}
                {(track.matchKind === 'possible'
                  ? (track.candidates.find(
                      (candidate) =>
                        candidate.trackId ===
                        choices[track.recordId]?.localTrackId,
                    )?.conflicts ?? [])
                  : track.conflicts
                ).map((conflict) => (
                  <div className="sync-package-conflict" key={conflict.kind}>
                    <span>
                      <strong>{conflictLabel(conflict.kind)}</strong>
                      <small>현재: {conflict.localSummary}</small>
                      <small>가져옴: {conflict.importedSummary}</small>
                    </span>
                    <select
                      value={
                        choices[track.recordId]?.conflicts?.[conflict.kind] ??
                        conflict.recommended
                      }
                      onChange={(event) =>
                        chooseConflict(
                          track.recordId,
                          conflict.kind,
                          event.target.value as 'local' | 'imported',
                        )
                      }
                    >
                      <option value="local">현재 유지</option>
                      <option value="imported">가져온 값 사용</option>
                    </select>
                  </div>
                ))}
              </article>
            ))}
          </div>
          <footer>
            <span>
              {selectedMatches}곡을 적용합니다. 새 곡과 미디어 교체 선택도
              포함됩니다.
            </span>
            <button
              type="button"
              className="button button--primary"
              disabled={
                busy ||
                (selectedMatches === 0 && inspection.playlistCount === 0)
              }
              onClick={() => void applyPackage()}
            >
              {busy ? '처리 중…' : '선택한 데이터 적용'}
            </button>
          </footer>
        </div>
      )}
    </section>
  )
}

function Option({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

function matchLabel(kind: 'exact' | 'possible' | 'missing') {
  return {
    exact: '정확히 일치',
    possible: '사용자 확인 필요',
    missing: '로컬 곡 없음',
  }[kind]
}

function conflictLabel(kind: SyncConflictKind) {
  return {
    lyrics: '가사',
    lyricsSyncProfile: '가사 시간 보정',
    generatedLyricsTimeline: 'AI/수동 줄별 타임라인',
    metadata: '곡 메타데이터',
  }[kind]
}

function formatDuration(durationMs: number) {
  const seconds = Math.round(durationMs / 1_000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
