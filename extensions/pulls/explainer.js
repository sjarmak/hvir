/* global window, document, module */
;(() => {
  const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/files\/\d+\/[A-Za-z0-9._-]+\.html(?![A-Za-z0-9._/-])/g
  const SANITIZE = Object.freeze({
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['script', 'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base'],
  })
  const DOCUMENT_SELECTOR = /(^|[\s,{}>+~])(:root|html|body)(?=[\s,{.:#[>+~])/g

  function explainerUrl(body) {
    const links = [...new Set((body ?? '').match(ATTACHMENT) ?? [])]
    return links.find((url) => url.split('/').at(-1).toLowerCase().includes('explainer')) ?? links[0]
  }

  const scopeCss = (css) =>
    css.replace(DOCUMENT_SELECTOR, (_match, lead, selector) => `${lead}${selector === 'body' ? '.explainer-body' : ':host'}`)

  function stillFor(video) {
    const owner = video.ownerDocument
    const poster = video.getAttribute('poster') ?? ''
    const figure = owner.createElement('figure')
    figure.className = 'explainer-video'
    if (poster.startsWith('data:image/')) figure.append(Object.assign(owner.createElement('img'), { src: poster, alt: '' }))
    const caption = owner.createElement('figcaption')
    caption.textContent = 'The video plays when the explainer is opened in a browser.'
    figure.append(caption)
    return figure
  }

  function mount(host, html) {
    const parsed = new window.DOMParser().parseFromString(html, 'text/html')
    const styles = [...parsed.querySelectorAll('style')].map((style) => scopeCss(style.textContent ?? ''))
    const body = document.createElement('div')
    body.className = 'explainer-body'
    for (const video of parsed.querySelectorAll('video')) video.replaceWith(stillFor(video))
    body.append(window.DOMPurify.sanitize(parsed.body.innerHTML, SANITIZE))
    for (const link of body.querySelectorAll('a[href]')) link.title = link.getAttribute('href')
    body.addEventListener('click', (event) => {
      if (event.target.closest('a')) event.preventDefault()
    })
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    root.replaceChildren(
      ...styles.map((css) => Object.assign(document.createElement('style'), { textContent: css })),
      Object.assign(document.createElement('style'), {
        textContent: ':host { display: block; border-radius: 6px; overflow: hidden; } .explainer-body { max-width: none; margin: 0; padding: 12px 14px; } .explainer-video img { width: 100%; border-radius: 6px; }',
      }),
      body,
    )
  }

  const api = Object.freeze({ explainerUrl, scopeCss, mount })
  if (typeof module === 'object') module.exports = api
  else window.explainer = api
})()
