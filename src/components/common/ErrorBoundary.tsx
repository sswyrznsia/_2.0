import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    window.electronAPI.logRendererError(
      error.message,
      `${error.stack ?? ''}\n${info.componentStack ?? ''}`,
    )
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="fatal-error" role="alert">
        <h1>화면을 표시하지 못했습니다</h1>
        <p>
          오류가 로그에 기록되었습니다. 앱을 다시 불러오면 저장된 음악과 설정은
          유지됩니다.
        </p>
        <button
          type="button"
          className="button button--primary"
          onClick={() => window.location.reload()}
        >
          다시 불러오기
        </button>
      </main>
    )
  }
}
