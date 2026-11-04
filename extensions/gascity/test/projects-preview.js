;(() => {
  const fixture = window.projectsFixture
  Date.now = () => Date.parse(fixture.now)
  document.getElementById('preview-time').textContent = fixture.now
  const show = (message) => {
    document.getElementById('preview-action').textContent = message
  }
  window.projectsRender.renderDashboard(
    window.projectsModel.buildDashboard(fixture),
    document.getElementById('projects'),
    {
      onOpenBead: (id) => show(`Bead target: ${id}`),
      onOpenRef: (ref) => show(`${ref.kind === 'pr' ? 'PR' : 'Issue'} target: ${ref.key}`),
    },
  )
  const theme = document.getElementById('theme')
  theme.addEventListener('click', () => {
    const light = document.documentElement.dataset.theme !== 'light'
    document.documentElement.dataset.theme = light ? 'light' : 'dark'
    theme.textContent = light ? 'Switch to dark theme' : 'Switch to light theme'
  })
})()
