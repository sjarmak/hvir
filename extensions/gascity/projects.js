;(() => {
  window.answerAction.listen(window.hvirExtension)
  window.projectsData.startProjectsView((data, root, actions) => {
    window.projectsRender.renderNav(data.model, root, actions)
  }, { counts: false })
})()
