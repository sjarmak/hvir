;(() => {
  window.projectsData.startProjectsView((data, root, actions, context) => {
    const { id, store } = context.input ?? {}
    if (id === undefined) {
      document.title = 'Projects overview'
      window.projectsRender.renderDashboard(data.model, root, { ...actions, seatJobsUnavailable: true })
      return ''
    }
    const card = data.model.cards.flatMap((group) => group.cards)
      .find((entry) => entry.id === id && (store === undefined || entry.store === store))
    if (!card) {
      document.title = 'Project'
      root.replaceChildren(window.el('p', { className: 'hvir-meta' }, `Project ${id} not found`))
      return ''
    }
    document.title = card.title
    window.projectsRender.renderProject(card, root, { ...actions, outcomesShown: data.model.outcomesShown })
    return ''
  })
})()
