export function createRefreshController({
  refresh,
  publish,
  schedule = globalThis.setTimeout,
  cancel = globalThis.clearTimeout,
  intervalMs = 5000,
  maximumIntervalMs = 60000,
}) {
  let visible = false
  let disposed = false
  let timer
  let running = false
  let queued = false
  let revision = 0
  let backoff = 1
  let signature

  const clear = () => {
    if (timer !== undefined) cancel(timer)
    timer = undefined
  }
  const queue = (delay) => {
    clear()
    if (!visible || disposed) return
    timer = schedule(() => {
      timer = undefined
      void run()
    }, delay)
  }
  const run = async () => {
    if (!visible || disposed) return
    if (running) {
      queued = true
      return
    }
    running = true
    const current = revision
    try {
      const value = await refresh()
      if (!visible || disposed || current !== revision) return
      const nextSignature = JSON.stringify(value, (key, part) =>
        key === 'observedAt' ? undefined : part,
      )
      const changed = nextSignature !== signature
      signature = nextSignature
      publish(value)
      backoff = changed ? 1 : Math.min(backoff * 2, maximumIntervalMs / intervalMs)
    } catch {
      if (!visible || disposed || current !== revision) return
      backoff = Math.min(backoff * 2, maximumIntervalMs / intervalMs)
    } finally {
      running = false
      finish(current)
    }
  }
  const finish = (current) => {
    if (!visible || disposed) return
    if (current !== revision) {
      if (queued) {
        queued = false
        void run()
      }
      return
    }
    if (queued) {
      queued = false
      void run()
    } else {
      queue(Math.max(intervalMs, intervalMs * backoff))
    }
  }
  return {
    setVisible(next) {
      if (disposed || visible === next) return
      visible = next
      revision += 1
      clear()
      queued = false
      if (visible) {
        backoff = 1
        void run()
      }
    },
    request() {
      if (!visible || disposed) return
      clear()
      backoff = 1
      void run()
    },
    dispose() {
      if (disposed) return
      disposed = true
      visible = false
      revision += 1
      clear()
    },
  }
}
