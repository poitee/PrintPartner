(() => {
  const trace = window.gre510Evidence = [];
  const stamp = (kind, data = {}) => { const event = { kind, at: new Date().toISOString(), ms: Math.round(performance.now()), ...data }; trace.push(event); console.info('PR189-EVIDENCE', JSON.stringify(event)); }
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const path = new URL(url).pathname;
      if (!path.startsWith('/ws/jobs/')) return;
      stamp('socket-created', { path });
      this.addEventListener('open', () => stamp('socket-open', { path }));
      this.addEventListener('close', e => stamp('socket-close', { path, code: e.code, reason: e.reason }));
      this.addEventListener('message', e => {
        const { status, message, progress } = JSON.parse(e.data);
        stamp('job-event', { path, status, message, progress });
      });
    }
  };
  const nativeFetch = window.fetch;
  window.fetch = async (...args) => {
    const path = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.origin).pathname;
    if (!path.startsWith('/jobs/')) return nativeFetch(...args);
    try {
      const response = await nativeFetch(...args);
      stamp('http-response', { path, status: response.status });
      return response;
    } catch (error) {
      stamp('http-error', { path, name: error.name });
      throw error;
    }
  };
  // Save the real terminal UI immediately, before the existing toast expires.
  const observer = new MutationObserver(() => {
    if (document.body.innerText.includes('Check source updates: Done')) {
      window.gre510CompletedAt = new Date().toISOString();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  return 'Native recorder installed; no responses or events substituted';
})();
