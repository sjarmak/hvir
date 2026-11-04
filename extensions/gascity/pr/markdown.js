/* global window, document */
/**
 * Pull request bodies and comments as rendered Markdown. markdown-it parses with raw HTML on,
 * since GitHub templates use <details>, <br> and HTML comments, and DOMPurify strips anything
 * active. A guest cannot navigate or load remote images, so links show their URL on hover and
 * images become their alt text.
 */
window.markdown = (() => {
  const parser = window.markdownit({ html: true, linkify: false, typographer: true })
  const SANITIZE = Object.freeze({
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
  })

  function imageText(image) {
    const alt = image.getAttribute('alt')
    const text = document.createElement('span')
    text.className = 'hvir-meta'
    text.textContent = `[image${alt ? `: ${alt}` : ''}]`
    text.title = image.getAttribute('src') ?? ''
    return text
  }

  function render(source) {
    const container = document.createElement('div')
    container.className = 'markdown'
    container.append(window.DOMPurify.sanitize(parser.render(source), SANITIZE))
    for (const link of container.querySelectorAll('a[href]')) link.title = link.href
    for (const image of container.querySelectorAll('img'))
      image.replaceWith(imageText(image))
    container.addEventListener('click', (event) => {
      if (event.target.closest('a')) event.preventDefault()
    })
    return container
  }

  return Object.freeze({ render })
})()
