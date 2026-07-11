import { BrowserWindow, screen, type Rectangle } from 'electron'
import {
  computeTaskbarToggleBounds,
  computeTaskbarRect,
} from './taskbarGeometry'

function assertSafeWindow(window: BrowserWindow) {
  if (
    window.isVisible() ||
    window.isResizable() ||
    window.isMinimizable() ||
    window.isMaximizable() ||
    window.isFullScreenable() ||
    !window.isAlwaysOnTop()
  )
    throw new Error('Taskbar BrowserWindow safety options were not applied')
}

async function inspectWindow(bounds: Rectangle, title: string) {
  const window = new BrowserWindow({
    ...bounds,
    title,
    frame: false,
    thickFrame: false,
    hasShadow: false,
    roundedCorners: false,
    transparent: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0B1020',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  try {
    await window.loadURL('about:blank')
    window.setBounds(bounds, false)
    if (process.platform !== 'darwin')
      window.setShape([
        { x: 0, y: 0, width: bounds.width, height: bounds.height },
      ])
    assertSafeWindow(window)
    const viewport = await window.webContents.executeJavaScript(
      `[window.innerWidth, window.innerHeight]`,
    )
    if (viewport[0] < bounds.width || viewport[1] < bounds.height)
      throw new Error(
        `Requested ${JSON.stringify(bounds)} but renderer reported ${JSON.stringify(viewport)}`,
      )
    return {
      requested: bounds,
      viewport,
      contentBounds: window.getContentBounds(),
      outerBounds: window.getBounds(),
    }
  } finally {
    window.destroy()
  }
}

export async function runTaskbarDisplayTest() {
  const rawExpectedScale = process.env.PULSE_SHELF_TASKBAR_EXPECTED_SCALE
  const expectedScale = rawExpectedScale ? Number(rawExpectedScale) : undefined
  const displays = screen.getAllDisplays()
  if (!displays.length) throw new Error('Electron did not report a display')
  const windowChecks = []
  for (const display of displays) {
    const workAreaIsConsistent =
      display.workArea.x >= display.bounds.x &&
      display.workArea.y >= display.bounds.y &&
      display.workArea.x + display.workArea.width <=
        display.bounds.x + display.bounds.width &&
      display.workArea.y + display.workArea.height <=
        display.bounds.y + display.bounds.height
    const geometry = workAreaIsConsistent
      ? display
      : {
          bounds: display.bounds,
          workArea: {
            ...display.bounds,
            height:
              display.bounds.height -
              Math.max(32, Math.round(48 / display.scaleFactor)),
          },
        }
    const taskbarRect = computeTaskbarRect(geometry)
    const mode = await inspectWindow(taskbarRect, 'Taskbar Mode Test')
    const modeTolerance = workAreaIsConsistent ? 0 : 2
    if (
      Math.abs(mode.outerBounds.x - taskbarRect.x) > modeTolerance ||
      Math.abs(mode.outerBounds.y - taskbarRect.y) > modeTolerance ||
      Math.abs(mode.outerBounds.width - taskbarRect.width) > modeTolerance ||
      Math.abs(mode.outerBounds.height - taskbarRect.height) > modeTolerance ||
      mode.viewport[0] < taskbarRect.width ||
      mode.viewport[1] < taskbarRect.height
    )
      throw new Error(
        `Display ${display.id} mode window missed taskbarRect: ${JSON.stringify({
          taskbarRect,
          outerBounds: mode.outerBounds,
          contentBounds: mode.contentBounds,
          viewport: mode.viewport,
          displayBounds: display.bounds,
          workArea: display.workArea,
          scaleFactor: display.scaleFactor,
        })}`,
      )
    const toggles = []
    for (const position of ['left', 'custom', 'right'] as const) {
      const bounds = computeTaskbarToggleBounds(
        geometry,
        { width: 36, height: 36 },
        position,
      )
      if (
        bounds.x < taskbarRect.x ||
        bounds.y < taskbarRect.y ||
        bounds.x + bounds.width > taskbarRect.x + taskbarRect.width ||
        bounds.y + bounds.height > taskbarRect.y + taskbarRect.height
      )
        throw new Error(`Display ${display.id} produced invalid toggle bounds`)
      toggles.push({ position, ...(await inspectWindow(bounds, 'Taskbar Toggle Test')) })
    }
    windowChecks.push({
      displayId: display.id,
      normalizedForcedScaleMetrics: !workAreaIsConsistent,
      taskbarRect,
      mode,
      toggles,
    })
  }
  const actualScale = screen.getPrimaryDisplay().scaleFactor
  if (
    expectedScale !== undefined &&
    Math.abs(actualScale - expectedScale) > 0.01
  )
    throw new Error(
      `Expected scale ${expectedScale}, Electron reported ${actualScale}`,
    )
  process.stdout.write(
    `PULSE_SHELF_TASKBAR_DISPLAY_OK=${JSON.stringify({
      expectedScale: expectedScale ?? 'native',
      actualScale,
      windowChecks,
    })}\n`,
  )
}
