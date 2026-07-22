process.env.PULSE_SHELF_TASKBAR_TEST = '1'
await new Promise((resolve) => setTimeout(resolve, 3_000))
await import('./run-ui-test.mjs')
