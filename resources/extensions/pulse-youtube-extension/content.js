if (!document.documentElement.dataset.pulseShelfExtensionTest) {
  document.documentElement.dataset.pulseShelfExtensionTest = 'loaded'
  const badge = document.createElement('div')
  badge.textContent = 'Pulse Shelf extension test'
  badge.setAttribute('data-pulse-shelf-extension-test', 'true')
  Object.assign(badge.style, {
    position: 'fixed',
    right: '12px',
    bottom: '12px',
    zIndex: '2147483647',
    padding: '6px 9px',
    borderRadius: '6px',
    background: '#0b1020',
    color: '#ffffff',
    font: '12px sans-serif',
  })
  document.documentElement.append(badge)
}
