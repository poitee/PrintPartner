(() => {
 const originalFetch = window.fetch.bind(window);
 const NativeWebSocket = window.WebSocket;
 window.gre510Evidence = {started: new Date().toISOString(), sockets: [], polls: []};
 window.WebSocket = class extends NativeWebSocket {
   constructor(...args) {
     super(...args);
     if (String(args[0]).includes('/ws/jobs/')) {
       const entry = {url: String(args[0]), created: new Date().toISOString()};
       window.gre510Evidence.sockets.push(entry);
       this.addEventListener('open', () => entry.open = new Date().toISOString());
       this.addEventListener('close', event => Object.assign(entry, {code: event.code, reason: event.reason, closed: new Date().toISOString()}));
     }
   }
 };
 window.fetch = (input, init) => {
   const url = String(input);
   if (url.endsWith('/jobs/check-source-updates') && init?.method === 'POST') {
     window.gre510Evidence.startInjection = 'Only the start response is replaced with an unknown id; the WebSocket reaches the real local server.';
     return Promise.resolve(new Response(JSON.stringify({job_id:'gre510-missing-evidence'}), {status:200, headers:{'Content-Type':'application/json'}}));
   }
   if (url.endsWith('/jobs/gre510-missing-evidence')) {
     const entry = {url, at: new Date().toISOString()};
     window.gre510Evidence.polls.push(entry);
     return new Promise((resolve,reject) => {
       init?.signal?.addEventListener('abort', () => {entry.aborted = new Date().toISOString(); reject(new DOMException('Aborted','AbortError'));}, {once:true});
     });
   }
   return originalFetch(input, init);
 };
 return 'Evidence recorder installed';
})()
