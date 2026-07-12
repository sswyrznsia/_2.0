import {
  Download,
  FolderOpen,
  FolderMinus,
  FolderPlus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { YouTubeExtensionStatus } from '../types/models'
import { useAppStore } from '../stores/appStore'
import { usePlayerStore } from '../stores/playerStore'

export function SettingsPage() {
  const data = useAppStore((state) => state.data)
  const isScanning = useAppStore((state) => state.isScanning)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const addFolder = useAppStore((state) => state.addMusicFolder)
  const removeFolder = useAppStore((state) => state.removeMusicFolder)
  const exportData = useAppStore((state) => state.exportData)
  const importData = useAppStore((state) => state.importData)
  const resetAll = useAppStore((state) => state.resetAllData)
  const setVolume = usePlayerStore((state) => state.setVolume)
  const resetPlayer = usePlayerStore((state) => state.resetPlayer)
  const [dialog, setDialog] = useState<'reset' | 'import' | null>(null)
  const [status, setStatus] = useState('')
  const [youtubeExtension, setYouTubeExtension] =
    useState<YouTubeExtensionStatus | null>(null)
  const [extensionBusy, setExtensionBusy] = useState(false)
  const [extensionMessage, setExtensionMessage] = useState('')
  useEffect(() => {
    void window.electronAPI
      .getYouTubeExtensionStatus()
      .then(setYouTubeExtension)
      .catch(() => setExtensionMessage('확장 프로그램 상태를 불러오지 못했습니다.'))
  }, [])
  if (!data) return null

  const runExtensionAction = async (
    action: () => Promise<YouTubeExtensionStatus>,
  ) => {
    setExtensionBusy(true)
    setExtensionMessage('')
    try {
      setYouTubeExtension(await action())
    } catch (error) {
      setExtensionMessage(
        error instanceof Error ? error.message : '확장 프로그램 작업에 실패했습니다.',
      )
    } finally {
      setExtensionBusy(false)
    }
  }

  const setDefaultVolume = (value: number) => {
    updateSettings({ defaultVolume: value })
    setVolume(value)
  }

  return (
    <div className="page settings-page">
      <header className="page-header">
        <div>
          <h1>설정</h1>
          <p>변경 사항은 자동으로 저장됩니다.</p>
        </div>
      </header>
      <section className="settings-section">
        <h2>작업표시줄 교체 모드</h2>
        <SettingToggle
          label="Pulse Shelf 작업표시줄 모드 사용"
          description="Windows 작업표시줄 위를 Pulse Shelf 전용 재생 제어 막대로 덮습니다."
          checked={data.settings.taskbarModeEnabled}
          onChange={(value) => updateSettings({ taskbarModeEnabled: value })}
        />
        <SettingToggle
          label="앱 시작 시 Pulse Shelf 작업표시줄 표시"
          description="앱을 시작할 때 교체 모드를 바로 표시합니다."
          checked={data.settings.taskbarModeShowOnStartup}
          onChange={(value) =>
            updateSettings({ taskbarModeShowOnStartup: value })
          }
        />
        <SettingToggle
          label="마지막 표시 상태 복원"
          description="종료 전 Pulse Shelf/Windows 작업표시줄 상태를 다음 실행에 복원합니다."
          checked={data.settings.taskbarModeRestoreLastState}
          onChange={(value) =>
            updateSettings({ taskbarModeRestoreLastState: value })
          }
        />
        <label className="setting-row">
          <span>
            <strong>Windows 모드 ＋ 버튼 위치</strong>
            <small>Windows 작업표시줄이 보일 때 교체 모드로 돌아가는 버튼 위치입니다.</small>
          </span>
          <select
            value={data.settings.taskbarTogglePosition}
            onChange={(event) =>
              updateSettings({
                taskbarTogglePosition: event.target.value as
                  'left' | 'custom' | 'right',
              })
            }
          >
            <option value="left">왼쪽</option>
            <option value="custom">사용자 지정</option>
            <option value="right">오른쪽</option>
          </select>
        </label>
        <label className="setting-row">
          <span>
            <strong>시스템 트레이 예약 폭</strong>
            <small>＋ 버튼이 네트워크, 볼륨, 입력기 영역을 가리지 않도록 비워 둡니다.</small>
          </span>
          <span className="setting-range">
            <input
              type="range"
              min="180"
              max="700"
              step="10"
              value={data.settings.taskbarToggleTrayReservedWidth}
              onChange={(event) =>
                updateSettings({
                  taskbarToggleTrayReservedWidth: Number(event.target.value),
                })
              }
            />
            <output>{data.settings.taskbarToggleTrayReservedWidth}px</output>
          </span>
        </label>
        <div className="setting-row">
          <span>
            <strong>＋ 버튼 위치 초기화</strong>
            <small>오른쪽 정렬과 기본 시스템 트레이 예약 폭으로 되돌립니다.</small>
          </span>
          <button
            type="button"
            className="button"
            onClick={() =>
              updateSettings({
                taskbarTogglePosition: 'right',
                taskbarToggleTrayReservedWidth: 350,
                taskbarToggleCustomRightGap: 362,
              })
            }
          >
            <RotateCcw />
            위치 초기화
          </button>
        </div>
        <SettingToggle
          label="전역 단축키 사용"
          description="Ctrl+Alt+P로 Pulse Shelf와 Windows 작업표시줄 표시를 전환합니다."
          checked={data.settings.taskbarModeShortcuts}
          onChange={(value) => updateSettings({ taskbarModeShortcuts: value })}
        />
        <label className="setting-row">
          <span>
            <strong>불투명도</strong>
            <small>교체 작업표시줄의 불투명도를 조절합니다. 기본값은 100%입니다.</small>
          </span>
          <span className="setting-range">
            <input
              type="range"
              min="0.85"
              max="1"
              step="0.01"
              value={data.settings.taskbarModeOpacity}
              onChange={(event) =>
                updateSettings({
                  taskbarModeOpacity: Number(event.target.value),
                })
              }
            />
            <output>{Math.round(data.settings.taskbarModeOpacity * 100)}%</output>
          </span>
        </label>
        <SettingToggle
          label="현재 가사 표시"
          description="작업표시줄 플레이어에 현재 재생 중인 동기화 가사를 표시합니다."
          checked={data.settings.taskbarLyricsEnabled}
          onChange={(value) => updateSettings({ taskbarLyricsEnabled: value })}
        />
        <label className="setting-row">
          <span>
            <strong>가사 표시</strong>
            <small>동기화된 현재 줄과 다음 줄의 표시 방식을 선택합니다.</small>
          </span>
          <select
            value={data.settings.taskbarLyricsDisplay}
            disabled={!data.settings.taskbarLyricsEnabled}
            onChange={(event) =>
              updateSettings({
                taskbarLyricsDisplay: event.target.value as
                  | 'off'
                  | 'current'
                  | 'current-next',
              })
            }
          >
            <option value="off">끔</option>
            <option value="current">현재 줄</option>
            <option value="current-next">현재 + 다음 줄</option>
          </select>
        </label>
      </section>
      <section className="settings-section">
        <h2>화면</h2>
        <label className="setting-row">
          <span>
            <strong>테마</strong>
            <small>앱의 색상 모드를 선택합니다.</small>
          </span>
          <select
            value={data.settings.theme}
            onChange={(event) =>
              updateSettings({
                theme: event.target.value as 'dark' | 'light' | 'system',
              })
            }
          >
            <option value="dark">다크</option>
            <option value="light">라이트</option>
            <option value="system">시스템 설정</option>
          </select>
        </label>
      </section>
      <section className="settings-section">
        <h2>가사</h2>
        <SettingToggle
          label="가져오기 후 자동 가사 검색"
          description="YouTube에서 가져온 곡의 가사를 백그라운드에서 찾습니다."
          checked={data.settings.autoFetchLyricsOnImport}
          onChange={(value) =>
            updateSettings({ autoFetchLyricsOnImport: value })
          }
        />
        <SettingToggle
          label="재생 시 자동 가사 검색"
          description="로컬 가사와 저장된 가사가 없을 때 LRCLIB를 검색합니다."
          checked={data.settings.autoFetchLyricsOnPlay}
          onChange={(value) => updateSettings({ autoFetchLyricsOnPlay: value })}
        />
        <SettingToggle
          label="동기화 가사 우선"
          description="시간 정보가 있는 가사를 우선 표시합니다."
          checked={data.settings.preferSyncedLyrics}
          onChange={(value) => updateSettings({ preferSyncedLyrics: value })}
        />
        <div className="setting-row">
          <span>
            <strong>가사 캐시</strong>
            <small>자동 검색으로 저장된 가사와 검색 결과를 삭제합니다.</small>
          </span>
          <button
            type="button"
            className="button"
            onClick={() => void window.electronAPI.clearLyricsCache()}
          >
            캐시 삭제
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h2>YouTube 확장 프로그램</h2>
        <p className="settings-extension__warning">
          선택한 확장 프로그램은 YouTube 페이지의 내용을 읽거나 변경할 수 있습니다.
          신뢰할 수 있는 압축 해제 확장 프로그램만 사용하세요.
        </p>
        <SettingToggle
          label="확장 프로그램 사용"
          description="YouTube 전용 프로필에서만 로드되며, Pulse Shelf의 다른 창에는 적용되지 않습니다."
          checked={youtubeExtension?.enabled ?? false}
          onChange={(enabled) =>
            void runExtensionAction(() =>
              enabled
                ? window.electronAPI.loadYouTubeExtension()
                : window.electronAPI.disableYouTubeExtension(),
            )
          }
        />
        <div className="setting-row">
          <span>
            <strong>압축 해제된 확장 프로그램 폴더</strong>
            <small title={youtubeExtension?.extensionPath}>
              {youtubeExtension?.extensionPath ??
                'manifest.json이 있는 폴더를 선택하세요.'}
            </small>
          </span>
          <div className="page-actions">
            <button
              type="button"
              className="button"
              disabled={extensionBusy}
              onClick={() =>
                void runExtensionAction(() =>
                  window.electronAPI.selectYouTubeExtensionFolder(),
                )
              }
            >
              <Puzzle />
              폴더 선택
            </button>
            <button
              type="button"
              className="button"
              disabled={extensionBusy || !youtubeExtension?.extensionPath}
              onClick={() => void window.electronAPI.openYouTubeExtensionFolder()}
            >
              <FolderOpen />
              폴더 열기
            </button>
          </div>
        </div>
        {youtubeExtension?.name && (
          <div className="settings-extension__meta" role="status">
            <strong>{youtubeExtension.name}</strong>
            <span>버전 {youtubeExtension.version ?? '알 수 없음'}</span>
            <span>ID {youtubeExtension.extensionId ?? '로드 전'}</span>
            <span>상태 {extensionStatusLabel(youtubeExtension)}</span>
          </div>
        )}
        {(youtubeExtension?.error || extensionMessage) && (
          <p className="settings-status settings-status--error" role="alert">
            {youtubeExtension?.error ?? extensionMessage}
          </p>
        )}
        <div className="page-actions settings-extension__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={extensionBusy || !youtubeExtension?.extensionPath}
            onClick={() =>
              void runExtensionAction(() =>
                window.electronAPI.loadYouTubeExtension(),
              )
            }
          >
            <Puzzle />
            활성화
          </button>
          <button
            type="button"
            className="button"
            disabled={extensionBusy || !youtubeExtension?.extensionPath}
            onClick={() =>
              void runExtensionAction(() =>
                window.electronAPI.reloadYouTubeExtension(),
              )
            }
          >
            <RefreshCw />
            다시 불러오기
          </button>
          <button
            type="button"
            className="button button--danger"
            disabled={extensionBusy || !youtubeExtension?.extensionPath}
            onClick={() =>
              void runExtensionAction(() =>
                window.electronAPI.removeYouTubeExtension(),
              )
            }
          >
            <Trash2 />
            제거
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h2>재생 및 시작</h2>
        <SettingToggle
          label="마지막 화면 복원"
          description="앱을 다시 열 때 마지막 페이지를 표시합니다."
          checked={data.settings.restoreLastPage}
          onChange={(value) => updateSettings({ restoreLastPage: value })}
        />
        <SettingToggle
          label="마지막 재생 큐 복원"
          description="종료 전 큐와 재생 위치를 복원합니다."
          checked={data.settings.restoreQueue}
          onChange={(value) => updateSettings({ restoreQueue: value })}
        />
        <SettingToggle
          label="시작 시 자동 재생"
          description="복원된 곡을 앱 시작과 함께 재생합니다."
          checked={data.settings.autoplay}
          onChange={(value) => updateSettings({ autoplay: value })}
        />
        <SettingToggle
          label="Windows 자동 실행"
          description="로그인할 때 Pulse Shelf를 실행합니다."
          checked={data.settings.autoLaunch}
          onChange={(value) => updateSettings({ autoLaunch: value })}
        />
        <label className="setting-row">
          <span>
            <strong>기본 볼륨</strong>
            <small>새 재생 세션의 볼륨이며 지금 바로 적용됩니다.</small>
          </span>
          <span className="setting-range">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={data.settings.defaultVolume}
              onChange={(event) => setDefaultVolume(Number(event.target.value))}
            />
            <output>{Math.round(data.settings.defaultVolume * 100)}%</output>
          </span>
        </label>
      </section>
      <section className="settings-section">
        <h2>창 및 연결</h2>
        <label className="setting-row">
          <span>
            <strong>창 닫기 동작</strong>
            <small>트레이로 최소화하면 재생이 계속됩니다.</small>
          </span>
          <select
            value={data.settings.closeBehavior}
            onChange={(event) =>
              updateSettings({
                closeBehavior: event.target.value as 'quit' | 'tray',
              })
            }
          >
            <option value="quit">완전 종료</option>
            <option value="tray">트레이로 최소화</option>
          </select>
        </label>
        <SettingToggle
          label="Discord Rich Presence"
          description="Client ID가 설정된 경우 곡과 재생 상태를 Discord에 표시합니다."
          checked={data.settings.discordPresence}
          onChange={(value) => updateSettings({ discordPresence: value })}
        />
        <SettingToggle
          label="미니 플레이어 항상 위"
          description="미니 플레이어를 다른 창 위에 유지합니다."
          checked={data.settings.miniAlwaysOnTop}
          onChange={(value) => updateSettings({ miniAlwaysOnTop: value })}
        />
        <div className="setting-row">
          <span>
            <strong>미니 플레이어</strong>
            <small>위치와 크기는 다음 실행에도 복원됩니다.</small>
          </span>
          <button
            type="button"
            className="button"
            onClick={() => void window.electronAPI.openMiniPlayer()}
          >
            열기
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h2>음악 폴더</h2>
        <div className="folder-list">
          {data.musicFolders.map((folder) => (
            <div key={folder}>
              <span title={folder}>{folder}</span>
              <button
                type="button"
                className="button"
                disabled={isScanning}
                onClick={() => void removeFolder(folder)}
              >
                <FolderMinus />
                제거
              </button>
            </div>
          ))}
          {!data.musicFolders.length && <p>추가된 음악 폴더가 없습니다.</p>}
        </div>
        <button
          type="button"
          className="button"
          disabled={isScanning}
          onClick={() => void addFolder()}
        >
          <FolderPlus />
          폴더 추가
        </button>
      </section>
      <section className="settings-section">
        <h2>단축키</h2>
        <div className="shortcut-grid">
          <span>
            <kbd>Space</kbd> 재생/일시정지
          </span>
          <span>
            <kbd>Ctrl</kbd> + <kbd>←/→</kbd> 이전/다음 곡
          </span>
          <span>
            <kbd>Ctrl</kbd> + <kbd>↑/↓</kbd> 볼륨
          </span>
          <span>
            <kbd>Ctrl</kbd> + <kbd>F</kbd> 검색
          </span>
          <span>
            <kbd>Ctrl</kbd> + <kbd>L</kbd> 라이브러리
          </span>
          <span>
            <kbd>Ctrl</kbd> + <kbd>M</kbd> 미니 플레이어
          </span>
        </div>
      </section>
      <section className="settings-section">
        <h2>데이터</h2>
        <div className="setting-row">
          <span>
            <strong>백업</strong>
            <small>
              파일 경로와 음악 파일은 제외하고 좋아요, 플레이리스트, 설정을
              JSON으로 보관합니다.
            </small>
          </span>
          <div className="page-actions">
            <button
              type="button"
              className="button"
              onClick={() => void exportData().then(setStatus)}
            >
              <Download />
              내보내기
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setDialog('import')}
            >
              <Upload />
              가져오기
            </button>
          </div>
        </div>
        {status && (
          <p className="settings-status" role="status">
            {status}
          </p>
        )}
      </section>
      <section className="settings-section settings-section--danger">
        <h2>초기화</h2>
        <div className="setting-row">
          <span>
            <strong>모든 앱 데이터 초기화</strong>
            <small>
              음악 파일은 삭제하지 않지만 라이브러리, 좋아요, 플레이리스트와
              설정을 지웁니다.
            </small>
          </span>
          <button
            type="button"
            className="button button--danger"
            onClick={() => setDialog('reset')}
          >
            <RotateCcw />
            초기화
          </button>
        </div>
      </section>
      {dialog && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setDialog(null)}
        >
          <div
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="settings-dialog-title">
              {dialog === 'reset'
                ? '모든 데이터를 초기화할까요?'
                : '백업 데이터를 가져올까요?'}
            </h2>
            <p>
              {dialog === 'reset'
                ? '이 작업은 되돌릴 수 없습니다. 원본 음악 파일은 유지됩니다.'
                : '현재 라이브러리의 파일 경로는 유지하고 백업의 설정, 좋아요 및 플레이리스트를 적용합니다. 올바르지 않은 파일은 아무 변경 없이 거부됩니다.'}
            </p>
            <div>
              <button
                type="button"
                className="button"
                onClick={() => setDialog(null)}
              >
                취소
              </button>
              <button
                type="button"
                className={`button ${dialog === 'reset' ? 'button--danger' : 'button--primary'}`}
                onClick={() => {
                  if (dialog === 'reset')
                    void resetAll().then((next) =>
                      resetPlayer(next.settings.defaultVolume),
                    )
                  else
                    void importData().then((message) => {
                      setStatus(message)
                      const imported = useAppStore.getState().data
                      if (imported) {
                        resetPlayer(imported.settings.defaultVolume)
                        usePlayerStore.getState().hydrate(imported)
                      }
                    })
                  setDialog(null)
                }}
              >
                {dialog === 'reset' ? '초기화' : '파일 선택'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function extensionStatusLabel(status: YouTubeExtensionStatus) {
  const labels = {
    'not-configured': '선택되지 않음',
    loaded: '로드됨',
    disabled: '비활성화됨',
    missing: '경로 없음',
    'manifest-error': 'manifest 오류',
    'load-error': 'Electron 로드 실패',
  } as const
  return labels[status.loadState]
}

function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="setting-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        className="switch"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}
