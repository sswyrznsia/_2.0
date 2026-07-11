import { Check, FolderPlus, Music2 } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../../stores/appStore'

export function Onboarding() {
  const [step, setStep] = useState(0)
  const [discord, setDiscord] = useState(false)
  const [closeToTray, setCloseToTray] = useState(false)
  const data = useAppStore((state) => state.data)
  const isScanning = useAppStore((state) => state.isScanning)
  const addFolder = useAppStore((state) => state.addMusicFolder)
  const complete = useAppStore((state) => state.completeOnboarding)
  if (!data || data.onboardingCompleted) return null

  return (
    <div className="onboarding-backdrop">
      <section
        className="onboarding"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <div className="onboarding__mark">
          <Music2 aria-hidden="true" />
        </div>
        {step === 0 && (
          <>
            <h1 id="onboarding-title">Pulse Shelf에 오신 것을 환영합니다</h1>
            <p>
              내 컴퓨터의 음악을 안전하게 정리하고 재생하는 로컬 데스크톱
              플레이어입니다. 음악 파일은 외부 서버로 전송되지 않습니다.
            </p>
          </>
        )}
        {step === 1 && (
          <>
            <h1 id="onboarding-title">음악 폴더를 연결하세요</h1>
            <p>
              하위 폴더까지 검색하며 MP3, FLAC, WAV, M4A, OGG 메타데이터를
              읽습니다. 폴더는 나중에 설정에서 추가하거나 제거할 수 있습니다.
            </p>
            <button
              type="button"
              className="button button--primary onboarding__folder"
              disabled={isScanning}
              onClick={() => void addFolder()}
            >
              <FolderPlus />
              {isScanning
                ? '음악 검색 중…'
                : data.musicFolders.length
                  ? '다른 폴더 추가'
                  : '음악 폴더 추가'}
            </button>
            {data.musicFolders.length > 0 && (
              <span className="onboarding__success">
                <Check /> {data.musicFolders.length}개 폴더 연결됨
              </span>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <h1 id="onboarding-title">기본 동작을 선택하세요</h1>
            <p>필요할 때 설정에서 언제든 변경할 수 있습니다.</p>
            <label className="onboarding__option">
              <input
                type="checkbox"
                checked={discord}
                onChange={(event) => setDiscord(event.target.checked)}
              />
              <span>
                <strong>Discord Rich Presence</strong>
                <small>Client ID가 설정된 환경에서 현재 곡을 표시합니다.</small>
              </span>
            </label>
            <label className="onboarding__option">
              <input
                type="checkbox"
                checked={closeToTray}
                onChange={(event) => setCloseToTray(event.target.checked)}
              />
              <span>
                <strong>닫을 때 트레이로 최소화</strong>
                <small>창을 닫아도 음악 재생을 계속합니다.</small>
              </span>
            </label>
          </>
        )}
        <div className="onboarding__footer">
          <span>{step + 1} / 3</span>
          <div>
            {step > 0 && (
              <button
                type="button"
                className="button"
                onClick={() => setStep((value) => value - 1)}
              >
                이전
              </button>
            )}
            {step < 2 ? (
              <button
                type="button"
                className="button button--primary"
                onClick={() => setStep((value) => value + 1)}
              >
                다음
              </button>
            ) : (
              <button
                type="button"
                className="button button--primary"
                onClick={() =>
                  complete({
                    discordPresence: discord,
                    closeBehavior: closeToTray ? 'tray' : 'quit',
                  })
                }
              >
                시작하기
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
