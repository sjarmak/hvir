;(() => {
  window.answerAction.listen(window.hvirExtension)
  window.attachAction.listen(window.hvirExtension, window.attachAction.SEAT_ACTION)
  window.projectsData.startProjectsView((data, root, actions) => {
    window.projectsRender.renderNav(data.model, root, actions)
  }, { counts: false })
})()
